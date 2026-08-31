/**
 * Clustering & Multi-Core Process Service
 *
 * Implements primary-worker cluster process management for ZK-VOTE:
 * - Master process forks and manages worker processes
 * - Primary/Leader election for background services (indexer, sync, monitoring)
 * - Distributed sequence lock serialization over IPC for Stellar nonces
 * - Shared rate limiting state store over IPC across all workers
 * - In-memory cache invalidation broadcast over IPC
 * - Health monitoring, worker auto-restart, and coordinated graceful shutdown
 */
import cluster from "node:cluster";
import os from "node:os";
import { config } from "../config.js";
import { log } from "./logger.js";
// ============================================
// WORKER STATE & LISTENERS
// ============================================
let _isLeader = false;
let _leaderPid;
const leaderChangeCallbacks = [];
const cacheInvalidateCallbacks = [];
let workerShutdownHandler = null;
const pendingIpcRequests = new Map();
/**
 * Check whether current process is the elected leader/primary worker
 */
export function isLeaderWorker() {
    if (!config.clusterEnabled)
        return true; // In single-process mode, process is always leader
    return _isLeader;
}
/**
 * Register a listener for leader status changes
 */
export function onLeaderChange(cb) {
    leaderChangeCallbacks.push(cb);
}
/**
 * Register a listener for cache invalidation events
 */
export function onCacheInvalidate(cb) {
    cacheInvalidateCallbacks.push(cb);
}
/**
 * Register worker graceful shutdown trigger
 */
