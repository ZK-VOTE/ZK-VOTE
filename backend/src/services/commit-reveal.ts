/**
 * Commit–reveal membership registration (anti-front-running).
 *
 * Problem: `register_with_caller(dao_id, commitment, caller)` publishes the
 * final Poseidon commitment in the mempool. An observer can front-run the
 * registration, either consuming the commitment (griefing) or linking it to a
 * later nullifier by timing. Hiding the commitment until the reveal ledger
 * removes both opportunities.
 *
 * Protocol:
 *   1. Client samples `salt` (32 random bytes) and computes
 *        commitHash = SHA256(commitment_be32 || salt)
 *      where `commitment` is the same Poseidon leaf used by the tree.
 *   2. `commit_registration(daoId, commitHash, caller)` is submitted.
 *   3. Wait at least one ledger (`MIN_REVEAL_DELAY_LEDGERS`).
 *   4. `reveal_registration(daoId, commitment, salt, caller)` publishes the
 *      preimage. The tree verifies SHA256 and performs the normal insertion.
 *
 * The salt is generated client-side and is never sent to the relayer before the
 * reveal. This module is the canonical implementation used by routes and tests;
 * the frontend mirrors `computeCommitmentHash` in `frontend/src/lib/client.ts`.
 */

import { createHash, randomBytes } from "node:crypto";

export const MIN_REVEAL_DELAY_LEDGERS = 1;
/** Commitments older than this are considered abandoned and may be replaced. */
export const MAX_REVEAL_WINDOW_LEDGERS = 720; // ~1 hour at 5s ledgers

export interface CommitRegistrationRequest {
  daoId: number;
  commitment: string;
  caller: string;
}

export interface CommitRegistrationResult {
  commitHash: string;
  salt: string;
  committedAtLedger: number;
}

export interface RevealRegistrationResult {
  commitment: string;
  revealedAtLedger: number;
  txHash?: string;
}

/**
 * Submission surface implemented by the relayer/contract client. Keeping this
 * injected makes the timing rules testable without a ledger.
 */
export interface CommitRevealChain {
  getLatestLedger(): Promise<number>;
  submitCommit(params: {
    daoId: number;
    commitHash: string;
    caller: string;
  }): Promise<{ txHash?: string; ledger: number }>;
  submitReveal(params: {
    daoId: number;
    commitment: string;
    salt: string;
    caller: string;
  }): Promise<{ txHash?: string; ledger: number }>;
}

export class CommitRevealError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_COMMITMENT"
      | "INVALID_SALT"
      | "REVEAL_TOO_EARLY"
      | "REVEAL_WINDOW_EXPIRED"
      | "COMMITMENT_MISMATCH",
  ) {
    super(message);
    this.name = "CommitRevealError";
  }
}

function assertFieldElement(value: string, label: string): void {
  const prime =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new CommitRevealError(`${label} is not an integer`, "INVALID_COMMITMENT");
  }
  if (parsed < 0n || parsed >= prime) {
    throw new CommitRevealError(`${label} is outside the BN254 field`, "INVALID_COMMITMENT");
  }
}

function normalizeHex32(value: string, label: string): string {
  const clean = value.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new CommitRevealError(`${label} must be 32 bytes of hex`, "INVALID_SALT");
  }
  return clean;
}

/** Fresh 32-byte salt. The salt is the only secret needed at reveal time. */
export function generateRegistrationSalt(): string {
  return randomBytes(32).toString("hex");
}

/**
 * SHA256(commitment_be32 || salt). Must match
 * `MembershipTree::hash_registration` byte-for-byte.
 */
export function computeCommitmentHash(commitment: string, salt: string): string {
  assertFieldElement(commitment, "commitment");
  const normalizedSalt = normalizeHex32(salt, "salt");
  const commitmentBytes = Buffer.from(
    BigInt(commitment).toString(16).padStart(64, "0"),
    "hex",
  );
  const saltBytes = Buffer.from(normalizedSalt, "hex");
  return createHash("sha256")
    .update(Buffer.concat([commitmentBytes, saltBytes]))
    .digest("hex");
}

/**
 * Phase 1. The caller should retain `salt` locally (or in an encrypted
 * client-side store) until reveal. It must not be logged.
 */
export async function commitRegistration(
  chain: CommitRevealChain,
  request: CommitRegistrationRequest,
): Promise<CommitRegistrationResult> {
  assertFieldElement(request.commitment, "commitment");
  const salt = generateRegistrationSalt();
  const commitHash = computeCommitmentHash(request.commitment, salt);

  const result = await chain.submitCommit({
    daoId: request.daoId,
    commitHash,
    caller: request.caller,
  });

  return { commitHash, salt, committedAtLedger: result.ledger };
}

/**
 * Phase 2. Enforces the one-ledger delay locally so the user gets a clear
 * error instead of an opaque contract trap. The contract remains authoritative
 * and repeats the check on-chain.
 */
export async function revealRegistration(
  chain: CommitRevealChain,
  params: {
    daoId: number;
    commitment: string;
    salt: string;
    caller: string;
    committedAtLedger: number;
    /** Optional local copy of phase-1 hash for an early mismatch error. */
    commitHash?: string;
  },
): Promise<RevealRegistrationResult> {
  const expected = computeCommitmentHash(params.commitment, params.salt);
  if (
    params.commitHash &&
    params.commitHash.replace(/^0x/, "").toLowerCase() !== expected
  ) {
    throw new CommitRevealError(
      "commitment/salt do not match the committed hash",
      "COMMITMENT_MISMATCH",
    );
  }
  const latest = await chain.getLatestLedger();

  if (latest < params.committedAtLedger + MIN_REVEAL_DELAY_LEDGERS) {
    throw new CommitRevealError(
      `reveal requires ledger >= ${params.committedAtLedger + MIN_REVEAL_DELAY_LEDGERS}`,
      "REVEAL_TOO_EARLY",
    );
  }
  if (latest > params.committedAtLedger + MAX_REVEAL_WINDOW_LEDGERS) {
    throw new CommitRevealError(
      "commitment reveal window expired; commit again",
      "REVEAL_WINDOW_EXPIRED",
    );
  }

  const result = await chain.submitReveal({
    daoId: params.daoId,
    commitment: params.commitment,
    salt: params.salt,
    caller: params.caller,
  });
  return {
    commitment: params.commitment,
    revealedAtLedger: result.ledger,
    txHash: result.txHash,
  };
}
