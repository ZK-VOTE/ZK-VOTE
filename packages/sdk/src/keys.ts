/**
 * Key management and verification.
 *
 * Proving artifacts (wasm + zkey + verification key) are loaded from a versioned
 * manifest, an offline pack or provided directly by the caller. Every artifact
 * is decoded to real bytes, size-checked and hashed with SHA-256 before it can
 * be used for proving or verification. There are no bundled placeholders.
 *
 * Pre-v2 manifests whose artifact references are bare placeholder tokens are
 * still readable for backwards compatibility (and so the registry-compatibility
 * gate can be used independently of artifact loading); they are never used for
 * real proving.
 */

import { createHash } from 'crypto'
import type { RegistryClient } from './registry'
import { checkCircuitVersion, UnsupportedCircuitVersionError, type CircuitVersionCheck } from './version'
// @ts-ignore - subpath export needs node16 resolution in tsup's dts pass
import { sha256 } from '@noble/hashes/sha256'
// @ts-ignore - subpath export needs node16 resolution in tsup's dts pass
import { bytesToHex } from '@noble/hashes/utils'
import type { VerificationKey } from './types'
import {
  KeyIntegrityError,
  KeyLoadError,
  KeysNotLoadedError,
  KeysNotVerifiedError,
  InvalidInputError,
  NetworkError
} from './types'
import { getCached, setCached } from './cache'

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
  /** Base URL/path used to resolve relative artifact references. */
  baseUrl?: string
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
  /** `true` uses `./keys/manifest.json`; a string is an explicit base URL/path. */
  offlinePack?: boolean | string
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
  /** Supply a manifest object directly (already parsed). */
  manifest?: KeyManifest
  /** Supply decoded artifacts directly — useful for bundled/embedded keys. */
  artifacts?: Record<string, CircuitArtifacts>
  /** Override fetch (tests / non-standard environments). */
  fetchImpl?: typeof fetch
}

/** Decoded, ready-to-use artifacts for one circuit. */
export interface CircuitArtifacts {
  wasm: Uint8Array
  zkey: Uint8Array
  vkey: VerificationKey
}

/** Legacy (pre-v2) manifest key: artifact references, not decoded bytes. */
interface LegacyKey {
  wasm: string
  zkey: string
  vkey: string
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength)
  throw new KeyLoadError('Expected binary artifact data (Uint8Array or ArrayBuffer)')
}

function canonicalVkeyBytes(vkey: VerificationKey): Uint8Array {
  // snarkjs exports keys with stable key order; sort anyway so the digest is
  // independent of how the JSON was parsed/serialised.
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(vkey).sort()) {
    sorted[key] = (vkey as unknown as Record<string, unknown>)[key]
  }
  return new TextEncoder().encode(JSON.stringify(sorted))
}

/** SHA-256 of `wasm || zkey || canonical(vkey JSON)`, formatted as `sha256:<hex>`. */
export function computeArtifactHash(artifacts: CircuitArtifacts): string {
  const total = artifacts.wasm.length + artifacts.zkey.length + canonicalVkeyBytes(artifacts.vkey).length
  const bundle = new Uint8Array(total)
  bundle.set(artifacts.wasm, 0)
  bundle.set(artifacts.zkey, artifacts.wasm.length)
  bundle.set(canonicalVkeyBytes(artifacts.vkey), artifacts.wasm.length + artifacts.zkey.length)
  return 'sha256:' + bytesToHex(sha256(bundle))
}

/** Total byte length of the artifact bundle (wasm + zkey + vkey JSON). */
export function computeArtifactSize(artifacts: CircuitArtifacts): number {
  return artifacts.wasm.length + artifacts.zkey.length + canonicalVkeyBytes(artifacts.vkey).length
}

function normaliseHash(hash: string): string {
  return hash.startsWith('sha256:') ? hash : 'sha256:' + hash
}

function assertVerificationKey(value: unknown): VerificationKey {
  if (!value || typeof value !== 'object') {
    throw new KeyIntegrityError('Verification key is not a JSON object')
  }
  const vk = value as VerificationKey
  if (vk.protocol !== 'groth16' || vk.curve !== 'bn128') {
    throw new KeyIntegrityError('Verification key has the wrong protocol or curve', {
      protocol: vk.protocol,
      curve: vk.curve
    })
  }
  if (!Array.isArray(vk.IC) || typeof vk.nPublic !== 'number' || vk.IC.length !== vk.nPublic + 1) {
    throw new KeyIntegrityError('Verification key IC vector length does not match nPublic', {
      nPublic: vk.nPublic,
      icLength: Array.isArray(vk.IC) ? vk.IC.length : null
    })
  }
  return vk
}

