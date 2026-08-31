/**
 * Sync Service with Optimistic Concurrency Control (Copy-on-Write Cache Snapshots)
 *
 * Handles DAO and membership synchronization from contracts to local cache.
 * Implements immutable cache snapshots with atomic reference swapping to eliminate
 * race conditions during async interleaving, cache versioning, invalidation notifications,
 * and hit/miss metrics.
 */

import { EventEmitter } from "events";
import * as StellarSdk from "@stellar/stellar-sdk";

import { isValidContractId } from "../config.js";
import type { DaoInput } from "./db.js";
import type { DaoData } from "./indexer.js";
import type { RpcServerPort, LoggerPort } from "./interfaces.js";
import type { Dao } from "../types/index.js";
import {
  serviceLastRunTime,
  serviceErrors,
  serviceRunning,
  daosSynced,
  membershipSyncsTotal,
} from "./metrics.js";
import { sharedSingleFlight } from "../utils/singleflight.js";

//__SYNC_DEPS_START__
/**
 * Persistence surface needed by the sync service (#358). Structurally typed
 * so unit tests can inject an in-memory fake.
 */
export interface SyncDbPort {
  getAllCachedDaos(): Array<Pick<Dao, "id" | "creator">>;
  upsertDaos(daos: DaoInput[]): void;
  setDaosSyncTime(timestamp: string): void;
}

/**
 * Dependencies of the sync service, injected explicitly via `initSyncService`
 * (called by the composition root) so this module never imports the
 * `stellar.js`/`db.js`/`logger.js`/`service-health.js`/`indexer.js` module
 * singletons to get what it needs (#358). Prometheus metrics (`metrics.js`)
 * are intentionally still module-scoped — they are process-global counters
 * by design and outside #358's scope.
 */
export interface SyncDeps {
  /** Active RPC server (pool-backed proxy in production). */
  server: RpcServerPort;
  /** Relayer keypair used for read calls to the contracts. */
  relayerKeypair: { publicKey(): string } & Partial<StellarSdk.Keypair>;
  /** Run `fn` with a timeout, labelled for logs/metrics. */
  callWithTimeout<T>(fn: () => Promise<T>, label: string): Promise<T>;
  /** Simulate a transaction with retry/backoff. */
  simulateWithBackoff<T>(fn: () => Promise<T>, attempts?: number): Promise<T>;
  /** Sequence manager used to flush state at shutdown. */
  sequenceManager: {
    forceResync(server: StellarSdk.rpc.Server): Promise<void>;
  };
  /** Config: max entries per snapshot cache (FIFO eviction, #191). */
  maxCachedDaos: number;
  /** Config: DAO registry contract id. */
  daoRegistryContractId?: string;
  /** Config: membership SBT contract id. */
  membershipSbtContractId?: string;
  /** Config: Stellar network passphrase. */
  networkPassphrase: string;
  /** Config: DAO sync interval (ms). */
  daoSyncIntervalMs: number;
  /** Config: membership sync interval (ms). */
  membershipSyncIntervalMs: number;
  /** DAO/metadata persistence (events store). */
  dbService: SyncDbPort;
  /** Backfill the dao_create event for a freshly synced DAO. */
  ensureDaoCreateEvent(daoId: number, daoData: DaoData): boolean;
  /** Health reporting for the background sync loops. */
  markHealthy(service: "dao_sync"): void;
  markDegraded(service: "dao_sync", reason?: string): void;
  /** Structured logger (called as `deps.log(level, event, meta)`). */
  log: LoggerPort["log"];
}

let syncDeps: SyncDeps | null = null;

/** Explicitly wire the sync service (composition root only). */
export function initSyncService(d: SyncDeps): void {
  syncDeps = d;
}

function deps(): SyncDeps {
  if (!syncDeps) {
    throw new Error("sync: initSyncService() must be called before use");
  }
  return syncDeps;
}
//__SYNC_DEPS_END__

