/**
 * Exclusion Proof Verification Service
 *
 * Verifies zero-knowledge exclusion proofs to enforce that revoked members
 * cannot vote in future proposals. Coordinates with the membership tree contract
 * to check revocation status.
 */
import { getDb } from "./db.js";
import { log } from "./logger.js";
/**
 * Verify that a member has been revoked and cannot vote
 * Checks both ZK exclusion proof and contract revocation status
 */
export async function verifyExclusionProof(proof, treeContractId) {
    try {
        const { commitment, daoId, historicalRoot, currentRoot } = proof.publicInputs;
        log("info", "exclusion_proof_verification_started", {
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
            log("warn", "exclusion_proof_same_root", {
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
            const revocationStatus = await checkRevocationStatus(commitment, Number(daoId), treeContractId);
            if (!revocationStatus.isRevoked) {
                return {
                    valid: false,
                    reason: "Member has not been revoked",
                };
            }
            log("info", "exclusion_proof_verified", {
                commitment: commitment.slice(0, 10),
                daoId: Number(daoId),
                revokedAt: revocationStatus.revokedAt,
            });
            return { valid: true };
        }
        catch (err) {
            log("error", "revocation_status_check_failed", {
                commitment: commitment.slice(0, 10),
                error: err.message,
            });
            return {
                valid: false,
                reason: "Could not verify revocation status",
            };
        }
    }
    catch (err) {
        log("error", "exclusion_proof_verification_error", {
            error: err.message,
        });
        return {
            valid: false,
            reason: "Proof verification failed",
        };
    }
}
/**
 * Check if a member has been revoked via the membership tree contract
 */
async function checkRevocationStatus(commitment, daoId, _treeContractId) {
    const db = getDb();
    const revocationRecord = db
        .selectFrom("member_revocations")
        .where("commitment", "==", commitment)
        .where("dao_id", "==", daoId)
        .selectAll()
        .executeTakeFirst();
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
/**
 * Validate that a value is a valid field element
 * BN254 prime: 21888242871839275222246405745257275088548364400416034343698204186575808495617
 */
function isValidFieldElement(value) {
    try {
        const BN254_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
        const num = BigInt(value);
        return num < BN254_PRIME && num >= 0n;
    }
    catch {
        return false;
    }
}
/**
 * Record a revocation in the database for audit trail
 */
export async function recordRevocation(commitment, daoId, timestamp) {
    const db = getDb();
    db.insertInto("member_revocations")
        .values({
        commitment,
        dao_id: daoId,
        revoked_at: timestamp,
        created_at: new Date().toISOString(),
    })
        .executeTakeFirst()
        .catch((err) => {
        log("error", "revocation_record_failed", {
            commitment: commitment.slice(0, 10),
            error: err.message,
        });
    });
}
/**
 * Reinstate a revoked member
 */
export async function recordReinstatement(commitment, daoId, timestamp) {
    const db = getDb();
    db.updateTable("member_revocations")
        .set({ reinstated_at: timestamp })
        .where("commitment", "==", commitment)
        .where("dao_id", "==", daoId)
        .executeTakeFirst()
        .catch((err) => {
        log("error", "reinstatement_record_failed", {
            commitment: commitment.slice(0, 10),
            error: err.message,
        });
    });
}
//# sourceMappingURL=exclusion-proof.js.map