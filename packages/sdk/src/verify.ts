/**
 * Proof verification functions.
 *
 * Verification is performed with `snarkjs.groth16.verify` against an explicit
 * verification key (passed by the caller, pinned once with
 * `setPinnedVerificationKey()`, or loaded from a verified key manifest). There
 * is no unconditional success path.
 */

import type { Proof } from './prove'
import { groth16 } from 'snarkjs'
import { areKeysLoaded, getVerificationKey } from './keys'
import type { VerificationKey } from './types'
import { InvalidInputError, VerificationError } from './types'

export interface TallyVerifyParams {
  proof: Proof
  expectedResult: {
    totalVotes: number
    results: Record<string, number>
  }
  merkleRoot: string
  /**
   * The exact Groth16 verification key for this circuit/election.
   * Optional for callers that pin a key with `setPinnedVerificationKey()` or
   * load one via `loadKeys()`; passing it explicitly keeps upstream's
   * (direct-key) call style working.
   */
  verificationKey?: VerificationKey
  /** Optional canonical public-signal encoding supplied by the election manifest. */
  expectedSignals?: string[]
}

export interface VerifyOptions {
  /** Verification key to use. Overrides the pinned / loaded key. */
  vk?: VerificationKey
  /** Circuit name used to look up a loaded verification key. */
  circuitName?: string
}

let pinnedVerificationKey: VerificationKey | undefined

/** Pin the verification key used by verification calls that omit `options.vk`. */
export function setPinnedVerificationKey(vk: VerificationKey): void {
  pinnedVerificationKey = assertVerificationKey(vk)
}

/** Return the process-wide pinned verification key, if one was configured. */
export function getPinnedVerificationKey(): VerificationKey | undefined {
  return pinnedVerificationKey
}

function assertVerificationKey(vk: unknown): VerificationKey {
  if (!vk || typeof vk !== 'object') throw new VerificationError('Verification key is missing')
  const key = vk as VerificationKey
  if (key.protocol !== 'groth16') {
    throw new VerificationError('Unsupported proof/verification-key protocol', { protocol: key.protocol })
  }
  if (key.curve !== 'bn128') {
    throw new VerificationError('Unsupported curve', { curve: key.curve })
  }
  if (!Array.isArray(key.IC) || typeof key.nPublic !== 'number' || key.IC.length !== key.nPublic + 1) {
    throw new VerificationError('Verification key IC vector length does not match nPublic', {
      nPublic: key.nPublic,
      icLength: Array.isArray(key.IC) ? key.IC.length : null
    })
  }
  return key
}

function isVerificationKey(value: unknown): value is VerificationKey {
  return !!value && typeof value === 'object' && ('nPublic' in value || 'IC' in value)
}

function assertProofShape(proof: Proof): void {
  if (!proof || typeof proof !== 'object') throw new VerificationError('Proof is missing')
  const p = proof.proof
  if (!p || typeof p !== 'object') throw new VerificationError('Proof body is missing')
  if (p.protocol !== 'groth16') {
    throw new VerificationError('Wrong protocol: expected groth16', { protocol: p.protocol })
  }
  if (p.curve !== 'bn128') {
    throw new VerificationError('Wrong curve: expected bn128', { curve: p.curve })
  }
  const isCoord = (v: unknown) => typeof v === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v)
  if (
    !Array.isArray(p.pi_a) || p.pi_a.length !== 3 || !p.pi_a.every(isCoord) ||
    !Array.isArray(p.pi_c) || p.pi_c.length !== 3 || !p.pi_c.every(isCoord) ||
    !Array.isArray(p.pi_b) || p.pi_b.length !== 3 ||
    !p.pi_b.every((point) => Array.isArray(point) && point.length === 2 && point.every(isCoord))
  ) {
    throw new VerificationError('Malformed proof point coordinates')
  }
  if (!Array.isArray(proof.publicSignals) || !proof.publicSignals.every(isCoord)) {
    throw new VerificationError('Malformed public signals')
  }
}

function resolveVerificationKey(options: VerifyOptions): VerificationKey {
  if (options.vk) return assertVerificationKey(options.vk)
  if (pinnedVerificationKey) return pinnedVerificationKey
  if (areKeysLoaded()) return assertVerificationKey(getVerificationKey(options.circuitName ?? 'vote'))
  throw new VerificationError(
    'No verification key available: pass options.vk, call setPinnedVerificationKey(), or loadKeys() first.'
  )
}

function sameSignals(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((signal, i) => signal === expected[i])
}