// ============================================
// IMMUTABLE CACHE SNAPSHOT & CONCURRENCY STATE
// ============================================

export interface CacheSnapshot {
  daoMembers: Map<number, Set<string>>;
  daoAdmins: Map<number, string>;
  version: number;
  updatedAt: string;
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  hitRate: number;
  version: number;
  daoCount: number;
}

// Initial empty snapshot
let currentSnapshot: CacheSnapshot = {
  daoMembers: new Map<number, Set<string>>(),
  daoAdmins: new Map<number, string>(),
  version: 0,
  updatedAt: new Date().toISOString(),
};

// Hit/Miss Counters
let cacheHits = 0;
let cacheMisses = 0;

// Event Emitter for Cache Invalidation Notifications
export const cacheEmitter = new EventEmitter();

/**
 * Get current immutable cache snapshot
 */
export function getCacheSnapshot(): CacheSnapshot {
  return currentSnapshot;
}

/**
 * Get current cache version counter
 */
export function getCacheVersion(): number {
  return currentSnapshot.version;
}

/**
 * Get member set for DAO with metrics tracking
 */
export function getDaoMembersFromCache(daoId: number): Set<string> | undefined {
  const members = currentSnapshot.daoMembers.get(daoId);
  if (members) {
    cacheHits++;
  } else {
    cacheMisses++;
  }
  return members;
}

/**
 * Get admin address for DAO with metrics tracking
 */
export function getDaoAdminFromCache(daoId: number): string | undefined {
  const admin = currentSnapshot.daoAdmins.get(daoId);
  if (admin) {
    cacheHits++;
  } else {
    cacheMisses++;
  }
  return admin;
}

/**
 * Get cache hit/miss metrics
 */
export function getCacheMetrics(): CacheMetrics {
  const total = cacheHits + cacheMisses;
  const hitRate = total > 0 ? Math.round((cacheHits / total) * 100) / 100 : 0;
  return {
    hits: cacheHits,
    misses: cacheMisses,
    hitRate,
    version: currentSnapshot.version,
    daoCount: currentSnapshot.daoMembers.size,
  };
}

/**
 * Register listener for cache invalidation notifications
 */
export function onCacheInvalidated(
  listener: (snapshot: CacheSnapshot) => void,
): () => void {
  cacheEmitter.on("cache:invalidated", listener);
  return () => {
    cacheEmitter.off("cache:invalidated", listener);
  };
}

/**
 * Evict the oldest entries (in Map insertion order) once a snapshot map
 * exceeds the configured max size. Bounds memory growth of the DAO caches
 * (see #191) — insertion-order (FIFO) eviction is used rather than
 * access-order LRU because these maps are immutable copy-on-write
 * snapshots, and reordering on read would defeat that concurrency design.
 */
export function evictOldestOverflow<K, V>(
  map: Map<K, V>,
  maxEntries: number,
): Map<K, V> {
  if (map.size <= maxEntries) return map;
  const trimmed = new Map(map);
  while (trimmed.size > maxEntries) {
    const oldestKey = trimmed.keys().next().value;
    if (oldestKey === undefined) break;
    trimmed.delete(oldestKey);
  }
  return trimmed;
}

/**
 * Atomically swap cache snapshot reference (Copy-on-Write)
 */
function swapCacheSnapshot(
  newMembers: Map<number, Set<string>>,
  newAdmins: Map<number, string>,
): CacheSnapshot {
  const nextVersion = currentSnapshot.version + 1;
  const boundedMembers = evictOldestOverflow(newMembers, deps().maxCachedDaos);
  const boundedAdmins = evictOldestOverflow(newAdmins, deps().maxCachedDaos);
  const nextSnapshot: CacheSnapshot = {
    daoMembers: boundedMembers,
    daoAdmins: boundedAdmins,
    version: nextVersion,
    updatedAt: new Date().toISOString(),
  };

  // Atomic reference swap
  currentSnapshot = nextSnapshot;

  // Emit invalidation notification to connected clients/subscribers
  cacheEmitter.emit("cache:invalidated", currentSnapshot);

  deps().log("debug", "cache_snapshot_swapped", {
    version: nextVersion,
    daoCount: newMembers.size,
    adminCount: newAdmins.size,
  });

  return currentSnapshot;
}

