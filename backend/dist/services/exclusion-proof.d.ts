/**
 * Exclusion Proof Verification Service
 *
 * Verifies zero-knowledge exclusion proofs to enforce that revoked members
 * cannot vote in future proposals. Coordinates with the membership tree contract
 * to check revocation status.
 */
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
export declare function verifyExclusionProof(proof: ExclusionProof, _treeContractId: string): Promise<{
    valid: boolean;
    reason?: string;
}>;
export declare function recordRevocation(commitment: string, daoId: number, timestamp: number): Promise<void>;
export declare function recordReinstatement(commitment: string, daoId: number, timestamp: number): Promise<void>;
//# sourceMappingURL=exclusion-proof.d.ts.map