export function registerWorkerShutdownHandler(handler) {
    workerShutdownHandler = handler;
}
// ============================================
// WORKER IPC MESSAGING HELPERS
// ============================================
function sendIpcRequest(msg, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        if (!process.send) {
            return reject(new Error("IPC process.send unavailable"));
        }
        const requestId = msg.requestId ||
            `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const fullMsg = { ...msg, requestId };
        const timer = setTimeout(() => {
            pendingIpcRequests.delete(requestId);
            reject(new Error(`IPC request timeout (${msg.type})`));
        }, timeoutMs);
        pendingIpcRequests.set(requestId, { resolve, reject, timer });
        process.send(fullMsg);
    });
}
/**
 * Initialize IPC listener in worker process
 */
export function initWorkerIpc() {
    if (!cluster.isWorker || !process.on)
        return;
    process.on("message", (msg) => {
        if (!msg || typeof msg !== "object" || !msg.type)
            return;
        // Handle responses to pending requests
        if (msg.requestId && pendingIpcRequests.has(msg.requestId)) {
            const pending = pendingIpcRequests.get(msg.requestId);
            clearTimeout(pending.timer);
            pendingIpcRequests.delete(msg.requestId);
            pending.resolve(msg);
            return;
        }
        switch (msg.type) {
            case "LEADER_ASSIGNMENT": {
                const previous = _isLeader;
                _isLeader = !!msg.isLeader;
                _leaderPid = msg.leaderPid;
                log("info", "cluster_worker_leader_status", {
                    pid: process.pid,
                    isLeader: _isLeader,
                    leaderPid: _leaderPid,
                });
                if (previous !== _isLeader) {
                    for (const cb of leaderChangeCallbacks) {
                        try {
                            cb(_isLeader);
                        }
                        catch (err) {
                            log("error", "cluster_leader_callback_error", {
                                error: err.message,
                            });
                        }
                    }
                }
                break;
            }
            case "CACHE_INVALIDATE": {
                if (msg.channel && msg.key) {
                    for (const cb of cacheInvalidateCallbacks) {
                        try {
                            cb(msg.channel, msg.key, msg.data);
                        }
                        catch (err) {
                            log("error", "cluster_cache_invalidate_error", {
                                error: err.message,
                            });
                        }
                    }
                }
                break;
            }
            case "WORKER_HEALTH_PING": {
                if (process.send) {
                    process.send({
                        type: "WORKER_HEALTH_PONG",
                        pid: process.pid,
                        memory: process.memoryUsage(),
                        isLeader: _isLeader,
                        uptime: process.uptime(),
                    });
                }
                break;
            }
            case "GRACEFUL_SHUTDOWN": {
                log("info", "cluster_worker_shutdown_received", {
                    pid: process.pid,
                    reason: msg.reason,
                });
                if (workerShutdownHandler) {
                    workerShutdownHandler(msg.reason || "cluster_master_shutdown");
                }
                break;
            }
        }
    });
}
// ============================================
// SEQUENCE LOCK (IPC DISTRIBUTED MUTEX)
// ============================================
export async function acquireClusterSequenceLock(timeoutMs = 15000) {
    if (!config.clusterEnabled || !cluster.isWorker)
        return;
    await sendIpcRequest({ type: "SEQUENCE_LOCK_ACQUIRE" }, timeoutMs);
}
export async function releaseClusterSequenceLock() {
    if (!config.clusterEnabled || !cluster.isWorker)
        return;
    if (process.send) {
        process.send({ type: "SEQUENCE_LOCK_RELEASE" });
    }
}
// ============================================
// SHARED RATE LIMIT STORE (IPC BACKED)
// ============================================
export class ClusterRateLimitStore {
    limiterName;
    options;
    constructor(limiterName) {
        this.limiterName = limiterName;
    }
    init(options) {
        this.options = options;
    }
    async increment(key) {
        if (!cluster.isWorker || !config.clusterEnabled) {
            const windowMs = this.options?.windowMs || 60000;
            return { totalHits: 1, resetTime: new Date(Date.now() + windowMs) };
        }
        try {
            const windowMs = this.options?.windowMs || 60000;
            const res = await sendIpcRequest({
                type: "RATE_LIMIT_INCREMENT",
                limiterName: this.limiterName,
                key,
                windowMs,
            });
            return {
                totalHits: res.totalHits || 1,
                resetTime: res.resetTimeMs
                    ? new Date(res.resetTimeMs)
                    : new Date(Date.now() + windowMs),
            };
        }
        catch (err) {
            log("warn", "cluster_rate_limit_ipc_fallback", {
                error: err.message,
            });
            const windowMs = this.options?.windowMs || 60000;
            return { totalHits: 1, resetTime: new Date(Date.now() + windowMs) };
        }
    }
    async decrement(key) {
        if (cluster.isWorker && config.clusterEnabled && process.send) {
            process.send({
                type: "RATE_LIMIT_DECREMENT",
                limiterName: this.limiterName,
                key,
            });
        }
    }
    async resetKey(key) {
        if (cluster.isWorker && config.clusterEnabled && process.send) {
            process.send({
                type: "RATE_LIMIT_RESET",
                limiterName: this.limiterName,
                key,
            });
        }
    }
}
// ============================================
// IN-MEMORY CACHE INVALIDATION BROADCAST
// ============================================
export function broadcastCacheInvalidation(channel, key, data) {
    if (cluster.isWorker && config.clusterEnabled && process.send) {
        process.send({
            type: "CACHE_INVALIDATE",
            channel,
            key,
            data,
        });
    }
}
export function startClusterMaster() {
    if (!cluster.isPrimary)
        return;
    const numWorkers = config.clusterWorkers;
    log("info", "cluster_master_starting", {
        masterPid: process.pid,
        workerCount: numWorkers,
        cpus: os.cpus().length,
    });
    const activeWorkers = new Map();
    let leaderWorkerId = null;
    // Sequence Lock State
    const sequenceLockQueue = [];
    let currentLockHolder = null;
    // Rate Limit State
    const rateLimitStores = new Map();
    // Elect leader worker process
    const updateLeader = () => {
        const workerList = Array.from(activeWorkers.values());
        if (workerList.length === 0) {
            leaderWorkerId = null;
            return;
        }
        const currentLeaderActive = leaderWorkerId !== null && activeWorkers.has(leaderWorkerId);
        if (!currentLeaderActive) {
            const newLeader = workerList[0];
            leaderWorkerId = newLeader.id;
            log("info", "cluster_primary_worker_elected", {
                workerId: newLeader.id,
                pid: newLeader.process.pid,
            });
        }
        const leaderWorker = activeWorkers.get(leaderWorkerId);
        for (const w of activeWorkers.values()) {
            if (w.process.connected) {
                w.send({
                    type: "LEADER_ASSIGNMENT",
                    isLeader: w.id === leaderWorkerId,
                    leaderPid: leaderWorker.process.pid,
                });
            }
        }
    };
    const processNextLockRequest = () => {
        if (currentLockHolder)
            return;
        if (sequenceLockQueue.length === 0)
            return;
        const next = sequenceLockQueue.shift();
        if (!next.worker.process.connected) {
            processNextLockRequest();
            return;
        }
        currentLockHolder = next;
        next.worker.send({
            type: "SEQUENCE_LOCK_GRANTED",
            requestId: next.requestId,
        });
    };
    const handleWorkerMessage = (worker, msg) => {
        if (!msg || typeof msg !== "object" || !msg.type)
            return;
        switch (msg.type) {
            case "SEQUENCE_LOCK_ACQUIRE": {
                if (!msg.requestId)
                    return;
                if (!currentLockHolder) {
                    currentLockHolder = { worker, requestId: msg.requestId };
                    worker.send({
                        type: "SEQUENCE_LOCK_GRANTED",
                        requestId: msg.requestId,
                    });
                }
                else {
                    sequenceLockQueue.push({ worker, requestId: msg.requestId });
                }
                break;
            }
            case "SEQUENCE_LOCK_RELEASE": {
                if (currentLockHolder && currentLockHolder.worker.id === worker.id) {
                    currentLockHolder = null;
                    processNextLockRequest();
                }
                break;
            }
            case "RATE_LIMIT_INCREMENT": {
                if (!msg.requestId || !msg.limiterName || !msg.key)
                    return;
                const limiterName = msg.limiterName;
                const key = msg.key;
                const windowMs = msg.windowMs || 60000;
                let store = rateLimitStores.get(limiterName);
                if (!store) {
                    store = new Map();
                    rateLimitStores.set(limiterName, store);
                }
                let entry = store.get(key);
                const now = Date.now();
                if (!entry || entry.resetTimeMs <= now) {
                    if (entry?.timer)
                        clearTimeout(entry.timer);
                    const resetTimeMs = now + windowMs;
                    const timer = setTimeout(() => {
                        store?.delete(key);
                    }, windowMs);
                    timer.unref();
                    entry = { totalHits: 1, resetTimeMs, timer };
                    store.set(key, entry);
                }
                else {
                    entry.totalHits++;
                }
                worker.send({
                    type: "RATE_LIMIT_RESPONSE",
                    requestId: msg.requestId,
                    totalHits: entry.totalHits,
                    resetTimeMs: entry.resetTimeMs,
                });
                break;
            }
            case "RATE_LIMIT_DECREMENT": {
                if (msg.limiterName && msg.key) {
                    const store = rateLimitStores.get(msg.limiterName);
                    const entry = store?.get(msg.key);
                    if (entry && entry.totalHits > 0) {
                        entry.totalHits--;
                    }
                }
                break;
            }
            case "RATE_LIMIT_RESET": {
                if (msg.limiterName && msg.key) {
                    const store = rateLimitStores.get(msg.limiterName);
                    const entry = store?.get(msg.key);
                    if (entry) {
                        clearTimeout(entry.timer);
                        store?.delete(msg.key);
                    }
                }
                break;
            }
            case "CACHE_INVALIDATE": {
                // Forward cache invalidation to all other worker processes
                for (const w of activeWorkers.values()) {
                    if (w.id !== worker.id && w.process.connected) {
                        w.send(msg);
                    }
                }
                break;
            }
            case "WORKER_HEALTH_PONG": {
                // Heartbeat response recorded
                break;
            }
        }
    };
    // Fork worker processes
    for (let i = 0; i < numWorkers; i++) {
        const worker = cluster.fork();
        activeWorkers.set(worker.id, worker);
        worker.on("message", (msg) => handleWorkerMessage(worker, msg));
    }
    updateLeader();
    // Handle worker exit & auto-restart
    cluster.on("exit", (worker, code, signal) => {
        log("warn", "cluster_worker_exited", {
            workerId: worker.id,
            pid: worker.process.pid,
            code,
            signal,
        });
        activeWorkers.delete(worker.id);
        // Clean up sequence lock if held or queued by exited worker
        if (currentLockHolder && currentLockHolder.worker.id === worker.id) {
            currentLockHolder = null;
            processNextLockRequest();
        }
        const filteredQueue = sequenceLockQueue.filter((item) => item.worker.id !== worker.id);
        sequenceLockQueue.length = 0;
        sequenceLockQueue.push(...filteredQueue);
        // Re-elect leader if exited worker was primary leader
        updateLeader();
        // Respawn replacement worker if not shutting down
        if (!masterShuttingDown) {
            log("info", "cluster_respawning_worker", { oldWorkerId: worker.id });
            const newWorker = cluster.fork();
            activeWorkers.set(newWorker.id, newWorker);
            newWorker.on("message", (msg) => handleWorkerMessage(newWorker, msg));
            updateLeader();
        }
    });
    // Periodic health check ping
    const healthPingInterval = setInterval(() => {
        for (const w of activeWorkers.values()) {
            if (w.process.connected) {
                w.send({ type: "WORKER_HEALTH_PING" });
            }
        }
    }, 15000);
    healthPingInterval.unref();
    // Coordinated Graceful Shutdown for Cluster Master
    let masterShuttingDown = false;
    const DRAIN_TIMEOUT_MS = 25000;
    const handleMasterShutdown = (signal) => {
        if (masterShuttingDown)
            return;
        masterShuttingDown = true;
        log("info", "cluster_master_shutdown_start", {
            signal,
            workers: activeWorkers.size,
        });
        // Notify all worker processes to shut down gracefully
        for (const w of activeWorkers.values()) {
            if (w.process.connected) {
                w.send({ type: "GRACEFUL_SHUTDOWN", reason: signal });
            }
        }
        const forceKillTimer = setTimeout(() => {
            log("warn", "cluster_master_force_killing_workers", {
                timeoutMs: DRAIN_TIMEOUT_MS,
            });
            for (const w of activeWorkers.values()) {
                w.kill("SIGKILL");
            }
            process.exit(1);
        }, DRAIN_TIMEOUT_MS);
        forceKillTimer.unref();
        const checkWorkersExit = () => {
            if (activeWorkers.size === 0) {
                log("info", "cluster_master_shutdown_complete");
                clearTimeout(forceKillTimer);
                process.exit(0);
            }
        };
        cluster.on("exit", () => {
            checkWorkersExit();
        });
        checkWorkersExit();
    };
    process.on("SIGTERM", () => handleMasterShutdown("SIGTERM"));
    process.on("SIGINT", () => handleMasterShutdown("SIGINT"));
}
//# sourceMappingURL=cluster.js.map