// ============================================
// BACKWARD COMPATIBILITY PROXIES
// ============================================

export const daoMembersCache = new Proxy(new Map<number, Set<string>>(), {
  get(_target, prop, receiver) {
    const snapshotMap = currentSnapshot.daoMembers;
    if (prop === "get") {
      return (key: number) => getDaoMembersFromCache(key);
    }
    if (prop === "has") {
      return (key: number) => snapshotMap.has(key);
    }
    if (prop === "size") {
      return snapshotMap.size;
    }
    if (prop === "set") {
      return (key: number, value: Set<string>) => {
        const nextMembers = new Map(currentSnapshot.daoMembers);
        nextMembers.set(key, value);
        swapCacheSnapshot(nextMembers, currentSnapshot.daoAdmins);
        return receiver;
      };
    }
    const val = Reflect.get(snapshotMap, prop, snapshotMap);
    return typeof val === "function" ? val.bind(snapshotMap) : val;
  },
});

export const daoAdminsCache = new Proxy(new Map<number, string>(), {
  get(_target, prop, receiver) {
    const snapshotMap = currentSnapshot.daoAdmins;
    if (prop === "get") {
      return (key: number) => getDaoAdminFromCache(key);
    }
    if (prop === "has") {
      return (key: number) => snapshotMap.has(key);
    }
    if (prop === "size") {
      return snapshotMap.size;
    }
    if (prop === "set") {
      return (key: number, value: string) => {
        const nextAdmins = new Map(currentSnapshot.daoAdmins);
        nextAdmins.set(key, value);
        swapCacheSnapshot(currentSnapshot.daoMembers, nextAdmins);
        return receiver;
      };
    }
    const val = Reflect.get(snapshotMap, prop, snapshotMap);
    return typeof val === "function" ? val.bind(snapshotMap) : val;
  },
});

// ============================================
// DAO SYNC FROM CONTRACT
// ============================================

/**
 * Sync all DAOs from the DAO Registry contract to local cache
 */
