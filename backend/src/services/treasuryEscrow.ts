/**
 * Satellite Treasury Escrow status tracking (ZV-107).
 *
 * The EVM `TreasuryEscrow` contract (contracts/bridge/evm/contracts/
 * TreasuryEscrow.sol) is the source of truth for fund custody. This module
 * is a best-effort status cache the frontend polls so it doesn't need its
 * own chain indexer: wallets report their own `lock()` transaction, and a
 * relayer with finality authority reports the outcome once it has observed
 * Soroban finality/cancellation and submitted the corresponding EVM
 * transaction. Watching the EVM chain directly to populate this cache
 * automatically is ZV-038's event-poll work, not this module's job.
 *
 * Replay protection and the 24h timeout rule are re-checked here so the
 * cache can't be driven into a state the contract itself would reject,
 * even though the contract remains the final authority on fund movement.
 */

export type EscrowLockStatus = "locked" | "released" | "cancelled" | "refunded";

export interface EscrowLockRecord {
  /** On-chain lock id (TreasuryEscrow.nextLockId sequence), as a decimal string. */
  lockId: string;
  daoId: number;
  proposalId: number;
  depositor: string;
  recipient: string;
  /** Wei amount, as a decimal string. */
  amount: string;
  lockTxHash: string;
  /** Unix seconds the lock was created (mirrors the contract's createdAt). */
  createdAt: number;
  timeoutSeconds: number;
  status: EscrowLockStatus;
  sorobanNonce?: string;
  resolutionTxHash?: string;
}

export const DEFAULT_ESCROW_TIMEOUT_SECONDS = 24 * 60 * 60;

export class EscrowLockAlreadyExistsError extends Error {}
export class EscrowLockNotFoundError extends Error {}
export class EscrowLockNotActiveError extends Error {}
export class EscrowNonceReplayError extends Error {}
export class EscrowTimeoutNotElapsedError extends Error {}

const locksById = new Map<string, EscrowLockRecord>();
const consumedSorobanNonces = new Set<string>();

export interface RecordLockInput {
  lockId: string;
  daoId: number;
  proposalId: number;
  depositor: string;
  recipient: string;
  amount: string;
  lockTxHash: string;
  createdAt?: number;
  timeoutSeconds?: number;
}

/** Record a lock a depositor confirmed on-chain. */
export function recordLock(input: RecordLockInput): EscrowLockRecord {
  if (locksById.has(input.lockId)) {
    throw new EscrowLockAlreadyExistsError(
      `lock ${input.lockId} already recorded`,
    );
  }

  const record: EscrowLockRecord = {
    lockId: input.lockId,
    daoId: input.daoId,
    proposalId: input.proposalId,
    depositor: input.depositor,
    recipient: input.recipient,
    amount: input.amount,
    lockTxHash: input.lockTxHash,
    createdAt: input.createdAt ?? Math.floor(Date.now() / 1000),
    timeoutSeconds: input.timeoutSeconds ?? DEFAULT_ESCROW_TIMEOUT_SECONDS,
    status: "locked",
  };
  locksById.set(record.lockId, record);
  return record;
}

export function getLock(lockId: string): EscrowLockRecord | undefined {
  return locksById.get(lockId);
}

export function getLocksForProposal(
  daoId: number,
  proposalId: number,
): EscrowLockRecord[] {
  return [...locksById.values()].filter(
    (l) => l.daoId === daoId && l.proposalId === proposalId,
  );
}

/** Seconds remaining before a locked (non-terminal) record becomes refundable; 0 if already refundable or not locked. */
export function secondsUntilRefundable(
  lockId: string,
  nowMs: number = Date.now(),
): number {
  const l = locksById.get(lockId);
  if (!l || l.status !== "locked") return 0;
  const refundableAt = l.createdAt + l.timeoutSeconds;
  return Math.max(0, refundableAt - Math.floor(nowMs / 1000));
}

export function isRefundable(
  lockId: string,
  nowMs: number = Date.now(),
): boolean {
  return getLock(lockId)?.status === "locked" && secondsUntilRefundable(lockId, nowMs) === 0;
}

function requireActive(lockId: string): EscrowLockRecord {
  const l = locksById.get(lockId);
  if (!l) throw new EscrowLockNotFoundError(`lock ${lockId} not found`);
  if (l.status !== "locked") {
    throw new EscrowLockNotActiveError(
      `lock ${lockId} is not active (status=${l.status})`,
    );
  }
  return l;
}

/**
 * Consume a Soroban finality/cancellation message nonce. Scoped globally
 * (not per-lock), mirroring the contract: the same message can never be
 * replayed against any lock, preventing double-release/double-refund.
 */
function consumeSorobanNonce(sorobanNonce: string): void {
  if (consumedSorobanNonces.has(sorobanNonce)) {
    throw new EscrowNonceReplayError(
      `soroban nonce ${sorobanNonce} already consumed`,
    );
  }
  consumedSorobanNonces.add(sorobanNonce);
}

/** Mark a lock released to its recipient after a finalized Soroban approval. */
export function markReleased(
  lockId: string,
  sorobanNonce: string,
  resolutionTxHash: string,
): EscrowLockRecord {
  const l = requireActive(lockId);
  consumeSorobanNonce(sorobanNonce);
  l.status = "released";
  l.sorobanNonce = sorobanNonce;
  l.resolutionTxHash = resolutionTxHash;
  return l;
}

/** Mark a lock cancelled (early unlock to the depositor) via a Soroban cancellation proof. */
export function markCancelled(
  lockId: string,
  sorobanNonce: string,
  resolutionTxHash: string,
): EscrowLockRecord {
  const l = requireActive(lockId);
  consumeSorobanNonce(sorobanNonce);
  l.status = "cancelled";
  l.sorobanNonce = sorobanNonce;
  l.resolutionTxHash = resolutionTxHash;
  return l;
}

/** Mark a lock refunded to the depositor after the timeout elapsed. */
export function markRefunded(
  lockId: string,
  resolutionTxHash: string,
  nowMs: number = Date.now(),
): EscrowLockRecord {
  const l = requireActive(lockId);
  if (secondsUntilRefundable(lockId, nowMs) > 0) {
    throw new EscrowTimeoutNotElapsedError(
      `lock ${lockId} timeout has not elapsed`,
    );
  }
  l.status = "refunded";
  l.resolutionTxHash = resolutionTxHash;
  return l;
}

/** Test-only: clear in-memory state between test cases. */
export function __resetTreasuryEscrowStoreForTests(): void {
  locksById.clear();
  consumedSorobanNonces.clear();
}
