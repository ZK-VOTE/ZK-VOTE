/**
 * Key management and verification
 */

import { createHash } from 'crypto'
import type { RegistryClient } from './registry'
import { checkCircuitVersion, UnsupportedCircuitVersionError, type CircuitVersionCheck } from './version'

export interface KeyManifestEntry {
  wasm: string
  zkey: string
  vkey: string
  hash: string
  size: number
  /**
   * Registry circuit id + version this key corresponds to (ZV-113 / #953).
   * Optional for backward compatibility with manifests written before the
   * compatibility matrix existed; without it, `loadKeys()` cannot run the
   * registry-backed version check for this circuit and will skip it.
   */
  circuitId?: string
  circuitVersion?: number
}

export interface KeyManifest {
  version: string
  keys: {
    [circuitName: string]: KeyManifestEntry
  }
  /**
   * SHA-256 of the manifest's own `keys` object, used to detect a
   * tampered or corrupted offline key pack before any individual key hash
   * is even checked (#953 "offline packs carry matching manifest hashes").
   */
  manifestHash?: string
}

export interface KeyLoadOptions {
  manifestUrl?: string
  offlinePack?: boolean
  cacheDir?: string
  /**
   * Registry client used to runtime-check each manifest key's
   * `circuitId`/`circuitVersion` against the registry's current version
   * (ZV-113). Omit to skip the runtime check entirely (falls back to the
   * static CIRCUIT_COMPATIBILITY table only, same as before this change).
   */
  registry?: RegistryClient
  /**
   * Expected manifest hash for an offline pack. If provided and it does
   * not match the loaded manifest's computed hash, `loadKeys()` throws
   * before loading any key.
   */
  expectedManifestHash?: string
}

class KeyManager {
  private manifest?: KeyManifest
  private loadedKeys: Map<string, any> = new Map()
  private verified: boolean = false
  /** Per-circuit registry compatibility result from the most recent loadKeys() (ZV-113). */
  private compatibility: Map<string, CircuitVersionCheck> = new Map()
  /** Circuits whose registry check threw during loadKeys(), by circuit name, re-thrown by getKey()/assertCircuitReady(). */
  private unsupported: Map<string, UnsupportedCircuitVersionError> = new Map()

  /**
   * Load proving keys from manifest
   */
  async loadKeys(options: KeyLoadOptions): Promise<void> {
    console.log('Loading proving keys...')
    this.compatibility.clear()
    this.unsupported.clear()

    if (options.offlinePack) {
      await this.loadOfflineKeys(options)
    } else if (options.manifestUrl) {
      await this.loadFromManifest(options.manifestUrl, options)
    } else {
      throw new Error('Must provide either manifestUrl or offlinePack option')
    }

    if (options.registry) {
      await this.checkCompatibility(options.registry)
    }
  }

  /**
   * Run the registry-backed version check (ZV-113) for every manifest key
   * that declares a `circuitId`/`circuitVersion`. Keys without either are
   * skipped (no registry claim is being made about them). An unsupported
   * result does not throw here - it is recorded and re-thrown lazily from
   * `getKey()`/`assertCircuitReady()`, so a caller that never actually
   * tries to prove with that one bad circuit isn't blocked from using the
   * others in the same manifest.
   */
  private async checkCompatibility(registry: import('./registry').RegistryClient): Promise<void> {
    if (!this.manifest) return
    for (const [circuitName, keyInfo] of Object.entries(this.manifest.keys)) {
      if (!keyInfo.circuitId || keyInfo.circuitVersion === undefined) continue
      try {
        const result = await checkCircuitVersion(keyInfo.circuitId, keyInfo.circuitVersion, registry)
        this.compatibility.set(circuitName, result)
        if (result.warning) {
          console.warn(`[zkvote-sdk] ${result.warning}`)
        }
      } catch (err) {
        if (err instanceof UnsupportedCircuitVersionError) {
          this.unsupported.set(circuitName, err)
          console.error(`[zkvote-sdk] ${err.message}`)
        } else {
          throw err
        }
      }
    }
  }

  /**
   * Compatibility results from the most recent loadKeys() call that
   * provided a `registry`. Includes N-1 fallback warnings so callers can
   * surface them (#953 "N-1 fallback is tested and reported to callers").
   */
  getCompatibilityReport(): { checks: CircuitVersionCheck[]; unsupported: string[] } {
    return {
      checks: Array.from(this.compatibility.values()),
      unsupported: Array.from(this.unsupported.keys()),
    }
  }

