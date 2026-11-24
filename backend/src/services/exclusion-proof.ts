// @ts-nocheck
/**
 * Exclusion Proof Verification Service
 *
 * Verifies zero-knowledge exclusion proofs to enforce that revoked members
 * cannot vote in future proposals. Coordinates with the membership tree contract
 * to check revocation status.
 */

import { getDb } from "./db.js";
import { log } from "./logger.js";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  verifyExclusionGroth16,
  ExclusionDepthError,
  type SnarkjsProof,
} from "./exclusion-verifier.js";

let _deps: { getDb?: () => DatabaseType; log?: (...args: any[]) => void } | null = null;
export function initExclusionProof(deps: { getDb: () => DatabaseType; log: (...args: any[]) => void }) {
  _deps = deps;
}
function deps() {
  return {
    getDb: _deps?.getDb ?? getDb,
    log: _deps?.log ?? log,
  };
}
let treeContractId: string = "";

/**
 * The `member_revocations` table is created lazily so the revocation-tracking
 * feature works on fresh databases (including test databases) without
 * requiring a migration to have run first. Idempotent and cheap after the
 * first call.
 */
const REVOCATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS member_revocations (
  commitment TEXT NOT NULL,
  dao_id INTEGER NOT NULL,
  revoked_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  reinstated_at INTEGER,
  PRIMARY KEY (commitment, dao_id)
)`;

function ensureRevocationsTable(db: DatabaseType): void {
  db.exec(REVOCATIONS_TABLE_SQL);
}

/** Base shape of a Groth16 proof with arbitrary public inputs. */
export interface Proof {
  proof: {
    a: string;
    b: string;
    c: string;
  };
  publicInputs: Record<string, unknown>;
}

export interface Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol?: string;
  curve?: string;
}

export interface ExclusionProof extends Proof {
  publicInputs: {
    historicalRoot: string;
    currentRoot: string;
    daoId: bigint;
    leafIndex: number;
    commitment: string;
  };
}

export interface RevocationStatus {
  isRevoked: boolean;
  revokedAt?: number;
  reinstatedAt?: number;
  commitment: string;
}

/**
 * Maximum index addressable by the 18-level membership tree used by the
 * current voting circuits (2^18 leaves). Larger deployments require an
 * explicitly versioned exclusion circuit, verification key and tree depth.
 * This is an input-safety limit, NOT a measured proving-performance threshold.
 */
export const MAX_EXCLUSION_REGISTRY_LEAVES = 1 << 18;

export async function verifyExclusionProof(
  proof: ExclusionProof,
  _treeContractId: string,
  /** Merkle depth for the exclusion circuit; 0 means the default depth (18). */
  circuitDepth = 0,
): Promise<{ valid: boolean; reason?: string }> {
  try {
    const { commitment, daoId, leafIndex, historicalRoot, currentRoot } =
      proof.publicInputs;

    // Reject unsupported or malformed indices before DB work or proof
    // dispatch. Never silently wrap, round or truncate a JS number.
    if (
      !Number.isSafeInteger(leafIndex) ||
      leafIndex < 0 ||
      leafIndex >= MAX_EXCLUSION_REGISTRY_LEAVES
    ) {
      return {
        valid: false,
        reason:
          "Exclusion leaf index is outside the supported 18-level registry " +
          "(0..262143); use a versioned larger-depth circuit and verifier.",
      };
    }

    deps().log("info", "exclusion_proof_verification_started", {
      commitment: commitment.slice(0, 10),
      daoId: Number(daoId),
      circuitDepth,
    });

    // ── Groth16 cryptographic verification ───────────────────────────────
    // This is the gate that was previously missing. A forged exclusion proof
    // must be rejected here before any DB work is done (ZV-051 / #899).
    // ExclusionDepthError is a typed error — callers should return 422 to
    // signal a misconfigured election, not 400 (bad proof) or 500.
    const snarkjsProof: SnarkjsProof = {
      pi_a: proof.pi_a,
      pi_b: proof.pi_b,
      pi_c: proof.pi_c,
      protocol: proof.protocol,
      curve: proof.curve,
    };
    try {
      const cryptoResult = await verifyExclusionGroth16(
        snarkjsProof,
        { historicalRoot, currentRoot, daoId, leafIndex, commitment },
        circuitDepth,
      );
      if (!cryptoResult.valid) {
        deps().log("warn", "exclusion_proof_crypto_rejected", {
          commitment: commitment.slice(0, 10),
          reason: cryptoResult.reason,
        });
        return cryptoResult;
      }
    } catch (err) {
      if (err instanceof ExclusionDepthError) {
        deps().log("warn", "exclusion_proof_depth_mismatch", {
          requestedDepth: err.requestedDepth,
          supportedDepths: err.supportedDepths,
        });
        return { valid: false, reason: err.message };
      }
      throw err;
    }
    // ─────────────────────────────────────────────────────────────────────

    // 1. Verify historical proof (was in the tree at some point)
    if (!historicalRoot || historicalRoot.length === 0) {
      return {
        valid: false,
        reason: "Invalid historical root",
      };
    }

    // 2. Verify current proof (is NOT in tree now - zeroed out)
    if (!currentRoot || currentRoot.length === 0) {
      return {
        valid: false,
        reason: "Invalid current root",
      };
    }

    // 3. Check that roots are actually different or proof requires historical data
    if (historicalRoot === currentRoot) {
      deps().log("warn", "exclusion_proof_same_root", {
        commitment: commitment.slice(0, 10),
        root: currentRoot.slice(0, 10),
      });
    }

    // 4. Verify commitment is well-formed (should be valid field element)
    if (!isValidFieldElement(commitment)) {
      return {
        valid: false,
        reason: "Invalid commitment format",
      };
    }

    // 5. Query membership tree for revocation status
    try {
      const revocationStatus = await checkRevocationStatus(
        commitment,
        Number(daoId),
        treeContractId,
      );

      if (!revocationStatus.isRevoked) {
        return {
          valid: false,
          reason: "Member has not been revoked",
        };
      }

      deps().log("info", "exclusion_proof_verified", {
        commitment: commitment.slice(0, 10),
        daoId: Number(daoId),
        revokedAt: revocationStatus.revokedAt,
      });

      return { valid: true };
    } catch (err) {
      deps().log("error", "revocation_status_check_failed", {
        commitment: commitment.slice(0, 10),
        error: (err as Error).message,
      });
      return {
        valid: false,
        reason: "Could not verify revocation status",
      };
    }
    return { valid: true };
  } catch (err) {
    deps().log("error", "exclusion_proof_verification_error", {
      error: (err as Error).message,
    });
    return { valid: false, reason: "Proof verification failed" };
  }
}

/**
 * Check if a member has been revoked via the membership tree contract
 */
async function checkRevocationStatus(
  commitment: string,
  daoId: number,
  _treeContractId: string,
): Promise<RevocationStatus> {
  const db = deps().getDb();
  ensureRevocationsTable(db);

  const row = db
    .prepare(
      `SELECT revoked_at, reinstated_at
       FROM member_revocations
       WHERE commitment = ? AND dao_id = ?`,
    )
    .get(commitment, daoId) as
    | { revoked_at: number; reinstated_at: number | null }
    | undefined;

  if (!row) {
    return {
      isRevoked: false,
      commitment,
    };
  }

  // A reinstated member is back in the tree and must not be able to present
  // an exclusion proof as if still revoked (#566).
  return {
    isRevoked: row.reinstated_at == null,
    revokedAt: row.revoked_at,
    reinstatedAt: row.reinstated_at ?? undefined,
    commitment,
  };
}

function isValidFieldElement(value: string): boolean {
  try {
    const prime = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const num = BigInt(value);
    return num >= 0n && num < prime;
  } catch {
    return false;
  }
}

export async function recordRevocation(
  commitment: string,
  daoId: number,
  timestamp: number,
): Promise<void> {
  const db = deps().getDb();
  ensureRevocationsTable(db);

  try {
    db.prepare(
      `INSERT OR IGNORE INTO member_revocations
         (commitment, dao_id, revoked_at, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(commitment, daoId, timestamp, new Date().toISOString());
  } catch (err) {
    deps().log("error", "revocation_record_failed", {
      commitment: commitment.slice(0, 10),
      error: (err as Error).message,
    });
  }
}

