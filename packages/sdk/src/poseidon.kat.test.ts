import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  deriveCircuitClaimNullifier,
  deriveCircuitCommitment,
  deriveCircuitNullifier,
  deriveIdentityCommitment,
  deriveNullifier,
  deriveTrapdoor,
  fieldToHex,
  generateSecret,
  poseidonHash,
  poseidonHashDecimal
} from './derive'

interface Vector {
  name: string
  inputs_decimal: string[]
  output_decimal: string
  output_hex: string
}

const vectorsPath = resolve(process.cwd(), '../../circuits/utils/poseidon_test_vectors.json')
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as Vector[]

describe('Poseidon known-answer tests (circuits/utils/poseidon_test_vectors.json)', () => {
  it('matches every checked-in vector exactly', () => {
    expect(vectors.length).toBeGreaterThan(0)
    for (const vector of vectors) {
      const inputs = vector.inputs_decimal.map((v) => BigInt(v))
      expect(poseidonHash(inputs).toString(), `vector ${vector.name}`).toBe(vector.output_decimal)
      expect(poseidonHashDecimal(vector.inputs_decimal), `decimal vector ${vector.name}`).toBe(vector.output_decimal)
      expect(fieldToHex(poseidonHash(inputs)), `hex vector ${vector.name}`).toBe(vector.output_hex)
    }
  })

  it('is deterministic and domain-separated', () => {
    const secret = generateSecret()
    expect(deriveIdentityCommitment(secret)).toBe(deriveIdentityCommitment(secret))
    expect(deriveNullifier(secret, 'poll-1')).toBe(deriveNullifier(secret, 'poll-1'))
    expect(deriveNullifier(secret, 'poll-1')).not.toBe(deriveNullifier(secret, 'poll-2'))
    expect(deriveTrapdoor(secret)).not.toBe(deriveIdentityCommitment(secret))
    expect(deriveIdentityCommitment(secret)).not.toMatch(/^[a-f0-9]{64}$/) // decimal, not SHA-256 hex
  })

  it('matches the circuit commitment / nullifier formulas', () => {
    const commitment = deriveCircuitCommitment(1n, 2n, 3n)
    const expectedPoseidon4 = poseidonHashDecimal([
      '19666041591797403834655481403982443037438503980743793537655983658411276515161',
      '1',
      '2',
      '3'
    ])
    expect(commitment).toBe(expectedPoseidon4)

    expect(deriveCircuitNullifier(1n, 2n, 3n)).toBe(poseidonHashDecimal(['1', '2', '3']))
    expect(deriveCircuitClaimNullifier(1n, 2n, 3n)).toBe(poseidonHashDecimal(['1', '2', '3', '427020085613']))
  })

  it('rejects invalid inputs and produces CSPRNG secrets', () => {
    expect(() => poseidonHash([])).toThrow()
    expect(() => poseidonHash(['not-a-number'])).toThrow()
    expect(() => deriveIdentityCommitment(new Uint8Array(31))).toThrow()
    expect(generateSecret()).toHaveLength(32)
    expect(generateSecret()).not.toEqual(generateSecret())
  })
})
