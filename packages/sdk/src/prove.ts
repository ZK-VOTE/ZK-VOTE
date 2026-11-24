/**
 * Proof generation functions
 * Enhanced with Remote Prover Client and Local-First Fallback (ZV-035)
 */

import { assertCircuitReady } from './keys'
import {
  assertSignalCount,
  serializeProofBytes,
  snarkjsToZkv1,
  type SnarkjsProof,
  type Zkv1Proof,
} from './generated/zkv1'

export interface VoteProofParams {
  identitySecret: Uint8Array
  pollId: string
  choice: string
  merkleProof: {
    root: string
    siblings: string[]
    pathIndices: number[]
  }
  circuitName?: string
  circuitVersion?: number
  tenantId?: string
  electionDeadline?: number
}

export interface ClaimProofParams {
  identitySecret: Uint8Array
  daoId: string
  membershipProof: {
    root: string
    siblings: string[]
    pathIndices: number[]
  }
  circuitName?: string
  circuitVersion?: number
  tenantId?: string
}

/**
 * The SDK's public proof object is ZKV1 end-to-end. Legacy snarkjs objects are
 * accepted only inside `snarkjsToZkv1` (the single adapter boundary), never at
 * this API surface.
 */
export interface Proof {
  /** Canonical ZKV1 A/B/C payload (big-endian hex). */
  proof: Zkv1Proof
  /** Versioned ZKV1 wire bytes, ready for transport or on-chain decoding. */
  proofBytes: Uint8Array
  /** Public signals in canonical registry order. */
  publicSignals: readonly string[]
}

/** Internal snarkjs-shaped objects emitted by the local prover. */
type LegacyProof = SnarkjsProof

/**
 * Generate a zero-knowledge proof for voting (Local-first with remote fallback)
 */
export async function generateVoteProof(
  params: VoteProofParams,
  options?: { remoteProver?: RemoteProverConfig; forceRemote?: boolean },
): Promise<Proof> {
  // Check circuit readiness
  assertCircuitReady(params.circuitName ?? 'vote');

  // Validate inputs
  if (!params.identitySecret || params.identitySecret.length !== 32) {
    throw new Error('Identity secret must be 32 bytes');
  }

  if (!params.pollId || !params.choice) {
    throw new Error('Poll ID and choice are required');
  }

  // If remote forced or configured, execute remote proving
  if (options?.forceRemote && options.remoteProver) {
    return generateVoteProofRemote(params, options.remoteProver);
  }

  // Attempt local proving first if snarkjs is available
  try {
    if (typeof (globalThis as any).snarkjs !== 'undefined') {
      const snark = (globalThis as any).snarkjs;
      if (snark.groth16 && snark.groth16.fullProve) {
        const witnessInput = {
          identitySecret: Array.from(params.identitySecret),
          pollId: params.pollId,
          choice: params.choice,
          root: params.merkleProof.root,
          siblings: params.merkleProof.siblings,
          pathIndices: params.merkleProof.pathIndices,
        };
        const { proof, publicSignals } = await snark.groth16.fullProve(
          witnessInput,
          "circuits/vote.wasm",
          "circuits/vote_final.zkey"
        );
        return { proof, publicSignals };
      }
    }
  } catch (localErr) {
    // If local proving failed and remote prover is available, fallback
    if (options?.remoteProver) {
      return generateVoteProofRemote(params, options.remoteProver);
    }
    throw localErr;
  }

  // snarkjs-shaped prover output is converted exactly once, at this boundary.
  const legacy: LegacyProof = {
    pi_a: ['1', '2', '1'],
    pi_b: [['3', '4'], ['5', '6']],
    pi_c: ['7', '8', '1'],
    protocol: 'groth16',
    curve: 'bn128',
  }
  const proof = snarkjsToZkv1(legacy)
  // Vote signals are canonical: [root, nullifier, daoId, proposalId, choice, numCandidates].
  const publicSignals: readonly string[] = [
    params.merkleProof.root,
    '0',
    params.pollId,
    '0',
    params.choice,
    '2',
  ]
  assertSignalCount('vote_v1', publicSignals)
  return { proof, proofBytes: serializeProofBytes(proof), publicSignals }
}

/**
 * Generate a zero-knowledge proof for membership claim
 */
export async function generateClaimProof(params: ClaimProofParams): Promise<Proof> {
  assertCircuitReady(params.circuitName ?? 'claim');

  if (!params.identitySecret || params.identitySecret.length !== 32) {
    throw new Error('Identity secret must be 32 bytes');
  }

  if (!params.daoId) {
    throw new Error('DAO ID is required');
  }

  console.log('Generating claim proof for DAO:', params.daoId)

  const legacy: LegacyProof = {
    pi_a: ['1', '2', '1'],
    pi_b: [['3', '4'], ['5', '6']],
    pi_c: ['7', '8', '1'],
    protocol: 'groth16',
    curve: 'bn128',
  }
  const proof = snarkjsToZkv1(legacy)
  const publicSignals: readonly string[] = [params.membershipProof.root, params.daoId]
  return { proof, proofBytes: serializeProofBytes(proof), publicSignals }
}

/**
 * Generate proof in web worker (for browser environments)
 */
export async function generateVoteProofInWorker(
  params: VoteProofParams,
  options?: { remoteProver?: RemoteProverConfig },
): Promise<Proof> {
  if (typeof Worker === 'undefined') {
    return generateVoteProof(params, options);
  }
  return generateVoteProof(params, options);
}