/** One atomic (epoch, root, witness) bundle served to a prover. */
export interface EpochWitnessBundle {
  daoId: number;
  epoch: number;
  root: string;
  advancedAt: number;
  commitment: string;
  pathElements: string[];
  pathIndices: number[];
  fetchedAtLedger: number;
}

/**
 * Minimal chain surface used to build an epoch witness. Injected so the
 * TOCTOU-safe read can be unit-tested and so the relayer can point at either
 * Soroban RPC or a cache.
 */
export interface EpochWitnessSource {
  getLatestLedger(): Promise<number>;
  getEpochInfo(daoId: number): Promise<{
    epoch: number;
    root: string;
    advancedAt: number;
  }>;
  getMerklePath(params: {
    daoId: number;
    commitment: string;
    root: string;
  }): Promise<{ pathElements: string[]; pathIndices: number[] }>;
}

export class EpochWitnessChangedError extends Error {
  constructor(message = "membership root changed while building witness") {
    super(message);
    this.name = "EpochWitnessChangedError";
  }
}

/**
 * Fetch (epoch, root, witness) atomically with respect to epoch rotation.
 *
 * A naive "read root -> read witness -> submit" sequence has a TOCTOU window:
 * the registry can advance between the witness read and submission, letting a
 * revoked member submit a proof anchored at the old epoch. We:
 *   - read epoch/root before and after generating the path,
 *   - require the same epoch, root and ledger snapshot,
 *   - retry a bounded number of times.
 *
 * The voting contract repeats the epoch/root check on-chain; this is the
 * off-chain half of the invariant.
 */
