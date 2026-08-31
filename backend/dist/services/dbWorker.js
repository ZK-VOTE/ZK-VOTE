/**
 * Database Worker Thread Execution Handler
 *
 * Runs SQLite queries in isolated worker threads using better-sqlite3.
 * Listens for query messages from the main thread and responds with execution results.
 */
import { parentPort, workerData } from "worker_threads";
import Database from "better-sqlite3";
let dbInstance = null;
/**
 * Initialize worker thread database connection
 */
function initWorkerDb() {
    const data = workerData;
    if (!data || !data.dbPath) {
        return;
    }
    try {
        dbInstance = new Database(data.dbPath);
        dbInstance.pragma("journal_mode = WAL");
        dbInstance.pragma("foreign_keys = ON");
        if (!data.isWriter) {
            dbInstance.pragma("query_only = ON");
        }
    }
    catch (err) {
        console.error(`Worker ${data?.workerId} DB init failed:`, err);
    }
}
initWorkerDb();
if (parentPort) {
    parentPort.on("message", (msg) => {
        const startTime = Date.now();
        if (!dbInstance) {
            parentPort?.postMessage({
                id: msg.id,
                success: false,
                error: "Worker database instance is not initialized",
                durationMs: Date.now() - startTime,
            });
            return;
        }
        try {
            let result = null;
            const params = msg.params || [];
            if (msg.type === "query") {
                result = dbInstance.prepare(msg.sql).all(...params);
            }
            else if (msg.type === "queryOne") {
                result = dbInstance.prepare(msg.sql).get(...params);
            }
            else if (msg.type === "execute") {
                const stmtResult = dbInstance.prepare(msg.sql).run(...params);
                result = {
                    changes: stmtResult.changes,
                    lastInsertRowid: stmtResult.lastInsertRowid,
                };
            }
            else if (msg.type === "exec") {
                dbInstance.exec(msg.sql);
                result = { success: true };
            }
            else {
                throw new Error(`Unknown worker message type: ${msg.type}`);
            }
            const durationMs = Date.now() - startTime;
            parentPort?.postMessage({
                id: msg.id,
                success: true,
                result,
                durationMs,
            });
        }
        catch (err) {
            const durationMs = Date.now() - startTime;
            parentPort?.postMessage({
                id: msg.id,
                success: false,
                error: err.message,
                durationMs,
            });
        }
    });
}
//# sourceMappingURL=dbWorker.js.map