export async function syncDaosFromContract(): Promise<number> {
  return sharedSingleFlight.do("daos", async () => {
    const daoRegistryContractId = deps().daoRegistryContractId;
    if (!daoRegistryContractId || !isValidContractId(daoRegistryContractId)) {
      deps().log("warn", "dao_sync_skipped", {
        reason: "DAO_REGISTRY_CONTRACT_ID not configured",
      });
      return 0;
    }

    try {
      deps().log("info", "dao_sync_start");

      const contract = new StellarSdk.Contract(daoRegistryContractId);
      const account = await (deps().server as StellarSdk.rpc.Server).getAccount(
        deps().relayerKeypair.publicKey(),
      );

      // Get DAO count
      const countOp = contract.call("dao_count");
      const countTx = new StellarSdk.TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: deps().networkPassphrase,
      })
        .addOperation(countOp)
        .setTimeout(30)
        .build();

      const countSimResult = await deps().callWithTimeout(
        () =>
          deps().simulateWithBackoff(() =>
            (deps().server as StellarSdk.rpc.Server).simulateTransaction(countTx),
          ),
        "simulate_dao_count",
      );

      if (!StellarSdk.rpc.Api.isSimulationSuccess(countSimResult)) {
        deps().log("warn", "dao_count_failed", { error: countSimResult.error });
        return 0;
      }

      const daoCount = Number(
        StellarSdk.scValToNative(countSimResult.result!.retval!),
      );
      deps().log("info", "dao_count_fetched", { count: daoCount });

      if (daoCount === 0) {
        deps().dbService.setDaosSyncTime(new Date().toISOString());
        return 0;
      }

      // Fetch each DAO with bounded parallelism
      const daos: Dao[] = [];
      const daoIds = Array.from({ length: daoCount }, (_, i) => i + 1);
      const DAO_CHUNK_SIZE = 5;

      const fetchDao = async (i: number): Promise<void> => {
        try {
          const daoAccount = await (deps().server as StellarSdk.rpc.Server).getAccount(
            deps().relayerKeypair.publicKey(),
          );
          const getOp = contract.call(
            "get_dao",
            StellarSdk.nativeToScVal(i, { type: "u64" }),
          );
          const getTx = new StellarSdk.TransactionBuilder(daoAccount, {
            fee: "100",
            networkPassphrase: deps().networkPassphrase,
          })
            .addOperation(getOp)
            .setTimeout(30)
            .build();

          const getSimResult = await deps().callWithTimeout(
            () =>
              deps().simulateWithBackoff(() =>
                (deps().server as StellarSdk.rpc.Server).simulateTransaction(getTx),
              ),
            `simulate_get_dao_${i}`,
          );

          if (
            StellarSdk.rpc.Api.isSimulationSuccess(getSimResult) &&
            getSimResult.result?.retval
          ) {
            const daoData = StellarSdk.scValToNative(
              getSimResult.result.retval,
            );
            daos.push({
              id: i,
              name: daoData.name || `DAO ${i}`,
              creator: daoData.creator || "",
              membership_open: daoData.membership_open !== false,
              members_can_propose: daoData.members_can_propose === true,
              metadata_cid: daoData.metadata_cid || null,
              member_count: Number(daoData.member_count || 0),
            });
          }
        } catch (err) {
          deps().log("warn", "dao_fetch_failed", {
            daoId: i,
            error: (err as Error).message,
          });
        }
      };

      for (let i = 0; i < daoIds.length; i += DAO_CHUNK_SIZE) {
        const chunk = daoIds.slice(i, i + DAO_CHUNK_SIZE);
        await Promise.all(chunk.map((id) => fetchDao(id)));
      }

      // Save to database
      if (daos.length > 0) {
        deps().dbService.upsertDaos(daos);

        // Ensure dao_create events exist
        for (const dao of daos) {
          deps().ensureDaoCreateEvent(dao.id, dao);
        }
      }

      deps().dbService.setDaosSyncTime(new Date().toISOString());
      daosSynced.inc(daos.length);
      serviceLastRunTime.set({ service: "dao_sync" }, Date.now() / 1000);
      deps().log("info", "dao_sync_complete", {
        synced: daos.length,
        total: daoCount,
      });

      return daos.length;
    } catch (err) {
      serviceErrors.inc({ service: "dao_sync" });
      deps().log("error", "dao_sync_error", { error: (err as Error).message });
      return 0;
    }
  });
}

let daoSyncInterval: NodeJS.Timeout | null = null;

/**
 * Start background DAO sync
 */
export function startDaoSync(): void {
  if (daoSyncInterval) {
    clearInterval(daoSyncInterval);
  }

  serviceRunning.set({ service: "dao_sync" }, 1);

  syncDaosFromContract()
    .then((count) => {
      deps().log("info", "initial_dao_sync", { count });
      deps().markHealthy("dao_sync");
    })
    .catch((err) => {
      deps().markDegraded("dao_sync", (err as Error).message);
      deps().log("error", "initial_dao_sync_failed", {
        error: (err as Error).message,
      });
    });

  daoSyncInterval = setInterval(() => {
    syncDaosFromContract()
      .then(() => deps().markHealthy("dao_sync"))
      .catch((err) => {
        deps().markDegraded("dao_sync", (err as Error).message);
        deps().log("error", "periodic_dao_sync_failed", {
          error: (err as Error).message,
        });
      });
  }, deps().daoSyncIntervalMs);

  deps().log("info", "dao_sync_started", { intervalMs: deps().daoSyncIntervalMs });
}

/**
 * Stop background DAO sync
 */
