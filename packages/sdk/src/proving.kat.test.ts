import { beforeAll, describe, expect, it } from 'vitest'
import {
  FIXTURE_PROOF,
  FIXTURE_PUBLIC_SIGNALS,
  FIXTURE_VKEY,
  FIXTURE_WASM_BASE64,
  FIXTURE_ZKEY_BASE64
} from './test-fixture'
import { proveWithArtifacts, buildVoteCircuitInputs } from './prove'
import { verifyProofWithKey, verifyVoteProof, setPinnedVerificationKey } from './verify'
import { resetKeys, type CircuitArtifacts } from './keys'
import type { Proof } from './prove'
import type { VerificationKey } from './types'
import { VerificationError, AbortError } from './types'

// snarkjs spawns worker threads by default; import it first, then pre-seed the
// curve cache with a single-threaded BN128 curve so proving stays deterministic
// inside the vitest runtime (vitest loads a separate ffjavascript module copy).
// @ts-ignore - snarkjs ships no TypeScript declarations
await import('snarkjs')
// @ts-ignore - ffjavascript ships no TypeScript declarations
const ffjavascript = await import('ffjavascript')
// @ts-ignore - internal global used by ffjavascript's curve cache
globalThis.curve_bn128 = await ffjavascript.buildBn128(true)

describe('Groth16 known-answer tests (committed tiny-circuit fixture)', () => {
  let artifacts: CircuitArtifacts
  let proof: Proof
  let publicSignals: string[]

  beforeAll(async () => {
    artifacts = {
      wasm: new Uint8Array(Buffer.from(FIXTURE_WASM_BASE64, 'base64')),
      zkey: new Uint8Array(Buffer.from(FIXTURE_ZKEY_BASE64, 'base64')),
      vkey: FIXTURE_VKEY as VerificationKey
    }
    proof = await proveWithArtifacts({ a: '1', b: '2' }, artifacts)
    publicSignals = proof.publicSignals
  })

  it('produces a proof that verifies against the pinned VK', async () => {
    expect(proof.proof.protocol).toBe('groth16')
    expect(proof.proof.curve).toBe('bn128')
    expect(publicSignals).toEqual(FIXTURE_PUBLIC_SIGNALS)
    expect(publicSignals).toHaveLength(artifacts.vkey.nPublic)
    expect(await verifyProofWithKey(proof, publicSignals, artifacts.vkey)).toBe(true)

    setPinnedVerificationKey(artifacts.vkey)
    expect(await verifyVoteProof(proof, publicSignals)).toBe(true)
    resetKeys()
  })

  it('verifies the pre-generated fixture proof (KAT)', async () => {
    const fixtureProof: Proof = {
      proof: FIXTURE_PROOF as Proof['proof'],
      publicSignals: FIXTURE_PUBLIC_SIGNALS
    }
    expect(await verifyProofWithKey(fixtureProof, FIXTURE_PUBLIC_SIGNALS, artifacts.vkey)).toBe(true)
  })

  it('rejects a tampered proof', async () => {
    const tampered: Proof = {
      ...proof,
      proof: { ...proof.proof, pi_a: [...proof.proof.pi_a] }
    }
    tampered.proof.pi_a[0] = (BigInt(tampered.proof.pi_a[0]) + 1n).toString()
    expect(await verifyProofWithKey(tampered, publicSignals, artifacts.vkey)).toBe(false)
  })

  it('rejects wrong public signals and wrong VK', async () => {
    const wrongSignals = [...publicSignals]
    wrongSignals[0] = (BigInt(wrongSignals[0]) + 1n).toString()
    expect(await verifyProofWithKey(proof, wrongSignals, artifacts.vkey)).toBe(false)

    const wrongVk: VerificationKey = {
      ...artifacts.vkey,
      IC: artifacts.vkey.IC.map((point, i) =>
        i === 0 ? [(BigInt(point[0]) + 1n).toString(), point[1], point[2]] : [...point]
      )
    }
    expect(await verifyProofWithKey(proof, publicSignals, wrongVk)).toBe(false)
  })

  it('rejects malformed curve points and wrong protocol with typed errors', async () => {
    const malformed: Proof = {
      ...proof,
      proof: { ...proof.proof, pi_a: ['not-a-coordinate', proof.proof.pi_a[1], proof.proof.pi_a[2]] }
    }
    await expect(verifyProofWithKey(malformed, publicSignals, artifacts.vkey)).rejects.toBeInstanceOf(VerificationError)

    const wrongProtocol: Proof = { ...proof, proof: { ...proof.proof, protocol: 'plonk' } }
    await expect(verifyProofWithKey(wrongProtocol, publicSignals, artifacts.vkey)).rejects.toThrow(/protocol/i)

    const outOfField: Proof = {
      ...proof,
      proof: {
        ...proof.proof,
        pi_a: [
          '21888242871839275222246405745257275088548364400416034343698204186575808495618',
          proof.proof.pi_a[1],
          proof.proof.pi_a[2]
        ]
      }
    }
    expect(await verifyProofWithKey(outOfField, publicSignals, artifacts.vkey)).toBe(false)
  })

  it('honours an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      proveWithArtifacts({ a: '1', b: '2' }, artifacts, { signal: controller.signal })
    ).rejects.toBeInstanceOf(AbortError)
  })

  it('builds 6-signal vote circuit inputs with a Poseidon nullifier', () => {
    const secret = new Uint8Array(32).fill(7)
    const inputs = buildVoteCircuitInputs({
      identitySecret: secret,
      pollId: '42',
      choice: '1',
      numCandidates: 3,
      merkleProof: { root: '1', siblings: ['2', '3'], pathIndices: [0, 1] }
    }) as Record<string, string | string[]>
    const publicKeys = ['root', 'nullifier', 'daoId', 'proposalId', 'voteChoice', 'numCandidates']
    expect(publicKeys.every((key) => key in inputs)).toBe(true)
    expect(inputs.pathElements).toEqual(['2', '3'])
    expect(inputs.pathIndices).toEqual(['0', '1'])
  })
})
