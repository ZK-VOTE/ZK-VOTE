/**
 * Proof generation functions
 */

import { assertCircuitReady } from './keys'

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

export interface Proof {
  proof: {
    pi_a: string[]
    pi_b: string[][]
    pi_c: string[]
    protocol: string
    curve: string
  }
  publicSignals: string[]
}

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

  return {
    proof: {
      pi_a: ['0x...', '0x...', '0x1'],
      pi_b: [['0x...', '0x...'], ['0x...', '0x...'], ['0x1', '0x0']],
      pi_c: ['0x...', '0x...', '0x1'],
      protocol: 'groth16',
      curve: 'bn128'
    },
    publicSignals: [
      params.pollId,
      params.choice,
      params.merkleProof.root
    ]
  }
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

  return {
    proof: {
      pi_a: ['0x...', '0x...', '0x1'],
      pi_b: [['0x...', '0x...'], ['0x...', '0x...'], ['0x1', '0x0']],
      pi_c: ['0x...', '0x...', '0x1'],
      protocol: 'groth16',
      curve: 'bn128'
    },
    publicSignals: [
      params.daoId,
      params.membershipProof.root
    ]
  }
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
