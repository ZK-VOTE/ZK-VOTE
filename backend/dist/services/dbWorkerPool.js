/**
 * Database Worker Thread Pool
 *
 * Implements a read/write separated worker pool:
 * - 1 Dedicated Writer Worker for SQLite write operations (WAL mode single writer)
 * - N Reader Workers for parallel read queries (round-robin dispatching)
 *
 * Provides message-passing interface, worker crash recovery, auto-restart,
 * and pool performance metrics.
 */
import { Worker } from "worker_threads";
import os from "os";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_SCRIPT = `
const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');

let db = null;

try {
  db = new Database(workerData.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  if (!workerData.isWriter) {
    db.pragma('query_only = ON');
  }
} catch (err) {
  console.error('Worker DB connection error:', err);
}

if (parentPort) {
  parentPort.on('message', (msg) => {
    const startTime = Date.now();
    if (!db) {
      parentPort.postMessage({
        id: msg.id,
        success: false,
        error: 'Worker DB not initialized',
        durationMs: Date.now() - startTime
      });
      return;
    }

    try {
      let result = null;
      const params = msg.params || [];
      if (msg.type === 'query') {
        result = db.prepare(msg.sql).all(...params);
      } else if (msg.type === 'queryOne') {
        result = db.prepare(msg.sql).get(...params);
      } else if (msg.type === 'execute') {
        const stmt = db.prepare(msg.sql).run(...params);
        result = { changes: stmt.changes, lastInsertRowid: Number(stmt.lastInsertRowid) };
      } else if (msg.type === 'exec') {
        db.exec(msg.sql);
        result = { success: true };
      } else {
        throw new Error('Unknown query type: ' + msg.type);
      }

      parentPort.postMessage({
        id: msg.id,
        success: true,
        result,
        durationMs: Date.now() - startTime
      });
    } catch (err) {
      parentPort.postMessage({
        id: msg.id,
        success: false,
        error: err.message,
        durationMs: Date.now() - startTime
      });
    }
  });
}
`;
export class DbWorkerPool {
    dbPath;
    writerWorker = null;
    readerWorkers = [];
    currentReaderIndex = 0;
    pendingRequests = new Map();
    requestCounter = 0;
    // Metrics
    totalQueriesHandled = 0;
    totalProcessingTimeMs = 0;
    crashesCount = 0;
    restartsCount = 0;
    initialized = false;
    constructor(dbPath) {
        const defaultDb = path.join(__dirname, "..", "..", "data", "zkvote.db");
        this.dbPath = dbPath || defaultDb;
    }
    /**
     * Initialize worker pool (1 Writer + N Readers)
     */
    async init(options = {}) {
        if (this.initialized)
            return;
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        // Determine reader count based on CPU cores (min 2 readers)
        const numReaders = options.numReaders || Math.max(2, os.cpus().length - 1);
        // Spawn Writer Worker
        this.writerWorker = this.spawnWorker(true, 0);
        // Spawn Reader Workers
        for (let i = 0; i < numReaders; i++) {
            const reader = this.spawnWorker(false, i + 1);
            this.readerWorkers.push(reader);
        }
        this.initialized = true;
        log("info", "db_worker_pool_initialized", {
            dbPath: this.dbPath,
            numReaders: this.readerWorkers.length,
            writerActive: !!this.writerWorker,
        });
    }
    /**
     * Spawn a new worker thread
     */
    spawnWorker(isWriter, id) {
        const worker = new Worker(WORKER_SCRIPT, {
            eval: true,
            workerData: {
                dbPath: this.dbPath,
                isWriter,
                id,
            },
        });
        worker.on("message", (msg) => {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
                this.pendingRequests.delete(msg.id);
                this.totalQueriesHandled++;
                this.totalProcessingTimeMs += msg.durationMs || 0;
                if (msg.success) {
                    pending.resolve(msg.result);
                }
                else {
                    pending.reject(new Error(msg.error || "Worker query execution failed"));
                }
            }
        });
        worker.on("error", (err) => {
            log("error", "db_worker_error", { isWriter, id, error: err.message });
            this.handleCrash(worker, isWriter, id);
        });
        worker.on("exit", (code) => {
            if (code !== 0 && this.initialized) {
                log("warn", "db_worker_unexpected_exit", { isWriter, id, code });
                this.handleCrash(worker, isWriter, id);
            }
        });
        return worker;
    }
    /**
     * Handle worker crash with automatic restart
     */
    handleCrash(crashedWorker, isWriter, id) {
        this.crashesCount++;
        this.restartsCount++;
        try {
            crashedWorker.terminate();
        }
        catch (_) {
            // worker already dead; nothing to recover
        }
        // Reject and remove any requests that were in flight on the crashed
        // worker — otherwise their promises (and the map entries holding them)
        // never resolve and leak for the lifetime of the process (see #191).
        for (const [reqId, pending] of this.pendingRequests) {
            if (pending.worker === crashedWorker) {
                this.pendingRequests.delete(reqId);
                pending.reject(new Error("Worker crashed before completing request"));
            }
        }
        if (isWriter) {
            log("warn", "restarting_db_writer_worker");
            this.writerWorker = this.spawnWorker(true, 0);
        }
        else {
            const idx = this.readerWorkers.indexOf(crashedWorker);
            if (idx !== -1) {
                log("warn", "restarting_db_reader_worker", { readerId: id });
                this.readerWorkers[idx] = this.spawnWorker(false, id);
            }
        }
    }
    /**
     * Execute write query on writer worker
     */
    async executeWrite(sql, params = []) {
        if (!this.initialized || !this.writerWorker) {
            await this.init();
        }
        return this.dispatch(this.writerWorker, "execute", sql, params);
    }
    /**
     * Execute raw SQL string on writer worker (DDL / transactions)
     */
    async execWrite(sql) {
        if (!this.initialized || !this.writerWorker) {
            await this.init();
        }
        return this.dispatch(this.writerWorker, "exec", sql, []);
    }
    /**
     * Execute read query on reader worker pool (round-robin)
     */
    async queryRead(sql, params = []) {
        if (!this.initialized || this.readerWorkers.length === 0) {
            await this.init();
        }
        const worker = this.getNextReader();
        return this.dispatch(worker, "query", sql, params);
    }
    /**
     * Execute single-row read query on reader worker pool
     */
    async queryReadOne(sql, params = []) {
        if (!this.initialized || this.readerWorkers.length === 0) {
            await this.init();
        }
        const worker = this.getNextReader();
        return this.dispatch(worker, "queryOne", sql, params);
    }
    /**
     * Dispatch message to target worker thread
     */
    dispatch(worker, type, sql, params) {
        return new Promise((resolve, reject) => {
            const reqId = `req_${++this.requestCounter}_${Date.now()}`;
            this.pendingRequests.set(reqId, {
                resolve,
                reject,
                startTime: Date.now(),
                worker,
            });
            worker.postMessage({
                id: reqId,
                type,
                sql,
                params,
            });
        });
    }
    /**
     * Round-robin selection of reader worker
     */
    getNextReader() {
        if (this.readerWorkers.length === 0) {
            return this.writerWorker;
        }
        const worker = this.readerWorkers[this.currentReaderIndex];
        this.currentReaderIndex =
            (this.currentReaderIndex + 1) % this.readerWorkers.length;
        return worker;
    }
    /**
     * Return current worker pool performance metrics
     */
    getMetrics() {
        const avgProcessingTimeMs = this.totalQueriesHandled > 0
            ? Math.round((this.totalProcessingTimeMs / this.totalQueriesHandled) * 100) / 100
            : 0;
        return {
            writerActive: !!this.writerWorker,
            activeReadersCount: this.readerWorkers.length,
            queueDepth: this.pendingRequests.size,
            totalQueriesHandled: this.totalQueriesHandled,
            totalProcessingTimeMs: this.totalProcessingTimeMs,
            avgProcessingTimeMs,
            crashesCount: this.crashesCount,
            restartsCount: this.restartsCount,
        };
    }
    /**
     * Close worker pool
     */
    async close() {
        this.initialized = false;
        if (this.writerWorker) {
            await this.writerWorker.terminate();
            this.writerWorker = null;
        }
        for (const reader of this.readerWorkers) {
            await reader.terminate();
        }
        this.readerWorkers = [];
        this.pendingRequests.clear();
        log("info", "db_worker_pool_closed");
    }
}
// Global instance for application-wide worker pool operations
let globalWorkerPool = null;
export function getDbWorkerPool(dbPath) {
    if (!globalWorkerPool) {
        globalWorkerPool = new DbWorkerPool(dbPath);
    }
    return globalWorkerPool;
}
//# sourceMappingURL=dbWorkerPool.js.map