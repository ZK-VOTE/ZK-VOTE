/**
 * Circuit-compatibility matrix tests (ZV-113 / Issue #953).
 *
 * EPIC-004 promises "circuits N and N-1" and a tested compatibility
 * matrix, but until this change the SDK only had a static
 * CIRCUIT_COMPATIBILITY constant with no runtime check against the
 * registry. These tests exercise the registry-backed check
 * (`checkCircuitVersion`), its wiring into `loadKeys`/`getKey`/the prove
 * functions, and the offline-pack manifest-hash check - all against a
 * fixture `RegistryClient` and a mocked `fetch`, no real network call.
 */
import { createHash } from 'crypto'
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  checkCircuitVersion,
  UnsupportedCircuitVersionError,
  isCircuitCompatible,
  getSupportedCircuitVersions,
} from '../src/version'
import { createStaticRegistryClient, type CircuitMatrixEntry } from '../src/registry'
import {
  loadKeys,
  verifyKeyIntegrity,
  getKey,
  getCompatibilityReport,
  assertCircuitReady,
} from '../src/keys'
import { generateVoteProof } from '../src/prove'

const MATRIX: CircuitMatrixEntry[] = [
  { circuitId: 'vote_v2', currentVersion: 2, supportedVersions: [2, 1] },
  { circuitId: 'weighted_vote', currentVersion: 1, supportedVersions: [1] },
]

/** Mirrors keys.ts's placeholder key shape so verifyKeyIntegrity()'s hash check passes. */
function placeholderKeyHash(circuitName: string): string {
  const hash = createHash('sha256')
  hash.update(
    JSON.stringify({
      wasm: `wasm_${circuitName}`,
      zkey: `zkey_${circuitName}`,
      vkey: `vkey_${circuitName}`,
    })
  )
  return 'sha256:' + hash.digest('hex')
}

function mockFetchManifest(manifest: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, statusText: 'OK', json: async () => manifest }))
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('checkCircuitVersion (registry-backed)', () => {
  const registry = createStaticRegistryClient(MATRIX)

  it('is compatible when the declared version equals the registry current version', async () => {
    const result = await checkCircuitVersion('vote_v2', 2, registry)
    expect(result.compatible).toBe(true)
    expect(result.usedFallback).toBe(false)
    expect(result.warning).toBeUndefined()
  })

  it('reports N-1 fallback with an explicit warning', async () => {
    const result = await checkCircuitVersion('vote_v2', 1, registry)
    expect(result.compatible).toBe(true)
    expect(result.usedFallback).toBe(true)
    expect(result.warning).toMatch(/N-1 fallback/)
  })

  it('refuses a circuit version more than one behind current (N-2)', async () => {
    await expect(checkCircuitVersion('vote_v2', 0, registry)).rejects.toThrow(
      UnsupportedCircuitVersionError
    )
  })

  it('refuses a circuit version ahead of the registry current version', async () => {
    await expect(checkCircuitVersion('vote_v2', 3, registry)).rejects.toThrow(
      UnsupportedCircuitVersionError
    )
  })

  it('refuses a circuit the registry does not know about at all', async () => {
    await expect(checkCircuitVersion('bridge', 1, registry)).rejects.toThrow(
      UnsupportedCircuitVersionError
    )
  })

  it('the thrown error carries the full check result for callers to inspect', async () => {
    const err = await checkCircuitVersion('vote_v2', 0, registry).catch((e) => e)
    expect(err).toBeInstanceOf(UnsupportedCircuitVersionError)
    const check = (err as UnsupportedCircuitVersionError).check
    expect(check).toEqual({
      circuitId: 'vote_v2',
      declaredVersion: 0,
      registryCurrentVersion: 2,
      compatible: false,
      usedFallback: false,
    })
  })
})

describe('static CIRCUIT_COMPATIBILITY table (back-compat, unaffected by the registry check)', () => {
  it('isCircuitCompatible/getSupportedCircuitVersions still work off the static table alone', () => {
    expect(isCircuitCompatible('1.0')).toBe(true)
    expect(isCircuitCompatible('0.9')).toBe(true)
    expect(isCircuitCompatible('0.8')).toBe(false)
    expect(getSupportedCircuitVersions()).toEqual(['1.0', '0.9'])
  })
})

