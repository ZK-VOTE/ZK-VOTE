import * as StellarSdk from "@stellar/stellar-sdk";
import type { TTLTrackingEntry } from "./db.js";
import type { LoggerPort, StellarContext } from "./interfaces.js";

//__TTL_CHECKER_DEPS_START__
/**
 * Dependencies injected via `initTtlChecker` (#358) so this module never
 * imports the `stellar.js`/`config.js`/`logger.js`/`db.js` module singletons
 * directly (the `db.js` import above is type-only).
 */
export interface TtlCheckerDeps {
  /** Soroban RPC surface for on-chain TTL queries. */
  server: StellarContext["server"];
  /** Config: TTL urgency thresholds (ms). */
  ttlGracePeriodMs: number;
  ttlRenewalThresholdMs: number;
  /** Config: relayer test mode (skips on-chain queries). */
  testMode: boolean;
  /** TTL tracking persistence (events store). */
  getTTLTracking(entryId: string): TTLTrackingEntry | null;
  upsertTTLTracking(entry: TTLTrackingEntry): void;
  /** Structured logger (called as `deps.log(level, event, meta)`). */
  log: LoggerPort["log"];
}

let checkerDeps: TtlCheckerDeps | null = null;

/** Explicitly wire the TTL checker (composition root only). */
export function initTtlChecker(d: TtlCheckerDeps): void {
  checkerDeps = d;
}

function deps(): TtlCheckerDeps {
  if (!checkerDeps) {
    throw new Error("ttl-checker: initTtlChecker() must be called before use");
  }
  return checkerDeps;
}
//__TTL_CHECKER_DEPS_END__

const SOROBAN_TTL_LEDGERS = 31 * 17280;
const LEDGER_DURATION_MS = 5000;

export type Urgency = "grace" | "warning" | "healthy" | "unknown";

export interface TTLInfo {
  entryId: string;
  contractId: string;
  daoId: number | null;
  method: string | null;
  remainingMs: number;
  remainingLedgers: number;
  urgency: Urgency;
  tracked: boolean;
}

function categorizeUrgency(remainingMs: number): Urgency {
  if (remainingMs < deps().ttlGracePeriodMs) return "grace";
  if (remainingMs < deps().ttlRenewalThresholdMs) return "warning";
  return "healthy";
}

export function estimateRemainingFromTracked(
  entry: TTLTrackingEntry | null,
): TTLInfo | null {
  if (!entry || !entry.lastRenewedAt) return null;

  const lastRenewed = new Date(entry.lastRenewedAt).getTime();
  const elapsedMs = Date.now() - lastRenewed;
  const estimatedRemainingMs =
    SOROBAN_TTL_LEDGERS * LEDGER_DURATION_MS - elapsedMs;

  if (estimatedRemainingMs <= 0) return null;

  const remainingLedgers = Math.floor(
    estimatedRemainingMs / LEDGER_DURATION_MS,
  );

  return {
    entryId: entry.entryId,
    contractId: entry.contractId,
    daoId: entry.daoId,
    method: entry.method,
    remainingMs: estimatedRemainingMs,
    remainingLedgers,
    urgency: categorizeUrgency(estimatedRemainingMs),
    tracked: true,
  };
}

export async function queryContractInstanceTTL(contractId: string): Promise<{
  remainingLedgers: number;
  liveUntilLedger: number;
  latestLedger: number;
} | null> {
  try {
    if (deps().testMode) return null;

    const rawId = StellarSdk.StrKey.decodeContract(
      contractId,
    ) as unknown as StellarSdk.xdr.Hash;
    const ledgerKey = StellarSdk.xdr.LedgerKey.contractData(
      new StellarSdk.xdr.LedgerKeyContractData({
        contract: StellarSdk.xdr.ScAddress.scAddressTypeContract(rawId),
        key: StellarSdk.xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: StellarSdk.xdr.ContractDataDurability.persistent(),
      }),
    );

    const response = await (deps().server as StellarSdk.rpc.Server).getLedgerEntries(
      ledgerKey,
    );
    if (!response || !response.entries || response.entries.length === 0)
      return null;

    const entry = response.entries[0];
    const liveUntilLedger = entry.liveUntilLedgerSeq;
    const latestLedger = response.latestLedger;

    if (!liveUntilLedger || !latestLedger) return null;

    return {
      remainingLedgers: Math.max(0, liveUntilLedger - latestLedger),
      liveUntilLedger,
      latestLedger,
    };
  } catch (err) {
    deps().log("debug", "ttl_query_instance_failed", {
      contract: contractId.slice(0, 8) + "...",
      error: (err as Error).message,
    });
    return null;
  }
}

export async function queryInstanceTTLWithFallback(
  contractId: string,
  entryId: string,
): Promise<TTLInfo> {
  let remainingLedgers: number;
  let urgency: Urgency;

  const onChain = await queryContractInstanceTTL(contractId);

  if (onChain) {
    remainingLedgers = onChain.remainingLedgers;
    const remainingMs = remainingLedgers * LEDGER_DURATION_MS;
    urgency = categorizeUrgency(remainingMs);

    deps().upsertTTLTracking({
      entryId,
      contractId,
      daoId: null,
      method: "version",
      lastRenewedAt: null,
      remainingLedgers,
      urgency,
    });
  } else {
    const tracked = deps().getTTLTracking(entryId);
    const estimated = estimateRemainingFromTracked(tracked);

    if (estimated) {
      remainingLedgers = estimated.remainingLedgers;
      urgency = estimated.urgency;
    } else {
      remainingLedgers = SOROBAN_TTL_LEDGERS;
      urgency = "healthy";
    }
  }

  const remainingMs = remainingLedgers * LEDGER_DURATION_MS;

  return {
    entryId,
    contractId,
    daoId: null,
    method: "version",
    remainingMs,
    remainingLedgers,
    urgency,
    tracked: !onChain,
  };
}

export async function queryPersistentTTLWithFallback(
  contractId: string,
  daoId: number,
  method: string,
  entryId: string,
): Promise<TTLInfo> {
  const tracked = deps().getTTLTracking(entryId);
  const estimated = estimateRemainingFromTracked(tracked);

  if (estimated) {
    return { ...estimated, tracked: true };
  }

  const remainingMs = SOROBAN_TTL_LEDGERS * LEDGER_DURATION_MS;

  return {
    entryId,
    contractId,
    daoId,
    method,
    remainingMs,
    remainingLedgers: SOROBAN_TTL_LEDGERS,
    urgency: "healthy",
    tracked: false,
  };
}

export function needsRenewal(info: TTLInfo): boolean {
  return info.remainingMs < deps().ttlRenewalThresholdMs;
}

export function isInGracePeriod(info: TTLInfo): boolean {
  return info.urgency === "grace";
}

export function formatRemaining(info: TTLInfo): string {
  const days = Math.floor(info.remainingMs / 86400000);
  const hours = Math.floor((info.remainingMs % 86400000) / 3600000);
  return `${days}d ${hours}h`;
}