/**
 * Verify a proof against a specific verification key.
 * Returns `false` for cryptographically invalid proofs, wrong public signals,
 * wrong keys and malformed curve points; throws `VerificationError` for a
 * structurally invalid proof or key.
 */
export async function verifyProofWithKey(
  proof: Proof,
  publicSignals: string[],
  vk: VerificationKey
): Promise<boolean> {
  assertProofShape(proof)
  assertVerificationKey(vk)
  if (!Array.isArray(publicSignals) || publicSignals.length !== vk.nPublic) {
    return false
  }
  if (!publicSignals.every((s) => typeof s === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(s))) {
    return false
  }

  try {
    // Verify exactly the signals supplied by the caller, not the ones carried
    // inside the proof object; callers bind the proof to expected values.
    return (await groth16.verify(vk, publicSignals, proof.proof)) === true
  } catch {
    // snarkjs throws on out-of-field or non-curve coordinates; those are simply
    // invalid proofs from the SDK's point of view.
    return false
  }
}

/**
 * Verify a vote proof. Public signals must match `expectedSignals` exactly and
 * the proof must verify against a Groth16 verification key.
 *
 * The third argument accepts either an explicit `VerificationKey` (upstream's
 * call style) or `VerifyOptions` (pinned/loaded key, circuitName). Boolean
 * verification APIs report an unusable key/malformed proof as `false`;
 * `verifyProofWithKey()` is the lower-level API that throws typed errors.
 */
export async function verifyVoteProof(
  proof: Proof,
  expectedSignals: string[],
  verificationKeyOrOptions?: VerificationKey | VerifyOptions
): Promise<boolean> {
  const directKey = isVerificationKey(verificationKeyOrOptions)
  const options: VerifyOptions = directKey
    ? { vk: verificationKeyOrOptions as VerificationKey }
    : (verificationKeyOrOptions as VerifyOptions | undefined) ?? {}

  if (!proof || !Array.isArray(proof.publicSignals) || !Array.isArray(expectedSignals)) return false
  if (proof.publicSignals.length !== expectedSignals.length) return false
  // Keep the direct-key caller's exact-string contract from upstream.
  if (directKey && !sameSignals(proof.publicSignals, expectedSignals)) return false

  let expected: string[]
  try {
    expected = expectedSignals.map((s) => {
      if (typeof s !== 'string' || !/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(s.trim())) {
        throw new InvalidInputError('Expected public signals must be decimal or 0x-hex field elements')
      }
      // Normalise to decimal so hex/decimal spellings compare equal.
      return BigInt(s.trim()).toString()
    })
  } catch (err) {
    if (err instanceof InvalidInputError) throw err
    return false
  }

  let vk: VerificationKey
  try {
    vk = resolveVerificationKey(options)
  } catch (err) {
    if (err instanceof VerificationError) return false
    throw err
  }
  if (expected.length !== vk.nPublic) return false

  try {
    return await verifyProofWithKey(proof, expected, vk)
  } catch (err) {
    if (err instanceof VerificationError) return false
    throw err
  }
}

/**
 * Verify a tally proof. The proof is checked cryptographically, then the
 * expected Merkle root is required to appear among its public signals. An
 * optional `expectedSignals` list is checked exactly, as in upstream's API.
 *
 * `params.verificationKey` (upstream) and the `options` argument (pinned /
 * loaded key) are both supported; the explicit key takes precedence.
 */
export async function verifyTally(params: TallyVerifyParams, options: VerifyOptions = {}): Promise<boolean> {
  if (!params?.proof || !params.proof.publicSignals || !params.expectedResult || !params.merkleRoot) {
    return false
  }
  if (!Number.isSafeInteger(params.expectedResult.totalVotes) || params.expectedResult.totalVotes < 0) {
    return false
  }
  if (!params.expectedResult.results || typeof params.expectedResult.results !== 'object') return false
  if (params.expectedSignals && !sameSignals(params.proof.publicSignals, params.expectedSignals)) {
    return false
  }

  let vk: VerificationKey
  try {
    vk = params.verificationKey
      ? assertVerificationKey(params.verificationKey)
      : resolveVerificationKey(options)
  } catch (err) {
    if (err instanceof VerificationError) return false
    throw err
  }

  let valid: boolean
  try {
    valid = await verifyProofWithKey(params.proof, params.proof.publicSignals, vk)
  } catch (err) {
    if (err instanceof VerificationError) return false
    throw err
  }
  if (!valid) return false

  try {
    const expectedRoot = BigInt(params.merkleRoot.trim()).toString()
    return params.proof.publicSignals.some((s) => BigInt(s.trim()).toString() === expectedRoot)
  } catch {
    return false
  }
}
