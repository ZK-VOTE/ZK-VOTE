/**
 * Exclusion Proof Verification Service
 *
 * Verifies zero-knowledge exclusion proofs to enforce that revoked members
 * cannot vote in future proposals. Coordinates with the membership tree contract
 * to check revocation status.
 */
import { Proof } from "./proof-system.js";
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
 * Verify that a member has been revoked and cannot vote
 * Checks both ZK exclusion proof and contract revocation status
 */
export declare function verifyExclusionProof(proof: ExclusionProof, treeContractId: string): Promise<{
    valid: boolean;
    reason?: string;
}>;
/**
 * Record a revocation in the database for audit trail
 */
export declare function recordRevocation(commitment: string, daoId: number, timestamp: number): Promise<void>;
/**
 * Reinstate a revoked member
 */
export declare function recordReinstatement(commitment: string, daoId: number, timestamp: number): Promise<void>;
//# sourceMappingURL=exclusion-proof.d.ts.map