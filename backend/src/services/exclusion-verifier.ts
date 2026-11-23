/**
 * Real Groth16 verifier for depth-versioned exclusion-proof circuits (ZV-051 / #899).
 *
 * Previously `verifyExclusionProof` only checked public-input shapes and queried
 * the relayer-side revocation DB; it never invoked the Groth16 verifier, so a
 * forged exclusion proof would pass as long as the commitment was in the DB. This
 * module adds the missing cryptographic gate.
 *
 * Design decisions
 * ----------------
 * - Depth resolution mirrors `circuit-artifacts.ts` so the two stay in sync.
 *   The exclusion circuit is compiled at the same depths as the vote circuit
 *   because both use the same `MerkleProofV(levels)` template.
 * - `ExclusionDepthError` is a typed subclass so callers can distinguish a
 *   depth-mismatch (operator error / misconfigured election) from a bad proof
 *   (adversarial input) and return different HTTP status codes / log different
 *   alert levels.
 * - VK files are loaded from disk on first use and memoised per depth. The memo
 *   is invalidated by `clearVkCache()` (useful in tests and after a re-ceremony).
 * - When the VK file is absent (depth compiled but not deployed, test env) the
 *   function throws an `ExclusionDepthError` rather than silently skipping
 *   verification — the caller must decide the fallback, not this module.
 */

import fs from "fs";
import path from "path";
import { groth16 } from "snarkjs";
import {
  circuitsBuildDir,
  DEFAULT_CIRCUIT_DEPTH,
  SUPPORTED_DEPTHS,
  resolveDepth,
} from "./circuit-artifacts.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export class ExclusionDepthError extends Error {
  constructor(
    public readonly requestedDepth: number,
    public readonly supportedDepths: readonly number[],
    message?: string,
  ) {
    super(
      message ??
        `exclusion circuit not available for depth ${requestedDepth}; ` +
          `supported depths: ${supportedDepths.join(", ")}`,
    );
    this.name = "ExclusionDepthError";
  }
}

/** Groth16 proof in the shape snarkjs expects. */
export interface SnarkjsProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol?: string;
  curve?: string;
}

/** Public signals for the exclusion circuit (matches the circom template). */
export interface ExclusionPublicSignals {
  historicalRoot: string;
  currentRoot: string;
  daoId: string | bigint;
  leafIndex: string | number;
  commitment: string;
}

// ---------------------------------------------------------------------------
// VK resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the exclusion-circuit VK path for a given Merkle depth.
 *
 * Layout on disk (matches gen_depth_circuits.js output convention):
 *   <build>/exclusion_proof_vkey.json              (depth 18, default)
 *   <build>/depth_<N>/exclusion_proof_vkey.json    (other depths)
 *
 * Throws `ExclusionDepthError` for depths with no compiled circuit.
 */
export function resolveExclusionVkPath(merkleDepth: number): string {
  const depth = resolveDepth(merkleDepth);
  const base = circuitsBuildDir();

  if (!SUPPORTED_DEPTHS.includes(depth)) {
    throw new ExclusionDepthError(depth, SUPPORTED_DEPTHS);
  }

  if (depth === DEFAULT_CIRCUIT_DEPTH) {
    return path.join(base, "exclusion_proof_vkey.json");
  }

  return path.join(base, `depth_${depth}`, "exclusion_proof_vkey.json");
}

/** In-process cache: depth → parsed VK object. Cleared by `clearVkCache()`. */
const vkCache = new Map<number, unknown>();

/** Evict the in-process VK cache (call after a re-ceremony or in tests). */
export function clearVkCache(): void {
  vkCache.clear();
}

function loadVk(merkleDepth: number): unknown {
  const depth = resolveDepth(merkleDepth);
  if (vkCache.has(depth)) return vkCache.get(depth);

  const vkPath = resolveExclusionVkPath(merkleDepth);
  if (!fs.existsSync(vkPath)) {
    throw new ExclusionDepthError(
      depth,
      SUPPORTED_DEPTHS,
      `exclusion VK file not found at ${vkPath}; ` +
        `run the ceremony for depth ${depth} or set CIRCUITS_BUILD_DIR`,
    );
  }

  const vk = JSON.parse(fs.readFileSync(vkPath, "utf8")) as unknown;
  vkCache.set(depth, vk);
  return vk;
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

/**
 * Cryptographically verify an exclusion proof using the depth-appropriate VK.
 *
 * Returns `{ valid: true }` on success. Returns `{ valid: false, reason }` for
 * a proof that fails Groth16 verification. Throws `ExclusionDepthError` when
 * no compiled circuit exists for the requested depth — the caller must reject
 * the submission before any proving work is done.
 *
 * Order of checks:
 *   1. Depth supported — `ExclusionDepthError` if not (never reach the prover).
 *   2. VK file present — `ExclusionDepthError` if missing (deployment issue).
 *   3. snarkjs.groth16.verify — returns `{ valid: false }` on mismatch.
 *
 * The DB revocation check in `verifyExclusionProof` runs AFTER this function
 * succeeds so that a forged proof is never able to advance past the
 * cryptographic gate regardless of what the DB contains.
 */
export async function verifyExclusionGroth16(
  proof: SnarkjsProof,
  publicSignals: ExclusionPublicSignals,
  merkleDepth: number,
): Promise<{ valid: boolean; reason?: string }> {
  // Throws ExclusionDepthError for unsupported/missing depth — propagates to
  // the caller so it can be turned into a 400/422 before any DB work.
  const vk = loadVk(merkleDepth);

  // snarkjs expects public signals as an ordered string array matching the
  // circom `signal input` / `signal output` declaration order.
  // ExclusionProof public order: [historicalRoot, currentRoot, daoId, leafIndex, commitment]
  const signals: string[] = [
    String(publicSignals.historicalRoot),
    String(publicSignals.currentRoot),
    String(publicSignals.daoId),
    String(publicSignals.leafIndex),
    String(publicSignals.commitment),
  ];

  let isValid: boolean;
  try {
    isValid = await groth16.verify(vk, signals, proof);
  } catch (err) {
    return {
      valid: false,
      reason: `Groth16 verifier threw: ${(err as Error).message}`,
    };
  }

  if (!isValid) {
    return {
      valid: false,
      reason: "Exclusion proof failed Groth16 verification",
    };
  }

  return { valid: true };
}
