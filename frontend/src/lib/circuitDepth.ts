/**
 * Per-depth circuit artifact selection in the browser (#93).
 *
 * Merkle depth is fixed at compile time by `component main`, so each supported
 * depth is a separate compiled circuit with its own WASM, proving key and
 * verification key. A proof for a depth-N election is a proof for `Vote(N)`
 * and verifies only against the key registered on-chain for depth N, so
 * loading the wrong artifact yields a proof that is rejected with no useful
 * error. This module is the one place that maps a depth to its URLs.
 *
 * Kept in step with `circuits/utils/gen_depth_circuits.js` and the backend's
 * `circuit-artifacts.ts`; the tests assert the constants still agree.
 */

/**
 * The depth `vote.circom` instantiates. The voting contract stores `0` for
 * "this election uses the default circuit", which is why the sentinel and the
 * real depth are different numbers.
 */
export const DEFAULT_CIRCUIT_DEPTH = 18;

/** Depths compiled as `vote_d<N>.circom` wrappers alongside the default. */
export const GENERATED_DEPTHS = [10, 15, 20, 25] as const;

/** Every depth the protocol accepts, including the default circuit. */
export const SUPPORTED_DEPTHS: readonly number[] = [
  ...GENERATED_DEPTHS,
  DEFAULT_CIRCUIT_DEPTH,
].sort((a, b) => a - b);

/** Mirrors `MAX_MERKLE_DEPTH` in the voting contract. */
export const MAX_MERKLE_DEPTH = 32;

export interface CircuitArtifactUrls {
  /** The real tree depth, with the contract's `0` sentinel resolved. */
  depth: number;
  /** True when this is `vote.circom` rather than a generated depth wrapper. */
  isDefault: boolean;
  wasmUrl: string;
  zkeyUrl: string;
  vkeyUrl: string;
}

/** Resolves the contract's `merkle_depth` field to a real tree depth. */
export function resolveDepth(merkleDepth: number): number {
  if (!Number.isInteger(merkleDepth) || merkleDepth < 0) {
    throw new Error(
      `merkle_depth must be a non-negative integer, got ${merkleDepth}`,
    );
  }
  if (merkleDepth === 0) return DEFAULT_CIRCUIT_DEPTH;
  if (merkleDepth > MAX_MERKLE_DEPTH) {
    throw new Error(
      `merkle_depth ${merkleDepth} exceeds the maximum of ${MAX_MERKLE_DEPTH}`,
    );
  }
  return merkleDepth;
}

/**
 * Maps a depth to the URLs its artifacts are served from.
 *
 * Accepts the contract's `0` sentinel as well as a real depth. A depth the
 * contract would allow but that was never compiled throws rather than falling
 * back to the default circuit: proving against the wrong circuit wastes the
 * voter's time and fails on-chain without saying why.
 */
export function resolveCircuitUrls(merkleDepth: number): CircuitArtifactUrls {
  const depth = resolveDepth(merkleDepth);

  if (depth === DEFAULT_CIRCUIT_DEPTH) {
    return {
      depth,
      isDefault: true,
      wasmUrl: "/circuits/vote.wasm",
      zkeyUrl: "/circuits/vote_final.zkey",
      vkeyUrl: "/circuits/verification_key.json",
    };
  }

  if (!SUPPORTED_DEPTHS.includes(depth)) {
    throw new Error(
      `no circuit compiled for Merkle depth ${depth} ` +
        `(compiled depths: ${SUPPORTED_DEPTHS.join(", ")})`,
    );
  }

  const dir = `/circuits/depth_${depth}`;
  return {
    depth,
    isDefault: false,
    wasmUrl: `${dir}/vote_d${depth}.wasm`,
    zkeyUrl: `${dir}/vote_d${depth}_final.zkey`,
    vkeyUrl: `${dir}/verification_key.json`,
  };
}

/**
 * The smallest compiled depth that can hold `memberCount` members.
 *
 * Proving cost is dominated by the Merkle path, so an election should use the
 * shallowest tree that fits rather than the default depth — that is the whole
 * point of compiling several. Returns the largest supported depth when no
 * compiled depth is big enough, leaving the capacity check to the caller.
 */
export function smallestDepthFor(memberCount: number): number {
  if (!Number.isInteger(memberCount) || memberCount < 0) {
    throw new Error(`memberCount must be a non-negative integer, got ${memberCount}`);
  }
  for (const depth of SUPPORTED_DEPTHS) {
    if (memberCount <= 2 ** depth) return depth;
  }
  return SUPPORTED_DEPTHS[SUPPORTED_DEPTHS.length - 1];
}