describe('loadKeys() via manifestUrl + registry gate', () => {
  it('a circuit within the N/N-1 window loads, verifies, and is usable', async () => {
    const keys = {
      vote: {
        wasm: 'w',
        zkey: 'z',
        vkey: 'v',
        hash: placeholderKeyHash('vote'),
        size: 100,
        circuitId: 'vote_v2',
        circuitVersion: 2,
      },
    }
    mockFetchManifest({ version: '1.0.0', keys })

    await loadKeys({
      manifestUrl: 'https://example.invalid/manifest.json',
      registry: createStaticRegistryClient(MATRIX),
    })
    expect(await verifyKeyIntegrity()).toBe(true)
    expect(() => getKey('vote')).not.toThrow()

    const report = getCompatibilityReport()
    expect(report.unsupported).toEqual([])
    expect(report.checks).toEqual([
      {
        circuitId: 'vote_v2',
        declaredVersion: 2,
        registryCurrentVersion: 2,
        compatible: true,
        usedFallback: false,
      },
    ])
  })

  it('records an N-1 fallback warning without blocking the circuit', async () => {
    const keys = {
      vote: {
        wasm: 'w',
        zkey: 'z',
        vkey: 'v',
        hash: placeholderKeyHash('vote'),
        size: 100,
        circuitId: 'vote_v2',
        circuitVersion: 1, // registry current is 2 -> N-1
      },
    }
    mockFetchManifest({ version: '1.0.0', keys })

    await loadKeys({
      manifestUrl: 'https://example.invalid/manifest.json',
      registry: createStaticRegistryClient(MATRIX),
    })
    await verifyKeyIntegrity()
    expect(() => getKey('vote')).not.toThrow()

    const report = getCompatibilityReport()
    expect(report.unsupported).toEqual([])
    expect(report.checks[0].usedFallback).toBe(true)
    expect(report.checks[0].warning).toMatch(/N-1 fallback/)
  })

  it('getKey/assertCircuitReady/generateVoteProof all refuse an unsupported circuit version', async () => {
    const keys = {
      vote: {
        wasm: 'w',
        zkey: 'z',
        vkey: 'v',
        hash: placeholderKeyHash('vote'),
        size: 100,
        circuitId: 'vote_v2',
        circuitVersion: 0, // two behind registry current (2) -> unsupported
      },
    }
    mockFetchManifest({ version: '1.0.0', keys })

    await loadKeys({
      manifestUrl: 'https://example.invalid/manifest.json',
      registry: createStaticRegistryClient(MATRIX),
    })
    await verifyKeyIntegrity()

    expect(() => assertCircuitReady('vote')).toThrow(UnsupportedCircuitVersionError)
    expect(() => getKey('vote')).toThrow(UnsupportedCircuitVersionError)
    await expect(
      generateVoteProof({
        identitySecret: new Uint8Array(32),
        pollId: 'poll-1',
        choice: 'yes',
        merkleProof: { root: 'r', siblings: [], pathIndices: [] },
      })
    ).rejects.toThrow(UnsupportedCircuitVersionError)

    expect(getCompatibilityReport().unsupported).toEqual(['vote'])
  })

  it('a manifest key with no circuitId/circuitVersion is never registry-checked (back-compat)', async () => {
    const keys = {
      vote: { wasm: 'w', zkey: 'z', vkey: 'v', hash: placeholderKeyHash('vote'), size: 100 },
    }
    mockFetchManifest({ version: '1.0.0', keys })

    await loadKeys({
      manifestUrl: 'https://example.invalid/manifest.json',
      registry: createStaticRegistryClient(MATRIX),
    })
    await verifyKeyIntegrity()
    expect(() => getKey('vote')).not.toThrow()
    expect(getCompatibilityReport().checks).toEqual([])
  })
})

describe('offline/manifest hash integrity (#953 "offline packs carry matching manifest hashes")', () => {
  it('accepts a manifest whose expectedManifestHash matches the computed hash', async () => {
    const keys = { vote: { wasm: 'w', zkey: 'z', vkey: 'v', hash: 'sha256:x', size: 1 } }
    const expected = 'sha256:' + createHash('sha256').update(JSON.stringify(keys)).digest('hex')
    mockFetchManifest({ version: '1.0.0', keys })

    await expect(
      loadKeys({
        manifestUrl: 'https://example.invalid/manifest.json',
        expectedManifestHash: expected,
      })
    ).resolves.toBeUndefined()
  })

  it('rejects a mismatched expectedManifestHash before loading any key', async () => {
    const keys = { vote: { wasm: 'w', zkey: 'z', vkey: 'v', hash: 'sha256:x', size: 1 } }
    mockFetchManifest({ version: '1.0.0', keys })

    await expect(
      loadKeys({
        manifestUrl: 'https://example.invalid/manifest.json',
        expectedManifestHash: 'sha256:not-the-real-hash',
      })
    ).rejects.toThrow(/does not match the expected hash/)
  })

  it('rejects a manifest whose self-reported manifestHash does not match its own content', async () => {
    const keys = { vote: { wasm: 'w', zkey: 'z', vkey: 'v', hash: 'sha256:x', size: 1 } }
    mockFetchManifest({ version: '1.0.0', keys, manifestHash: 'sha256:tampered' })

    await expect(
      loadKeys({ manifestUrl: 'https://example.invalid/manifest.json' })
    ).rejects.toThrow(/self-reported hash/)
  })
})