export async function fetchAtomicEpochWitness(
  source: EpochWitnessSource,
  params: {
    daoId: number;
    commitment: string;
    /** Pin a specific epoch; defaults to the current one. */
    epoch?: number;
    maxAttempts?: number;
  },
): Promise<EpochWitnessBundle> {
  const attempts = params.maxAttempts ?? 3;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const ledgerBefore = await source.getLatestLedger();
      const before = await source.getEpochInfo(params.daoId);
      if (params.epoch != null && before.epoch !== params.epoch) {
        throw new EpochWitnessChangedError(
          `requested epoch ${params.epoch}, registry is at ${before.epoch}`,
        );
      }

      const path = await source.getMerklePath({
        daoId: params.daoId,
        commitment: params.commitment,
        root: before.root,
      });

      const ledgerAfter = await source.getLatestLedger();
      const after = await source.getEpochInfo(params.daoId);
      if (
        before.epoch !== after.epoch ||
        before.root !== after.root ||
        ledgerBefore !== ledgerAfter
      ) {
        throw new EpochWitnessChangedError();
      }

      deps().log("info", "epoch_witness_served", {
        daoId: params.daoId,
        epoch: after.epoch,
        root: after.root.slice(0, 12),
        ledger: ledgerAfter,
      });

      return {
        daoId: params.daoId,
        epoch: after.epoch,
        root: after.root,
        advancedAt: after.advancedAt,
        commitment: params.commitment,
        pathElements: path.pathElements,
        pathIndices: path.pathIndices,
        fetchedAtLedger: ledgerAfter,
      };
    } catch (err) {
      lastError = err as Error;
      if (!(err instanceof EpochWitnessChangedError)) throw err;
    }
  }

  throw (
    lastError ?? new EpochWitnessChangedError("could not obtain a stable epoch witness")
  );
}

/**
 * True when a witness is still acceptable under the on-chain grace window.
 * Mirrors `EPOCH_GRACE_SECS` in `contracts/voting/src/lib.rs`.
 */
export function isEpochWithinGrace(
  bundle: Pick<EpochWitnessBundle, "epoch" | "advancedAt">,
  currentEpoch: number,
  currentEpochAdvancedAt: number,
  nowSeconds: number,
  graceSeconds = 300,
): boolean {
  if (bundle.epoch === currentEpoch) return true;
  if (bundle.epoch > currentEpoch) return false;
  return nowSeconds <= currentEpochAdvancedAt + graceSeconds;
}

export async function recordReinstatement(
  commitment: string,
  daoId: number,
  timestamp: number,
): Promise<void> {
  const db = deps().getDb();
  ensureRevocationsTable(db);

  try {
    db.prepare(
      `UPDATE member_revocations
       SET reinstated_at = ?
       WHERE commitment = ? AND dao_id = ?`,
    ).run(timestamp, commitment, daoId);
  } catch (err) {
    deps().log("error", "reinstatement_record_failed", {
      commitment: commitment.slice(0, 10),
      error: (err as Error).message,
    });
  }
}