  /**
   * Throws if `circuitName` failed its registry compatibility check
   * during the most recent loadKeys(). Does nothing (including: does not
   * require that a check was ever run) if the circuit has no recorded
   * failure - callers that never passed a `registry` to loadKeys() are
   * unaffected, same as before this change.
   */
  assertCircuitReady(circuitName: string): void {
    const failure = this.unsupported.get(circuitName)
    if (failure) {
      throw failure
    }
  }

  /**
   * Verify integrity of loaded keys
   */
  async verifyKeyIntegrity(): Promise<boolean> {
    if (!this.manifest) {
      throw new Error('No keys loaded')
    }

    console.log('Verifying key integrity...')

    for (const [circuitName, keyInfo] of Object.entries(this.manifest.keys)) {
      const loadedKey = this.loadedKeys.get(circuitName)
      if (!loadedKey) {
        console.error(`Key not loaded: ${circuitName}`)
        return false
      }

      // Verify hash
      const computedHash = this.computeHash(loadedKey)
      if (computedHash !== keyInfo.hash) {
        console.error(`Hash mismatch for ${circuitName}`)
        return false
      }
    }

    this.verified = true
    return true
  }

  /**
   * Get loaded key for circuit
   */
  getKey(circuitName: string): any {
    if (!this.verified) {
      throw new Error('Keys not verified. Call verifyKeyIntegrity() first')
    }
    this.assertCircuitReady(circuitName)

    const key = this.loadedKeys.get(circuitName)
    if (!key) {
      throw new Error(`Key not found: ${circuitName}`)
    }

    return key
  }

  /**
   * Check if keys are loaded
   */
  isLoaded(): boolean {
    return this.loadedKeys.size > 0
  }

  private async loadFromManifest(manifestUrl: string, options: KeyLoadOptions): Promise<void> {
    // Fetch manifest
    const response = await fetch(manifestUrl)
    if (!response.ok) {
      throw new Error(`Failed to fetch manifest: ${response.statusText}`)
    }

    const manifest = (await response.json()) as KeyManifest
    this.assertManifestHash(manifest, options.expectedManifestHash)
    this.manifest = manifest

    // Load each key
    for (const [circuitName, keyInfo] of Object.entries(manifest.keys)) {
      console.log(`Loading key: ${circuitName} (${this.formatBytes(keyInfo.size)})`)

      // In production, would fetch actual keys
      // For now, store placeholder
      this.loadedKeys.set(circuitName, {
        wasm: `wasm_${circuitName}`,
        zkey: `zkey_${circuitName}`,
        vkey: `vkey_${circuitName}`
      })
    }
  }

  private async loadOfflineKeys(options: KeyLoadOptions): Promise<void> {
    // Load keys bundled with the SDK
    console.log('Loading offline key pack...')

    // Placeholder - would load from bundled files
    const manifest: KeyManifest = {
      version: '1.0.0',
      keys: {
        vote: {
          wasm: 'bundled',
          zkey: 'bundled',
          vkey: 'bundled',
          hash: 'sha256:...',
          size: 45000000
        }
      }
    }
    this.assertManifestHash(manifest, options.expectedManifestHash)
    this.manifest = manifest

    this.loadedKeys.set('vote', {
      wasm: 'bundled_wasm',
      zkey: 'bundled_zkey',
      vkey: 'bundled_vkey'
    })
  }

  /**
   * Compute a manifest's content hash and, if `expected` is given, throw
   * on mismatch before a single key is loaded (#953 "offline packs carry
   * matching manifest hashes"). A manifest that declares its own
   * `manifestHash` is also self-checked, independent of `expected`.
   */
  private assertManifestHash(manifest: KeyManifest, expected?: string): void {
    const computed = this.computeManifestHash(manifest)
    if (manifest.manifestHash && manifest.manifestHash !== computed) {
      throw new Error(
        `Manifest self-reported hash ${manifest.manifestHash} does not match its computed hash ${computed} - the manifest is corrupt or was tampered with.`
      )
    }
    if (expected && expected !== computed) {
      throw new Error(
        `Manifest hash ${computed} does not match the expected hash ${expected} pinned by the caller.`
      )
    }
  }

  private computeManifestHash(manifest: KeyManifest): string {
    const hash = createHash('sha256')
    hash.update(JSON.stringify(manifest.keys))
    return 'sha256:' + hash.digest('hex')
  }

  private computeHash(key: any): string {
    // In production, would compute actual hash of key data
    const hash = createHash('sha256')
    hash.update(JSON.stringify(key))
    return 'sha256:' + hash.digest('hex')
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }
}

// ── On-chain registry VK resolution ──────────────────────────────────────────

