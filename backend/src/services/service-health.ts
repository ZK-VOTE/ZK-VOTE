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

export type ServiceTier =
  | "critical"
  | "important"
  | "non_critical"
  | "background";
export type ServiceState = "healthy" | "degraded" | "unavailable";

export type ServiceName =
  | "soroban_rpc"
  | "horizon"
  | "anchor_usdc"
  | "anchor_eurc"
  | "swap_quotes"
  | "sqlite"
  | "ipfs"
  | "comments"
  | "indexer"
  | "dao_sync"
  | "membership_sync"
  | "ttl_renewal"
  | "sbt_transfer_watch";

export interface ServiceHealthEntry {
  name: ServiceName;
  tier: ServiceTier;
  state: ServiceState;
  lastError: string | null;
  updatedAt: string;
  description: string;
}

export interface OverallHealth {
  status: "ok" | "degraded";
  degraded: ServiceName[];
  unavailable: ServiceName[];
  services: ServiceHealthEntry[];
}

export interface QueuedWrite {
  id: string;
  service: ServiceName;
  operation: string;
  payload: unknown;
  createdAt: string;
  attempts: number;
  lastError: string | null;
  deduplicationKey?: string; // For replay deduplication
  replayedAt?: string; // Timestamp of successful replay
}

const SERVICE_META: Record<
  ServiceName,
  { tier: ServiceTier; description: string }
