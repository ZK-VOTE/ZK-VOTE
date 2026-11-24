import { beforeEach, describe, expect, it } from 'vitest'
import {
  computeArtifactHash,
  computeArtifactSize,
  getKey,
  getVerificationKey,
  loadKeys,
  resetKeys,
  verifyKeyIntegrity,
  verifyKeyIntegrityOrThrow,
  type CircuitArtifacts,
  type KeyManifest
} from './keys'
import { KeyIntegrityError, KeyLoadError, KeysNotLoadedError, InvalidInputError } from './types'
import { clearCache, configureCache, getCached, getCacheStats, setCached, computeIntegrityHash } from './cache'
import type { VerificationKey } from './types'

const vkey: VerificationKey = {
  protocol: 'groth16',
  curve: 'bn128',
  nPublic: 1,
  vk_alpha_1: ['1', '2', '1'],
  vk_beta_2: [['1', '2'], ['3', '4'], ['1', '0']],
  vk_gamma_2: [['1', '2'], ['3', '4'], ['1', '0']],
  vk_delta_2: [['1', '2'], ['3', '4'], ['1', '0']],
  vk_alphabeta_12: [[['1', '2'], ['3', '4'], ['5', '6']], [['7', '8'], ['9', '10'], ['11', '12']]],
  IC: [['1', '2', '1'], ['3', '4', '1']]
}

function makeArtifacts(): CircuitArtifacts {
  return {
    wasm: new Uint8Array([1, 2, 3, 4]),
    zkey: new Uint8Array([5, 6, 7, 8]),
    vkey
  }
}

describe('key loading and integrity', () => {
  beforeEach(() => {
    resetKeys()
    clearCache()
  })

  it('loads explicit artifacts and verifies real SHA-256 hashes', async () => {
    const artifacts = makeArtifacts()
    const hash = computeArtifactHash(artifacts)
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(computeArtifactSize(artifacts)).toBe(8 + JSON.stringify(vkey).length)

    await loadKeys({ artifacts: { vote: artifacts } })
    expect(getKey('vote').wasm).toEqual(artifacts.wasm)
    expect(getVerificationKey('vote')).toBe(vkey)
    expect(await verifyKeyIntegrity()).toBe(true)
    expect(() => verifyKeyIntegrityOrThrow()).not.toThrow()
  })

  it('rejects missing circuits with typed errors', async () => {
    await loadKeys({ artifacts: { vote: makeArtifacts() } })
    expect(() => getKey('claim')).toThrow(KeysNotLoadedError)
    resetKeys()
    expect(() => getKey('vote')).toThrow(KeysNotLoadedError)
  })

  it('detects hash and size mismatches from a manifest', async () => {
    const artifacts = makeArtifacts()
    const badHashManifest: KeyManifest = {
      version: '2',
      keys: {
        vote: { wasm: '', zkey: '', vkey: '', hash: 'sha256:' + '0'.repeat(64), size: computeArtifactSize(artifacts) }
      }
    }
    await expect(loadKeys({ artifacts: { vote: artifacts }, manifest: badHashManifest })).rejects.toThrow(KeyIntegrityError)

    const badSizeManifest: KeyManifest = {
      version: '2',
      keys: {
        vote: { wasm: '', zkey: '', vkey: '', hash: computeArtifactHash(artifacts), size: 999999 }
      }
    }
    resetKeys()
    await expect(loadKeys({ artifacts: { vote: artifacts }, manifest: badSizeManifest })).rejects.toThrow(KeyIntegrityError)
  })

  it('requires a real load source', async () => {
    await expect(loadKeys({})).rejects.toThrow(InvalidInputError)
    const offlineFetch = (async () => {
      throw new Error('network disabled for test')
    }) as unknown as typeof fetch
    await expect(loadKeys({ manifestUrl: 'https://example.invalid/manifest.json', fetchImpl: offlineFetch })).rejects.toThrow(KeyLoadError)
  })

  it('rejects malformed verification keys', async () => {
    const artifacts = makeArtifacts()
    artifacts.vkey = { ...vkey, IC: [['1', '2', '1']] }
    await expect(loadKeys({ artifacts: { vote: artifacts } })).rejects.toThrow(KeyIntegrityError)
  })
})

describe('artifact cache', () => {
  beforeEach(() => {
    clearCache()
    configureCache({ enabled: true, ttl: 3600, maxSize: 1000, strategy: 'lru', version: '1', verifyIntegrity: true })
  })

  it('verifies integrity and evicts tampered entries', () => {
    const value = new Uint8Array([1, 2, 3])
    setCached('vote', value, 3)
    expect(getCached('vote')).toEqual(value)

    // Tamper with the cached object the same way a corrupted store would.
    value[0] = 99
    expect(getCached('vote')).toBeUndefined()
    expect(getCacheStats().integrityFailures).toBe(1)
  })

  it('invalidates entries when the version changes', () => {
    setCached('vote', 'value-1', 6)
    configureCache({ version: '2' })
    expect(getCached('vote')).toBeUndefined()
    expect(getCacheStats().entries).toBe(0)
  })

  it('evicts according to policy and reports stats', () => {
    configureCache({ maxSize: 10, strategy: 'lru' })
    setCached('a', '1111', 4)
    setCached('b', '2222', 4)
    expect(getCached('a')).toBe('1111') // refresh LRU order
    setCached('c', '3333', 4)
    expect(getCacheStats().evictions).toBe(1)
    expect(getCacheStats().entries).toBe(2)
    expect(computeIntegrityHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
