/**
 * Proof verification functions
 */

import type { Proof } from './prove'
import { groth16 } from 'snarkjs'
import type { VerificationKey } from './types'

export interface TallyVerifyParams {
  proof: Proof
  expectedResult: {
    totalVotes: number
    results: Record<string, number>
  }
  merkleRoot: string
  /** The exact Groth16 verification key for this circuit/election. */
  verificationKey: VerificationKey
  /** Optional canonical public-signal encoding supplied by the election manifest. */
  expectedSignals?: string[]
}

/**
 * Verify a tally proof
 */
export async function verifyTally(params: TallyVerifyParams): Promise<boolean> {
  if (!params.proof || !params.proof.publicSignals || !params.verificationKey) return false
  if (!params.expectedResult || !params.merkleRoot) return false

  // Never accept a proof merely because it has the right shape. The caller must
  // provide the election's pinned VK, and snarkjs performs the pairing check.
  if (params.expectedSignals && !sameSignals(params.proof.publicSignals, params.expectedSignals)) {
    return false
  }

  try {
    return await groth16.verify(
      params.verificationKey,
      params.proof.publicSignals,
      params.proof.proof,
    )
  } catch {
    return false
  }
}

/**
 * Verify a vote proof
 */
export async function verifyVoteProof(
  proof: Proof,
  expectedSignals: string[],
  verificationKey: VerificationKey,
): Promise<boolean> {
  if (!proof || !proof.publicSignals || !verificationKey) return false
  if (!sameSignals(proof.publicSignals, expectedSignals)) return false

  try {
    return await groth16.verify(verificationKey, proof.publicSignals, proof.proof)
  } catch {
    return false
  }
}

function sameSignals(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((signal, i) => signal === expected[i])
}
