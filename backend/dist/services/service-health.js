/**
 * Service Health & Graceful Degradation Registry (#204)
 *
 * Tracks per-component health by criticality tier and provides:
 *  - Last-known-good (LKG) response cache for important/non-critical reads
 *  - Durable write queue for non-critical operations (e.g. IPFS pins)
 *  - Overall degradation summary for /health and response headers
 *
 * Principle: the system stays available with reduced functionality.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const QUEUE_FILE = path.join(DATA_DIR, "degraded-write-queue.json");
const SERVICE_META = {
    soroban_rpc: {
        tier: "critical",
        description: "Soroban RPC for voting and proposal queries",
    },
    sqlite: {
        tier: "important",
        description: "Local event/DAO storage",
    },
    ipfs: {
        tier: "non_critical",
        description: "IPFS/Pinata metadata and images",
    },
    comments: {
        tier: "non_critical",
        description: "On-chain comment reads/writes",
    },
    indexer: {
        tier: "background",
        description: "Event indexer polling",
    },
    dao_sync: {
        tier: "background",
        description: "DAO cache sync from contract",
    },
    ttl_renewal: {
        tier: "background",
        description: "Contract TTL renewal",
    },
    sbt_transfer_watch: {
        tier: "background",
        description: "Membership SBT transfer-attempt monitor",
    },
};
const health = new Map();
function initEntry(name) {
    const meta = SERVICE_META[name];
    return {
        name,
        tier: meta.tier,
        state: "healthy",
        lastError: null,
        updatedAt: new Date().toISOString(),
        description: meta.description,
    };
}
for (const name of Object.keys(SERVICE_META)) {
    health.set(name, initEntry(name));
}
/** Reset all services to healthy (tests). */
export function resetServiceHealth() {
    for (const name of Object.keys(SERVICE_META)) {
        health.set(name, initEntry(name));
    }
    lkg.clear();
}
export function markHealthy(name) {
    const prev = health.get(name) ?? initEntry(name);
    if (prev.state !== "healthy") {
        log("info", "service_recovered", { service: name, previous: prev.state });
    }
    health.set(name, {
        ...prev,
        state: "healthy",
        lastError: null,
        updatedAt: new Date().toISOString(),
    });
}
export function markDegraded(name, error) {
    const prev = health.get(name) ?? initEntry(name);
    health.set(name, {
        ...prev,
        state: "degraded",
        lastError: error ?? prev.lastError,
        updatedAt: new Date().toISOString(),
    });
    log("warn", "service_degraded", { service: name, error: error ?? null });
}
export function markUnavailable(name, error) {
    const prev = health.get(name) ?? initEntry(name);
    health.set(name, {
        ...prev,
        state: "unavailable",
        lastError: error ?? prev.lastError,
        updatedAt: new Date().toISOString(),
    });
    log("error", "service_unavailable", { service: name, error: error ?? null });
}
export function getServiceHealth(name) {
    if (name)
        return health.get(name) ?? initEntry(name);
    return Array.from(health.values());
}
export function getOverallHealth() {
    const services = Array.from(health.values());
    const degraded = services
        .filter((s) => s.state === "degraded")
        .map((s) => s.name);
    const unavailable = services
        .filter((s) => s.state === "unavailable")
        .map((s) => s.name);
    const status = degraded.length > 0 || unavailable.length > 0 ? "degraded" : "ok";
    return { status, degraded, unavailable, services };
}
export function getDegradedServiceNames() {
    const overall = getOverallHealth();
    return [...overall.degraded, ...overall.unavailable];
}
const lkg = new Map();
const DEFAULT_LKG_TTL_MS = 30 * 60 * 1000; // 30 minutes
export function setLkg(key, value, ttlMs = DEFAULT_LKG_TTL_MS) {
    lkg.set(key, { value, storedAt: Date.now(), ttlMs });
}
export function getLkg(key) {
    const entry = lkg.get(key);
    if (!entry)
        return null;
    if (Date.now() - entry.storedAt > entry.ttlMs) {
        lkg.delete(key);
        return null;
    }
    return entry.value;
}
export function commentsLkgKey(daoId, proposalId) {
    return `comments:${daoId}:${proposalId}`;
}
export function ipfsLkgKey(cid) {
    return `ipfs:${cid}`;
}
// ── Non-critical write queue ────────────────────────────────────────────
function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}
function loadQueue() {
    try {
        if (!fs.existsSync(QUEUE_FILE))
            return [];
        const raw = fs.readFileSync(QUEUE_FILE, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
function saveQueue(items) {
    ensureDataDir();
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(items, null, 2));
}
export function enqueueDegradedWrite(service, operation, payload) {
    const items = loadQueue();
    const item = {
        id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        service,
        operation,
        payload,
        createdAt: new Date().toISOString(),
        attempts: 0,
        lastError: null,
    };
    items.push(item);
    saveQueue(items);
    log("info", "degraded_write_queued", {
        id: item.id,
        service,
        operation,
    });
    return item;
}
export function listQueuedWrites(service) {
    const items = loadQueue();
    return service ? items.filter((i) => i.service === service) : items;
}
export function removeQueuedWrite(id) {
    const items = loadQueue();
    const next = items.filter((i) => i.id !== id);
    if (next.length === items.length)
        return false;
    saveQueue(next);
    return true;
}
export function updateQueuedWriteError(id, error) {
    const items = loadQueue();
    const item = items.find((i) => i.id === id);
    if (!item)
        return;
    item.attempts += 1;
    item.lastError = error;
    saveQueue(items);
}
/**
 * Drain queued IPFS pinJSON operations when the service recovers.
 * handler should return the resulting CID or throw.
 */
export async function drainIpfsPinQueue(handler) {
    const items = listQueuedWrites("ipfs").filter((i) => i.operation === "pinJSON");
    let drained = 0;
    let failed = 0;
    for (const item of items) {
        try {
            await handler(item.payload);
            removeQueuedWrite(item.id);
            drained++;
        }
        catch (err) {
            updateQueuedWriteError(item.id, err.message);
            failed++;
        }
    }
    if (drained > 0) {
        markHealthy("ipfs");
        log("info", "ipfs_queue_drained", { drained, failed });
    }
    return { drained, failed };
}
/** Clear queue file (tests). */
export function clearDegradedWriteQueue() {
    try {
        if (fs.existsSync(QUEUE_FILE))
            fs.unlinkSync(QUEUE_FILE);
    }
    catch {
        /* ignore */
    }
}
//# sourceMappingURL=service-health.js.map