export function stopDaoSync(): void {
  if (daoSyncInterval) {
    clearInterval(daoSyncInterval);
    daoSyncInterval = null;
    serviceRunning.set({ service: "dao_sync" }, 0);
    deps().log("info", "dao_sync_stopped");
  }
}

// ============================================
// MEMBERSHIP SYNC
// ============================================

/**
 * Sync members for a single DAO (uses Copy-on-Write atomic snapshot update)
 */
export async function syncDaoMembership(daoId: number): Promise<void> {
  const sbtContractId = deps().membershipSbtContractId;
  if (!sbtContractId || !isValidContractId(sbtContractId)) {
    return;
  }

  try {
    const sbtContract = new StellarSdk.Contract(sbtContractId);
    const members = new Set<string>();
    const BATCH_SIZE = 50;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const account = await (deps().server as StellarSdk.rpc.Server).getAccount(
        deps().relayerKeypair.publicKey(),
      );
      const getMembersOp = sbtContract.call(
        "get_members",
        StellarSdk.nativeToScVal(daoId, { type: "u64" }),
        StellarSdk.nativeToScVal(offset, { type: "u64" }),
        StellarSdk.nativeToScVal(BATCH_SIZE, { type: "u64" }),
      );
      const getMembersTx = new StellarSdk.TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: deps().networkPassphrase,
      })
        .addOperation(getMembersOp)
        .setTimeout(30)
        .build();

      const simResult = await deps().callWithTimeout(
        () =>
          deps().simulateWithBackoff(() =>
            (deps().server as StellarSdk.rpc.Server).simulateTransaction(getMembersTx),
          ),
        `simulate_get_members_${daoId}_${offset}`,
      );

      if (
        StellarSdk.rpc.Api.isSimulationSuccess(simResult) &&
        simResult.result?.retval
      ) {
        const memberAddresses = StellarSdk.scValToNative(
          simResult.result.retval,
        );
        if (Array.isArray(memberAddresses) && memberAddresses.length > 0) {
          for (const addr of memberAddresses) {
            members.add(addr);
          }
          offset += memberAddresses.length;
          hasMore = memberAddresses.length === BATCH_SIZE;
        } else {
          hasMore = false;
        }
      } else {
        hasMore = false;
      }
    }

    // Build new map copy and atomically swap reference
    const nextMembersMap = new Map(currentSnapshot.daoMembers);
    nextMembersMap.set(daoId, members);
    swapCacheSnapshot(nextMembersMap, currentSnapshot.daoAdmins);

    deps().log("info", "dao_membership_synced", { daoId, memberCount: members.size });
  } catch (err) {
    deps().log("warn", "dao_membership_sync_failed", {
      daoId,
      error: (err as Error).message,
    });
  }
}

/**
 * Sync all memberships (uses Copy-on-Write atomic snapshot update)
 */
export async function syncAllMemberships(): Promise<void> {
  if (
    !deps().membershipSbtContractId ||
    !isValidContractId(deps().membershipSbtContractId)
  ) {
    deps().log("warn", "membership_sync_skipped", {
      reason: "MEMBERSHIP_SBT_CONTRACT_ID not configured",
    });
    return;
  }

  const daos = deps().dbService.getAllCachedDaos();
  if (daos.length === 0) {
    deps().log("info", "membership_sync_skipped", { reason: "no DAOs in cache" });
    return;
  }

  deps().log("info", "membership_sync_start", { daoCount: daos.length });

  // Prepare admin addresses copy
  const nextAdminsMap = new Map(currentSnapshot.daoAdmins);
  for (const dao of daos) {
    if (dao.creator) {
      nextAdminsMap.set(dao.id, dao.creator);
    }
  }

  // Sync DAOs with bounded parallelism
  const MEMBERSHIP_CHUNK_SIZE = 5;
  for (let i = 0; i < daos.length; i += MEMBERSHIP_CHUNK_SIZE) {
    const chunk = daos.slice(i, i + MEMBERSHIP_CHUNK_SIZE);
    await Promise.all(chunk.map((dao) => syncDaoMembership(dao.id)));
  }

  deps().log("info", "membership_sync_complete", { daoCount: daos.length });
  membershipSyncsTotal.inc({ status: "success" });
  serviceLastRunTime.set({ service: "membership_sync" }, Date.now() / 1000);
}