/** Upstream's legacy key shape/hash, kept so old manifests remain readable. */
function legacyKey(circuitName: string): LegacyKey {
  return {
    wasm: `wasm_${circuitName}`,
    zkey: `zkey_${circuitName}`,
    vkey: `vkey_${circuitName}`
  }
}

function hashLegacyKey(key: LegacyKey): string {
  const hash = createHash('sha256')
  hash.update(JSON.stringify(key))
  return 'sha256:' + hash.digest('hex')
}

/** True for pre-v2 manifests whose "wasm"/"zkey"/"vkey" are bare tokens, not resource paths. */
function hasLegacyReferences(info: KeyManifestEntry): boolean {
  return [info.wasm, info.zkey, info.vkey].every(
    (ref) => typeof ref === 'string' && ref.length > 0 && ref.length < 32 && !/[/.]/.test(ref)
  )
}

function isLegacyKey(key: CircuitArtifacts | LegacyKey): key is LegacyKey {
  return typeof (key as LegacyKey).wasm === 'string'
}

class KeyManager {
  private manifest?: KeyManifest
  private loadedKeys = new Map<string, CircuitArtifacts | LegacyKey>()
  private hashes = new Map<string, string>()
  private verified = false
  /** Per-circuit registry compatibility result from the most recent loadKeys() (ZV-113). */
  private compatibility = new Map<string, CircuitVersionCheck>()
  /** Circuits whose registry check threw during loadKeys(), by circuit name, re-thrown by getKey()/assertCircuitReady(). */
  private unsupported = new Map<string, UnsupportedCircuitVersionError>()