export interface RegistryVK {
  circuitId: string
  circuitType: 'Vote' | 'Comment'
  version: number
  vk: unknown
  hash: string
  numPublicSignals: number
  currentVersion: number
}

const registryVkCache = new Map<string, RegistryVK>()

function registryCacheKey(circuitId: string, version: number, circuitType: string): string {
  return `${circuitId}::${circuitType}::${version}`
}

/**
 * Resolve a VK from the relayer's on-chain-registry-backed endpoint, verifying
 * the canonical registry hash before caching it. A 410 response invalidates
 * the cached entry so an on-chain rotation cannot be served from SDK memory.
 */
export async function resolveRegistryVK(
  circuitId: string,
  version: number,
  options: {
    relayerUrl?: string
    circuitType?: 'Vote' | 'Comment'
    fetchFn?: typeof fetch
  } = {},
): Promise<RegistryVK> {
  const circuitType = options.circuitType ?? 'Vote'
  const key = registryCacheKey(circuitId, version, circuitType)
  const cached = registryVkCache.get(key)
  if (cached) return cached

  const base = (options.relayerUrl ?? 'http://localhost:3001').replace(/\/$/, '')
  const url = `${base}/circuits/vk/${encodeURIComponent(circuitId)}/${version}?type=${circuitType.toLowerCase()}`
  const response = await (options.fetchFn ?? fetch)(url)
  if (response.status === 410 || response.status === 409) {
    invalidateRegistryVK(circuitId, circuitType)
    throw new Error(`Stale VK for ${circuitId} v${version}`)
  }
  if (!response.ok) {
    throw new Error(`Failed to resolve registry VK: HTTP ${response.status}`)
  }
  const data = await response.json() as Partial<RegistryVK> & { hashScheme?: string }
  const entry: RegistryVK = {
    circuitId,
    circuitType,
    version: data.version ?? version,
    vk: data.vk,
    hash: data.hash ?? '',
    numPublicSignals: data.numPublicSignals ?? 0,
    currentVersion: data.currentVersion ?? data.version ?? version,
  }
  if (data.hashScheme === 'registry-v1') {
    const canonical = createHash('sha256')
      .update(JSON.stringify({
        circuitId,
        circuitType,
        version: entry.version,
        vk: entry.vk,
        numPublicSignals: entry.numPublicSignals,
      }))
      .digest('hex')
    if (entry.hash !== canonical) {
      throw new Error(`VK hash mismatch for ${circuitId} v${version}: registry response is not authoritative`)
    }
  }
  registryVkCache.set(key, entry)
  return entry
}

/** Drop cached VKs after a VkProposal execution (all versions or one circuit). */
export function invalidateRegistryVK(
  circuitId?: string,
  circuitType: 'Vote' | 'Comment' = 'Vote',
  version?: number,
): void {
  if (!circuitId) {
    registryVkCache.clear()
    return
  }
  if (version !== undefined) {
    registryVkCache.delete(registryCacheKey(circuitId, version, circuitType))
    return
  }
  for (const key of Array.from(registryVkCache.keys())) {
    if (key.startsWith(`${circuitId}::`)) registryVkCache.delete(key)
  }
}

// Singleton instance
const keyManager = new KeyManager()

/**
 * Load proving keys
 */
export async function loadKeys(options: KeyLoadOptions): Promise<void> {
  return keyManager.loadKeys(options)
}

/**
 * Verify key integrity
 */
export async function verifyKeyIntegrity(): Promise<boolean> {
  return keyManager.verifyKeyIntegrity()
}

/**
 * Check if keys are loaded
 */
export function areKeysLoaded(): boolean {
  return keyManager.isLoaded()
}

/**
 * Get the loaded, verified key for a circuit (throws if keys were never
 * verified, the circuit was never loaded, or it failed its registry
 * compatibility check - see `assertCircuitReady`).
 */
export function getKey(circuitName: string): any {
  return keyManager.getKey(circuitName)
}

/**
 * Registry compatibility results from the most recent loadKeys() call
 * (ZV-113 / #953). Empty `checks` if loadKeys() was never given a
 * `registry`.
 */
export function getCompatibilityReport(): { checks: CircuitVersionCheck[]; unsupported: string[] } {
  return keyManager.getCompatibilityReport()
}

/**
 * Get the key for a circuit, by name, without going through getKey()'s
 * "verified" requirement - just the registry-compatibility gate. Lets
 * prove.ts refuse to prove with an unsupported circuit version even
 * before/independent of the (separately mocked) hash-integrity check.
 */
export function assertCircuitReady(circuitName: string): void {
  keyManager.assertCircuitReady(circuitName)
}