let membershipSyncInterval: NodeJS.Timeout | null = null;

/**
 * Start background membership sync
 */
export function startMembershipSync(): void {
  if (membershipSyncInterval) {
    clearInterval(membershipSyncInterval);
  }

  serviceRunning.set({ service: "membership_sync" }, 1);

  // Initial sync after DAO sync
  setTimeout(() => {
    syncAllMemberships().catch((err) => {
      deps().log("error", "initial_membership_sync_failed", {
        error: (err as Error).message,
      });
    });
  }, 5000);

  membershipSyncInterval = setInterval(() => {
    syncAllMemberships().catch((err) => {
      deps().log("error", "periodic_membership_sync_failed", {
        error: (err as Error).message,
      });
    });
  }, deps().membershipSyncIntervalMs);

  deps().log("info", "membership_sync_started", {
    intervalMs: deps().membershipSyncIntervalMs,
  });
}

/**
 * Stop background membership sync
 */
export function stopMembershipSync(): void {
  if (membershipSyncInterval) {
    clearInterval(membershipSyncInterval);
    membershipSyncInterval = null;
    serviceRunning.set({ service: "membership_sync" }, 0);
    deps().log("info", "membership_sync_stopped");
  }
}

/**
 * Graceful shutdown: flush sequence state so the next process starts clean.
 * Called by the shutdown handler after in-flight submissions have drained.
 */
export async function gracefulShutdownSync(): Promise<void> {
  stopDaoSync();
  stopMembershipSync();
  try {
    await deps().sequenceManager.forceResync(
      deps().server as import("@stellar/stellar-sdk").rpc.Server,
    );
    deps().log("info", "sequence_persisted_on_shutdown");
  } catch (err) {
    deps().log("warn", "sequence_resync_on_shutdown_failed", {
      error: (err as Error).message,
    });
  }
}

/**
 * Trigger membership sync for specific DAO
 */
export async function triggerDaoMembershipSync(daoId: number): Promise<void> {
  deps().log("info", "triggered_membership_sync", { daoId });
  await syncDaoMembership(daoId);
}

// ============================================
// REAL-TIME MEMBERSHIP VERIFICATION
//
// daoMembersCache (above) is refreshed on a periodic interval and is fine for
// non-critical reads (e.g. displaying a user's role). For security-critical
// writes, a stale cache creates a window where a just-revoked member is still
// treated as a member. verifyMembership() closes that window by reading the
// SBT contract's `has()` directly, with a short-TTL result cache so bursts of
// writes from the same caller don't each pay a full RPC round trip.
// ============================================

const MEMBERSHIP_VERIFICATION_TTL_MS = 30_000;

interface MembershipVerificationEntry {
  result: boolean;
  expiresAt: number;
}

const membershipVerificationCache = new Map<
  string,
  MembershipVerificationEntry
>();

interface MembershipVerificationMetrics {
  checks: number;
  chainCalls: number;
  cacheHits: number;
  mismatches: number;
  errors: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
}

const membershipVerificationMetrics: MembershipVerificationMetrics = {
  checks: 0,
  chainCalls: 0,
  cacheHits: 0,
  mismatches: 0,
  errors: 0,
  totalLatencyMs: 0,
  maxLatencyMs: 0,
};

/**
 * Latency/hit-rate/mismatch metrics for verifyMembership(), for monitoring.
 */