  async loadKeys(options: KeyLoadOptions): Promise<void> {
    console.log('Loading proving keys...')
    this.compatibility.clear()
    this.unsupported.clear()

    let manifest: KeyManifest
    let base = ''
    let hasLegacyKeys = false

    if (options.artifacts && Object.keys(options.artifacts).length > 0) {
      // Real, decoded artifacts supplied directly (embedded/bundled keys).
      manifest =
        options.manifest ??
        ({
          version: 'embedded',
          keys: Object.fromEntries(
            Object.entries(options.artifacts).map(([name, a]) => [
              name,
              { wasm: '', zkey: '', vkey: '', hash: computeArtifactHash(a), size: computeArtifactSize(a) }
            ])
          )
        } as KeyManifest)
      this.assertManifestHash(manifest, options.expectedManifestHash)
      for (const [name, artifactsForCircuit] of Object.entries(options.artifacts)) {
        const decoded: CircuitArtifacts = {
          wasm: toBytes(artifactsForCircuit.wasm),
          zkey: toBytes(artifactsForCircuit.zkey),
          vkey: assertVerificationKey(artifactsForCircuit.vkey)
        }
        this.loadedKeys.set(name, decoded)
        this.hashes.set(name, computeArtifactHash(decoded))
      }
    } else {
      if (options.manifest) {
        manifest = options.manifest
        base = manifest.baseUrl ?? ''
      } else if (options.manifestUrl) {
        manifest = await this.fetchManifest(options.manifestUrl, options.fetchImpl)
        base = new URL('.', options.manifestUrl).toString()
      } else if (options.offlinePack) {
        const offlineBase = typeof options.offlinePack === 'string' ? options.offlinePack : './keys'
        base = offlineBase.replace(/\/?$/, '/')
        manifest = await this.fetchManifest(base + 'manifest.json', options.fetchImpl)
      } else {
        throw new InvalidInputError('Must provide manifestUrl, offlinePack, manifest or artifacts')
      }

      this.assertManifestHash(manifest, options.expectedManifestHash)

      for (const [circuitName, info] of Object.entries(manifest.keys)) {
        if (hasLegacyReferences(info)) {
          // Backwards compatibility: pre-v2 manifests carried placeholder
          // references instead of artifact URLs. Record the keys so the
          // registry compatibility gate still works, but never prove with them.
          const legacy = legacyKey(circuitName)
          this.loadedKeys.set(circuitName, legacy)
          this.hashes.set(circuitName, hashLegacyKey(legacy))
          hasLegacyKeys = true
        } else {
          const circuitArtifacts = await this.loadArtifact(circuitName, info, base, options.fetchImpl)
          this.loadedKeys.set(circuitName, circuitArtifacts)
          this.hashes.set(circuitName, computeArtifactHash(circuitArtifacts))
        }
      }
    }

    this.manifest = manifest
    this.verified = true
    // Re-check against the manifest so a bad size/hash cannot slip through.
    // Legacy manifests are checked by verifyKeyIntegrity() instead, so that a
    // caller can use the registry gate without shipping real artifacts.
    if (!hasLegacyKeys) this.verifyIntegrityOrThrow()

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
  private async checkCompatibility(registry: RegistryClient): Promise<void> {
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

  /** Verify all loaded artifacts against the manifest. Returns false on mismatch. */
  async verifyKeyIntegrity(): Promise<boolean> {
    try {
      this.verifyIntegrityOrThrow()
      return this.verified
    } catch {
      this.verified = false
      return false
    }
  }

  /** Verify all loaded artifacts, throwing a typed error on mismatch. */
  verifyIntegrityOrThrow(): void {
    if (!this.manifest) throw new KeyLoadError('No key manifest has been loaded')
    if (this.loadedKeys.size === 0) throw new KeyLoadError('No key artifacts have been loaded')

    for (const [circuitName, info] of Object.entries(this.manifest.keys)) {
      const key = this.loadedKeys.get(circuitName)
      if (!key) {
        throw new KeyIntegrityError(`Key not loaded: ${circuitName}`)
      }
      if (isLegacyKey(key)) {
        // Pre-v2 manifests hashed the placeholder object itself.
        const hash = hashLegacyKey(key)
        if (info.hash && normaliseHash(info.hash) !== hash) {
          throw new KeyIntegrityError(`Hash mismatch for ${circuitName}`, {
            expected: normaliseHash(info.hash),
            actual: hash
          })
        }
        continue
      }
      const artifacts = key
      if (artifacts.wasm.length === 0 || artifacts.zkey.length === 0) {
        throw new KeyIntegrityError(`Key artifact is empty: ${circuitName}`)
      }
      const size = computeArtifactSize(artifacts)
      if (info.size > 0 && size !== info.size) {
        throw new KeyIntegrityError(`Size mismatch for ${circuitName}`, {
          expected: info.size,
          actual: size
        })
      }
      const hash = computeArtifactHash(artifacts)
      if (info.hash && normaliseHash(info.hash) !== hash) {
        throw new KeyIntegrityError(`Hash mismatch for ${circuitName}`, {
          expected: normaliseHash(info.hash),
          actual: hash
        })
      }
    }
    this.verified = true
  }

  /** Get decoded artifacts for a circuit. */
  getKey(circuitName: string): CircuitArtifacts {
    const key = this.loadedKeys.get(circuitName)
    if (!key) throw new KeysNotLoadedError(`No artifacts loaded for circuit: ${circuitName}`)
    if (!this.verified) throw new KeysNotVerifiedError()
    this.assertCircuitReady(circuitName)
    return key as CircuitArtifacts
  }

  /** Get the pinned verification key for a circuit. */
  getVerificationKey(circuitName = 'vote'): VerificationKey {
    return this.getKey(circuitName).vkey
  }

  isLoaded(): boolean {
    return this.loadedKeys.size > 0
  }

  listLoadedKeys(): string[] {
    return Array.from(this.loadedKeys.keys())
  }

  /** Discard all loaded artifacts (mainly for tests / key rotation). */
  reset(): void {
    this.manifest = undefined
    this.loadedKeys.clear()
    this.hashes.clear()
    this.verified = false
    this.compatibility.clear()
    this.unsupported.clear()
  }

  private async fetchManifest(url: string, fetchImpl?: typeof fetch): Promise<KeyManifest> {
    try {
      const bytes = await this.fetchBytes(url, fetchImpl)
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as KeyManifest
      if (!parsed || typeof parsed.version !== 'string' || !parsed.keys || typeof parsed.keys !== 'object') {
        throw new KeyIntegrityError('Malformed key manifest', { url })
      }
      return parsed
    } catch (err) {
      if (err instanceof KeyIntegrityError) throw err
      throw new KeyLoadError(`Failed to load key manifest: ${url}`, { cause: err })
    }
  }

  private async loadArtifact(
    circuitName: string,
    info: KeyManifestEntry,
    base: string,
    fetchImpl?: typeof fetch
  ): Promise<CircuitArtifacts> {
    if (!info.wasm || !info.zkey || !info.vkey) {
      throw new KeyLoadError(`Manifest is missing artifact references for ${circuitName}`)
    }

    const wasmBytes = await this.fetchCached(info.wasm, base, fetchImpl)
    const zkeyBytes = await this.fetchCached(info.zkey, base, fetchImpl)
    const vkeyBytes = await this.fetchCached(info.vkey, base, fetchImpl)
    let vkey: VerificationKey
    try {
      vkey = assertVerificationKey(JSON.parse(new TextDecoder().decode(vkeyBytes)))
    } catch (err) {
      if (err instanceof KeyIntegrityError) throw err
      throw new KeyIntegrityError(`Malformed verification key for ${circuitName}`, { cause: err })
    }

    return { wasm: wasmBytes, zkey: zkeyBytes, vkey }
  }

  private async fetchCached(ref: string, base: string, fetchImpl?: typeof fetch): Promise<Uint8Array> {
    const url = this.resolve(ref, base)
    const cacheKey = `zkvote:artifact:${url}`
    const cached = getCached<Uint8Array>(cacheKey)
    if (cached) return cached
    const bytes = await this.fetchBytes(url, fetchImpl)
    setCached(cacheKey, bytes, bytes.byteLength, { hash: undefined })
    return bytes
  }

  private resolve(ref: string, base: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return ref
    if (!base) return ref
    if (/^https?:\/\//i.test(base)) return new URL(ref, base).toString()
    return base.replace(/\/?$/, '/') + ref.replace(/^\.?\//, '')
  }

  private async fetchBytes(url: string, fetchImpl?: typeof fetch): Promise<Uint8Array> {
    if (/^https?:\/\//i.test(url)) {
      const doFetch = fetchImpl ?? globalThis.fetch
      if (typeof doFetch !== 'function') {
        throw new NetworkError(`fetch is unavailable; cannot load ${url}`)
      }
      let response: Response
      try {
        response = await doFetch(url)
      } catch (err) {
        throw new NetworkError(`Failed to fetch ${url}`, { cause: err })
      }
      if (!response.ok) {
        throw new NetworkError(`Failed to fetch ${url}: ${response.status} ${response.statusText}`)
      }
      const bytes = await this.responseBytes(response)
      if (bytes.byteLength === 0) throw new KeyIntegrityError(`Empty artifact: ${url}`)
      return bytes
    }

    // Local file path (Node / Electron). Dynamic import keeps browser bundles clean.
    try {
      // @ts-ignore - dynamic import of a Node builtin; tsup dts uses an older module target
      const { readFile } = await import('node:fs/promises')
      const data: Uint8Array = await readFile(url)
      if (data.byteLength === 0) throw new KeyIntegrityError(`Empty artifact: ${url}`)
      return data
    } catch (err) {
      if (err instanceof KeyIntegrityError) throw err
      throw new KeyLoadError(`Failed to read local artifact: ${url}`, { cause: err })
    }
  }

  /** Read a response body, tolerating test doubles that only implement json(). */
  private async responseBytes(response: Response): Promise<Uint8Array> {
    if (typeof response.arrayBuffer === 'function') {
      const buffer = await response.arrayBuffer()
      if (!buffer || buffer.byteLength === 0) throw new KeyIntegrityError('Empty response body')
      return new Uint8Array(buffer)
    }
    const json = (response as unknown as { json?: () => Promise<unknown> }).json
    if (typeof json === 'function') {
      const data = await json.call(response)
      return new TextEncoder().encode(JSON.stringify(data))
    }
    throw new KeyIntegrityError('Response body is unreadable')
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
}

// Singleton instance
const keyManager = new KeyManager()

/** Load proving keys from manifest, offline pack or explicit artifacts. */
export async function loadKeys(options: KeyLoadOptions): Promise<void> {
  return keyManager.loadKeys(options)
}

/** Verify integrity of loaded keys (returns false rather than throwing). */
export async function verifyKeyIntegrity(): Promise<boolean> {
  return keyManager.verifyKeyIntegrity()
}

/** Verify integrity of loaded keys, throwing a typed error on mismatch. */
export function verifyKeyIntegrityOrThrow(): void {
  keyManager.verifyIntegrityOrThrow()
}

/** Get decoded artifacts for a circuit. */
export function getKey(circuitName: string): CircuitArtifacts {
  return keyManager.getKey(circuitName)
}

/** Get the pinned verification key for a circuit. */
export function getVerificationKey(circuitName = 'vote'): VerificationKey {
  return keyManager.getVerificationKey(circuitName)
}

/** Check if keys are loaded. */
export function areKeysLoaded(): boolean {
  return keyManager.isLoaded()
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
 * before/independent of the hash-integrity check.
 */
export function assertCircuitReady(circuitName: string): void {
  keyManager.assertCircuitReady(circuitName)
}

/** List loaded circuit names. */
export function listLoadedKeys(): string[] {
  return keyManager.listLoadedKeys()
}

/** Discard all loaded artifacts. */
export function resetKeys(): void {
  keyManager.reset()
}