> = {
  soroban_rpc: {
    tier: "critical",
    description: "Soroban RPC for voting and proposal queries",
  },
  horizon: {
    tier: "critical",
    description: "Horizon for payments, swaps and account state",
  },
  anchor_usdc: {
    tier: "important",
    description: "USDC anchor for SEP-6/31 on/off-ramp",
  },
  anchor_eurc: {
    tier: "important",
    description: "EURC anchor for SEP-6/31 on/off-ramp",
  },
  swap_quotes: {
    tier: "important",
    description: "Swap quotes (Horizon strict-send, Soroswap fallback)",
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
  membership_sync: {
    tier: "background",
    description: "Membership sync from SBT contract",
  },
};

const health = new Map<ServiceName, ServiceHealthEntry>();

function initEntry(name: ServiceName): ServiceHealthEntry {
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

for (const name of Object.keys(SERVICE_META) as ServiceName[]) {
  health.set(name, initEntry(name));
}

/** Reset all services to healthy (tests). */
export function resetServiceHealth(): void {
  for (const name of Object.keys(SERVICE_META) as ServiceName[]) {
    health.set(name, initEntry(name));
  }
  lkg.clear();
}

export function markHealthy(name: ServiceName): void {
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

export function markDegraded(name: ServiceName, error?: string): void {
  const prev = health.get(name) ?? initEntry(name);
  health.set(name, {
    ...prev,
    state: "degraded",
    lastError: error ?? prev.lastError,
    updatedAt: new Date().toISOString(),
  });
  log("warn", "service_degraded", { service: name, error: error ?? null });
}

export function markUnavailable(name: ServiceName, error?: string): void {
  const prev = health.get(name) ?? initEntry(name);
  health.set(name, {
    ...prev,
    state: "unavailable",
    lastError: error ?? prev.lastError,
    updatedAt: new Date().toISOString(),
  });
  log("error", "service_unavailable", { service: name, error: error ?? null });
}

export function getServiceHealth(
  name?: ServiceName,
): ServiceHealthEntry | ServiceHealthEntry[] {
  if (name) return health.get(name) ?? initEntry(name);
  return Array.from(health.values());
}

export function getOverallHealth(): OverallHealth {
  const services = Array.from(health.values());
  const degraded = services
    .filter((s) => s.state === "degraded")
    .map((s) => s.name);
  const unavailable = services
    .filter((s) => s.state === "unavailable")
    .map((s) => s.name);
  const status =
    degraded.length > 0 || unavailable.length > 0 ? "degraded" : "ok";
  return { status, degraded, unavailable, services };
}

export function getDegradedServiceNames(): string[] {
  const overall = getOverallHealth();
  return [...overall.degraded, ...overall.unavailable];
}

// ── Last-known-good cache ───────────────────────────────────────────────

interface LkgEntry {
  value: unknown;
  storedAt: number;
  ttlMs: number;
  sourceAvailable: boolean;
  dataStatus: "authoritative" | "cached" | "stale";
  asOf: number; // Original data timestamp
}

const lkg = new Map<string, LkgEntry>();
const DEFAULT_LKG_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Per-endpoint freshness ceilings (max age before data is considered too stale)
const FRESHNESS_CEILINGS: Record<string, number> = {
  "comments": 60 * 60 * 1000, // 1 hour
  "ipfs": 24 * 60 * 60 * 1000, // 24 hours (IPFS data is immutable)
  "dao_state": 15 * 60 * 1000, // 15 minutes
  "proposals": 5 * 60 * 1000, // 5 minutes
  "swap_quotes": 60 * 1000, // 1 minute
  "default": 30 * 60 * 1000, // 30 minutes
};

export function setLkg(
  key: string,
  value: unknown,
  options?: {
    ttlMs?: number;
    sourceAvailable?: boolean;
    asOf?: number;
  },
): void {
  const now = Date.now();
  const asOf = options?.asOf ?? now;
  const sourceAvailable = options?.sourceAvailable ?? true;
  
  // Determine data status based on freshness
  let dataStatus: "authoritative" | "cached" | "stale" = "authoritative";
  if (!sourceAvailable) {
    dataStatus = "cached";
  }
  
  const entry: LkgEntry = {
    value,
    storedAt: now,
    ttlMs: options?.ttlMs ?? DEFAULT_LKG_TTL_MS,
    sourceAvailable,
    dataStatus,
    asOf,
  };
  
  lkg.set(key, entry);
  
  log("debug", "lkg_cache_set", {
    key,
    ttlMs: entry.ttlMs,
    sourceAvailable,
    dataStatus,
  });
}

export function getLkg<T = unknown>(
  key: string,
  options?: { enforceFreshness?: boolean },
): {
  value: T | null;
  metadata?: {
    sourceAvailable: boolean;
    dataStatus: "authoritative" | "cached" | "stale";
    asOf: Date;
    age: number;
    maxAge: number;
  };
} {
  const entry = lkg.get(key);
  if (!entry) return { value: null };
  
  const now = Date.now();
  const age = now - entry.storedAt;
  const dataAge = now - entry.asOf;
  
  // Determine endpoint-specific freshness ceiling
  const endpoint = key.split(":")[0];
  const maxAge = FRESHNESS_CEILINGS[endpoint] || FRESHNESS_CEILINGS.default;
  
  // Check if data is beyond TTL
  if (age > entry.ttlMs) {
    lkg.delete(key);
    return { value: null };
  }
  
  // Check if data is beyond freshness ceiling
  if (options?.enforceFreshness && dataAge > maxAge) {
    log("warn", "lkg_cache_too_stale", {
      key,
      dataAge,
      maxAge,
      status: "refusing_to_serve",
    });
    return { value: null };
  }
  
  // Update data status based on age
  let dataStatus = entry.dataStatus;
  if (dataAge > maxAge) {
    dataStatus = "stale";
  } else if (!entry.sourceAvailable) {
    dataStatus = "cached";
  }
  
  return {
    value: entry.value as T,
    metadata: {
      sourceAvailable: entry.sourceAvailable,
      dataStatus,
      asOf: new Date(entry.asOf),
      age: dataAge,
      maxAge,
    },
  };
}

export function commentsLkgKey(daoId: number, proposalId: number): string {
  return `comments:${daoId}:${proposalId}`;
}

export function ipfsLkgKey(cid: string): string {
  return `ipfs:${cid}`;
}

// ── Non-critical write queue ────────────────────────────────────────────

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadQueue(): QueuedWrite[] {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const raw = fs.readFileSync(QUEUE_FILE, "utf8");
    const parsed = JSON.parse(raw) as QueuedWrite[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveQueue(items: QueuedWrite[]): void {
  ensureDataDir();
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(items, null, 2));
}

export function enqueueDegradedWrite(
  service: ServiceName,
  operation: string,
  payload: unknown,
  deduplicationKey?: string,
): QueuedWrite {
  const items = loadQueue();
  
  // Check for duplicate if deduplication key provided
  if (deduplicationKey) {
    const existing = items.find(
      (i) => i.deduplicationKey === deduplicationKey && !i.replayedAt,
    );
    if (existing) {
      log("info", "degraded_write_deduplicated", {
        id: existing.id,
        service,
        operation,
        deduplicationKey,
      });
      return existing;
    }
  }
  
  const item: QueuedWrite = {
    id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    service,
    operation,
    payload,
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    deduplicationKey,
  };
  items.push(item);
  saveQueue(items);
  log("info", "degraded_write_queued", {
    id: item.id,
    service,
    operation,
    deduplicationKey: deduplicationKey || undefined,
  });
  return item;
}

export function listQueuedWrites(service?: ServiceName): QueuedWrite[] {
  const items = loadQueue();
  return service ? items.filter((i) => i.service === service) : items;
}

export function removeQueuedWrite(id: string): boolean {
  const items = loadQueue();
  const next = items.filter((i) => i.id !== id);
  if (next.length === items.length) return false;
  saveQueue(next);
  return true;
}

export function updateQueuedWriteError(id: string, error: string): void {
  const items = loadQueue();
  const item = items.find((i) => i.id === id);
  if (!item) return;
  item.attempts += 1;
  item.lastError = error;
  saveQueue(items);
}

/**
 * Drain queued IPFS pinJSON operations when the service recovers.
 * handler should return the resulting CID or throw.
 * Implements deduplication to ensure exactly-once replay.
 */
export async function drainIpfsPinQueue(
  handler: (payload: {
    data: unknown;
    name?: string;
  }) => Promise<{ cid: string; size?: number }>,
): Promise<{ drained: number; failed: number; skipped: number }> {
  const items = listQueuedWrites("ipfs").filter(
    (i) => i.operation === "pinJSON" && !i.replayedAt,
  );
  let drained = 0;
  let failed = 0;
  let skipped = 0;
  
  for (const item of items) {
    // Skip if already replayed (dedup check)
    if (item.replayedAt) {
      skipped++;
      continue;
    }
    
    try {
      await handler(item.payload as { data: unknown; name?: string });
      
      // Mark as replayed instead of removing
      const allItems = loadQueue();
      const idx = allItems.findIndex((i) => i.id === item.id);
      if (idx >= 0) {
        allItems[idx].replayedAt = new Date().toISOString();
        saveQueue(allItems);
      }
      
      drained++;
      
      log("info", "degraded_write_replayed", {
        id: item.id,
        service: item.service,
        operation: item.operation,
        attempts: item.attempts,
      });
    } catch (err) {
      updateQueuedWriteError(item.id, (err as Error).message);
      failed++;
      
      log("warn", "degraded_write_replay_failed", {
        id: item.id,
        service: item.service,
        operation: item.operation,
        attempts: item.attempts + 1,
        error: (err as Error).message,
      });
    }
  }
  
  if (drained > 0) {
    markHealthy("ipfs");
    log("info", "ipfs_queue_drained", { drained, failed, skipped });
  }
  
  // Clean up old replayed items (older than 7 days)
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const allItems = loadQueue();
  const cleaned = allItems.filter((i) => {
    if (!i.replayedAt) return true;
    return new Date(i.replayedAt).getTime() > sevenDaysAgo;
  });
  
  if (cleaned.length < allItems.length) {
    saveQueue(cleaned);
    log("info", "degraded_write_queue_cleaned", {
      removed: allItems.length - cleaned.length,
    });
  }
  
  return { drained, failed, skipped };
}

/** Clear queue file (tests). */
export function clearDegradedWriteQueue(): void {
  try {
    if (fs.existsSync(QUEUE_FILE)) fs.unlinkSync(QUEUE_FILE);
  } catch {
    /* ignore */
  }
}
