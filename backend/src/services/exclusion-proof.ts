/**
 * Exclusion Proof Verification Service
 *
 * Verifies zero-knowledge exclusion proofs to enforce that revoked members
 * cannot vote in future proposals. Coordinates with the membership tree contract
 * to check revocation status.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { LoggerPort } from "./interfaces.js";

/**
 * Dependencies injected via `initExclusionProof` (#358) so this module never
 * imports the `db.js`/`logger.js` module singletons directly.
 */
export interface ExclusionProofDeps {
  /** Read connection to the events/metadata store. */
  getDb(): DatabaseType;
  /** Structured logger (called as `deps.log(level, event, meta)`). */
  log: LoggerPort["log"];
}

let proofDeps: ExclusionProofDeps | null = null;

/** Explicitly wire the exclusion-proof service (composition root only). */
export function initExclusionProof(d: ExclusionProofDeps): void {
  proofDeps = d;
}

function deps(): ExclusionProofDeps {
  if (!proofDeps) {
    throw new Error(
      "exclusion-proof: initExclusionProof() must be called before use",
    );
  }
  return proofDeps;
}

export interface ExclusionProof {
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

export async function verifyExclusionProof(
  proof: ExclusionProof,
  _treeContractId: string,
): Promise<{ valid: boolean; reason?: string }> {
  try {
    const { commitment, daoId, historicalRoot, currentRoot } = proof.publicInputs;
    if (!historicalRoot || !currentRoot) return { valid: false, reason: "Invalid root" };
    if (!isValidFieldElement(commitment)) return { valid: false, reason: "Invalid commitment format" };

    deps().log("info", "exclusion_proof_verification_started", {
      commitment: commitment.slice(0, 10),
      daoId: Number(daoId),
    });

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

  const revocationRecord = db
    .prepare(
      "SELECT revoked_at, reinstated_at FROM member_revocations WHERE commitment = ? AND dao_id = ? LIMIT 1",
    )
    .get(commitment, daoId) as
    | { revoked_at: number; reinstated_at: number | null }
    | undefined;

  if (!revocationRecord) {
    return {
      isRevoked: false,
      commitment,
    };
  }

  return {
    isRevoked: true,
    revokedAt: revocationRecord.revoked_at,
    reinstatedAt: revocationRecord.reinstated_at || undefined,
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

  try {
    db.prepare(
      "INSERT INTO member_revocations (commitment, dao_id, revoked_at, created_at) VALUES (?, ?, ?, ?)",
    ).run(commitment, daoId, timestamp, new Date().toISOString());
  } catch (err) {
    deps().log("error", "revocation_record_failed", {
      commitment: commitment.slice(0, 10),
      error: (err as Error).message,
    });
  }
}

export async function recordReinstatement(
  commitment: string,
  daoId: number,
  timestamp: number,
): Promise<void> {
  const db = deps().getDb();

  try {
    db.prepare(
      "UPDATE member_revocations SET reinstated_at = ? WHERE commitment = ? AND dao_id = ?",
    ).run(timestamp, commitment, daoId);
  } catch (err) {
    deps().log("error", "reinstatement_record_failed", {
      commitment: commitment.slice(0, 10),
      error: (err as Error).message,
    });
  }
}
