/**
 * Depth-aware circuit artifact resolution (#93).
 *
 * `component main` fixes the Merkle depth at compile time, so each supported
 * depth is a separate compiled circuit living in its own build directory. A
 * proof for a depth-N election is a proof for `Vote(N)` and only verifies
 * against the verification key registered for depth N — picking the wrong
 * artifact produces a proof that is valid for the wrong circuit and is
 * rejected on-chain. This module is the single place that maps a depth to the
 * files that belong to it.
 *
 * The depth set and the default depth mirror
 * `circuits/utils/gen_depth_circuits.js`; the parity test keeps them honest.
 */
/**
 * The depth `vote.circom` itself instantiates. Elections at this depth use the
 * DAO's version-pinned verification key and the unsuffixed build outputs, which
 * is why the contract encodes it as `merkle_depth == 0` rather than `18`.
 */
export declare const DEFAULT_CIRCUIT_DEPTH = 18;
/** Depths compiled as `vote_d<N>.circom` wrappers alongside the default. */
export declare const GENERATED_DEPTHS: readonly [10, 15, 20, 25];
/** Every depth the protocol accepts, including the default circuit. */
export declare const SUPPORTED_DEPTHS: readonly number[];
/** Mirrors `MAX_MERKLE_DEPTH` in the voting contract. */
export declare const MAX_MERKLE_DEPTH = 32;
export declare const MIN_MERKLE_DEPTH = 1;
export interface CircuitArtifacts {
    /** The real tree depth, with the contract's `0` sentinel already resolved. */
    depth: number;
    /** True when this is `vote.circom` rather than a generated depth wrapper. */
    isDefault: boolean;
    wasmPath: string;
    zkeyPath: string;
    vkeyPath: string;
    r1csPath: string;
}
/**
 * Root of the compiled circuit tree. Overridable so a deployment can point at
 * artifacts shipped outside the repo checkout.
 */
export declare function circuitsBuildDir(): string;
/**
 * Resolves the contract's `merkle_depth` field to a real tree depth.
 *
 * The contract stores `0` for "this election uses the default circuit", so that
 * existing elections — written before depths existed — keep verifying against
 * the key they were created with. Callers that need a depth to index artifacts
 * with must go through here rather than trusting the raw field.
 */
export declare function resolveDepth(merkleDepth: number): number;
/**
 * Maps a depth to its compiled artifacts.
 *
 * Accepts the contract's `0` sentinel as well as a real depth. Throws for a
 * depth that is inside the contract's accepted range but has no compiled
 * circuit: that combination means the election was configured against a depth
 * this deployment cannot prove for, and silently falling back to the default
 * circuit would produce proofs that fail on-chain for no stated reason.
 */
export declare function resolveArtifacts(merkleDepth: number): CircuitArtifacts;
/** Which of an election's artifacts are actually present on disk. */
export declare function missingArtifacts(artifacts: CircuitArtifacts): string[];
export declare function invalidateDepthCache(daoId?: number, proposalId?: number): void;
/**
 * Reads an election's declared Merkle depth from the voting contract.
 *
 * Returns the raw contract value (`0` meaning the default circuit) so callers
 * can distinguish "default" from "explicitly depth 18"; pass it through
 * {@link resolveDepth} or {@link resolveArtifacts} to get a usable depth.
 * Returns `null` when the depth cannot be read, so a caller can fall back
 * rather than treat an RPC failure as "default depth".
 */
export declare function getProposalMerkleDepth(daoId: number, proposalId: number): Promise<number | null>;
/**
 * Resolves the artifacts an election's proofs must be generated against,
 * falling back to the default circuit when the depth cannot be read.
 */
export declare function resolveArtifactsForProposal(daoId: number, proposalId: number): Promise<CircuitArtifacts>;
//# sourceMappingURL=circuit-artifacts.d.ts.map