export function getMembershipVerificationMetrics(): {
  checks: number;
  chainCalls: number;
  cacheHits: number;
  mismatches: number;
  errors: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
} {
  const {
    checks,
    chainCalls,
    cacheHits,
    mismatches,
    errors,
    totalLatencyMs,
    maxLatencyMs,
  } = membershipVerificationMetrics;
  return {
    checks,
    chainCalls,
    cacheHits,
    mismatches,
    errors,
    avgLatencyMs:
      chainCalls > 0
        ? Math.round((totalLatencyMs / chainCalls) * 100) / 100
        : 0,
    maxLatencyMs,
  };
}

function membershipCacheKey(daoId: number, address: string): string {
  return `${daoId}:${address}`;
}

/** Test/ops hook: clear the short-TTL verification cache. */
export function clearMembershipVerificationCache(): void {
  membershipVerificationCache.clear();
}

/**
 * Real-time on-chain membership check via the Membership SBT contract's
 * `has(dao_id, of)` read entrypoint — the source of truth for write-path
 * authorization. Results are cached for MEMBERSHIP_VERIFICATION_TTL_MS (30s)
 * to bound RPC load; a cache miss/mismatch against the periodic daoMembersCache
 * is logged for monitoring. Throws if the on-chain check itself cannot be
 * completed (RPC error) — callers should fail closed (reject the write)
 * rather than silently falling back to the periodic cache.
 */
export async function verifyMembership(
  daoId: number,
  address: string,
): Promise<boolean> {
  membershipVerificationMetrics.checks++;

  const key = membershipCacheKey(daoId, address);
  const cached = membershipVerificationCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    membershipVerificationMetrics.cacheHits++;
    return cached.result;
  }

  const sbtContractId = deps().membershipSbtContractId;
  if (!sbtContractId || !isValidContractId(sbtContractId)) {
    throw new Error(
      "Membership verification unavailable: MEMBERSHIP_SBT_CONTRACT_ID not configured",
    );
  }

  const start = Date.now();
  try {
    const sbtContract = new StellarSdk.Contract(sbtContractId);
    const account = await (deps().server as StellarSdk.rpc.Server).getAccount(
      deps().relayerKeypair.publicKey(),
    );
    const operation = sbtContract.call(
      "has",
      StellarSdk.nativeToScVal(daoId, { type: "u64" }),
      StellarSdk.xdr.ScVal.scvAddress(
        StellarSdk.Address.fromString(address).toScAddress(),
      ),
    );
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: deps().networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await deps().callWithTimeout(
      () =>
        deps().simulateWithBackoff(() =>
          (deps().server as StellarSdk.rpc.Server).simulateTransaction(tx),
        ),
      `simulate_verify_membership_${daoId}`,
    );

    if (
      !StellarSdk.rpc.Api.isSimulationSuccess(simResult) ||
      !simResult.result?.retval
    ) {
      throw new Error("Membership verification simulation failed");
    }

    const isMember = Boolean(StellarSdk.scValToNative(simResult.result.retval));
    const latencyMs = Date.now() - start;
    membershipVerificationMetrics.chainCalls++;
    membershipVerificationMetrics.totalLatencyMs += latencyMs;
    membershipVerificationMetrics.maxLatencyMs = Math.max(
      membershipVerificationMetrics.maxLatencyMs,
      latencyMs,
    );

    const cachedMembers = getDaoMembersFromCache(daoId);
    const cachedSaysMember = cachedMembers?.has(address) ?? false;
    if (cachedSaysMember !== isMember) {
      membershipVerificationMetrics.mismatches++;
      deps().log("warn", "membership_cache_mismatch", {
        daoId,
        cachedMember: cachedSaysMember,
        onChainMember: isMember,
      });
    }

    membershipVerificationCache.set(key, {
      result: isMember,
      expiresAt: Date.now() + MEMBERSHIP_VERIFICATION_TTL_MS,
    });

    deps().log("debug", "membership_verified_realtime", {
      daoId,
      isMember,
      latencyMs,
    });
    return isMember;
  } catch (err) {
    membershipVerificationMetrics.errors++;
    deps().log("error", "membership_verify_failed", {
      daoId,
      error: (err as Error).message,
    });
    throw err;
  }
}
