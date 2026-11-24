/**
 * Proof generation functions
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
  /**
   * Which loaded manifest key (by circuit name) this proof is generated
   * against. Defaults to 'vote'. Used only to look up the ZV-113
   * registry-compatibility result recorded by loadKeys() - see
   * `assertCircuitReady()`. Proving itself is still mocked below.
   */
  circuitName?: string
}

export interface ClaimProofParams {
  identitySecret: Uint8Array
  daoId: string
  membershipProof: {
    root: string
    siblings: string[]
    pathIndices: number[]
  }
  /** Same purpose as `VoteProofParams.circuitName`. Defaults to 'claim'. */
  circuitName?: string
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
 * Generate a zero-knowledge proof for voting
 */
export async function generateVoteProof(params: VoteProofParams): Promise<Proof> {
  // ZV-113: refuse to prove with a circuit version the registry rejected
  // during loadKeys(). Throws UnsupportedCircuitVersionError if so; a
  // no-op if that circuit was never registry-checked at all.
  assertCircuitReady(params.circuitName ?? 'vote')

  // Validate inputs
  if (!params.identitySecret || params.identitySecret.length !== 32) {
    throw new Error('Identity secret must be 32 bytes')
  }

  if (!params.pollId || !params.choice) {
    throw new Error('Poll ID and choice are required')
  }

  // In production, this would use snarkjs and loaded circuit/keys
  // For now, return a mock structure
  console.log('Generating vote proof for poll:', params.pollId)

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
  assertCircuitReady(params.circuitName ?? 'claim')

  if (!params.identitySecret || params.identitySecret.length !== 32) {
    throw new Error('Identity secret must be 32 bytes')
  }

  if (!params.daoId) {
    throw new Error('DAO ID is required')
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
export async function generateVoteProofInWorker(params: VoteProofParams): Promise<Proof> {
  // Check if workers are available
  if (typeof Worker === 'undefined') {
    return generateVoteProof(params)
  }

  // In production, would spawn worker and communicate
  return generateVoteProof(params)
}
