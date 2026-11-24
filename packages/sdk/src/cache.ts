/**
 * Cache policy and management.
 *
 * Entries are verified on read: TTL, schema version and an optional SHA-256
 * integrity digest are all checked. A corrupt or stale entry is evicted rather
 * than returned to the caller.
 */

// @ts-ignore - subpath export needs node16 resolution in tsup's dts pass
import { sha256 } from '@noble/hashes/sha256'
// @ts-ignore - subpath export needs node16 resolution in tsup's dts pass
import { bytesToHex } from '@noble/hashes/utils'

export interface CachePolicy {
  enabled: boolean
  ttl: number // Time to live in seconds
  maxSize: number // Max cache size in bytes
  strategy: 'lru' | 'fifo' | 'lfu'
  /** Schema/format version. Changing it invalidates all existing entries. */
  version?: string
  /** Compute and check a SHA-256 digest for every cached value. Default: true. */
  verifyIntegrity?: boolean
}

export interface CacheEntry<T> {
  key: string
  value: T
  timestamp: number
  /** Last access time (used by LRU eviction). */
  lastAccess: number
  accessCount: number
  size: number
  /** SHA-256 digest of the value, when integrity verification is enabled. */
  hash?: string
  /** Policy version the entry was written under. */
  version?: string
}

export interface CacheSetOptions {
  /** Precomputed SHA-256 digest; if omitted it is computed from `value`. */
  hash?: string
  /** Override the policy version for this entry. */
  version?: string
}

/** Deterministic serialisation for non-binary cached values. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const obj = value as Record<string, unknown>
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}

/** SHA-256 (hex) of a cached value. Binary values are hashed verbatim. */
export function computeIntegrityHash(value: unknown): string {
  let bytes: Uint8Array
  if (value instanceof Uint8Array) {
    bytes = value
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value)
  } else if (typeof value === 'string') {
    bytes = new TextEncoder().encode(value)
  } else {
    bytes = new TextEncoder().encode(stableStringify(value))
  }
  return bytesToHex(sha256(bytes))
}

class CacheManager<T = any> {
  private cache: Map<string, CacheEntry<T>> = new Map()
  private policy: CachePolicy = {
    enabled: true,
    ttl: 3600, // 1 hour default
    maxSize: 100 * 1024 * 1024, // 100MB default
    strategy: 'lru',
    version: '1',
    verifyIntegrity: true
  }
  private currentSize = 0
  private hits = 0
  private misses = 0
  private evictions = 0
  private integrityFailures = 0

  /** Configure cache policy. Changing the version invalidates cached entries. */
  configure(policy: Partial<CachePolicy>): void {
    const previousVersion = this.policy.version
    this.policy = { ...this.policy, ...policy }
    if (policy.version !== undefined && policy.version !== previousVersion) {
      this.clear()
    }
    if (policy.maxSize !== undefined && this.currentSize > this.policy.maxSize) {
      while (this.currentSize > this.policy.maxSize && this.cache.size > 0) this.evict()
    }
  }

  /** Get value from cache, verifying TTL, version and integrity digest. */
  get(key: string): T | undefined {
    if (!this.policy.enabled) {
      this.misses++
      return undefined
    }

    const entry = this.cache.get(key)
    if (!entry) {
      this.misses++
      return undefined
    }

    const age = (Date.now() - entry.timestamp) / 1000
    if (age > this.policy.ttl || (entry.version ?? '1') !== (this.policy.version ?? '1')) {
      this.delete(key)
      this.misses++
      return undefined
    }

    if (this.policy.verifyIntegrity && entry.hash && computeIntegrityHash(entry.value) !== entry.hash) {
      // Do not hand back corrupted data.
      this.delete(key)
      this.integrityFailures++
      this.misses++
      return undefined
    }

    entry.accessCount++
    entry.lastAccess = Date.now()
    this.hits++
    return entry.value
  }

  /** Insert a value, evicting as needed. */
  set(key: string, value: T, sizeBytes: number, options: CacheSetOptions = {}): void {
    if (!this.policy.enabled) return

    const hash = options.hash ?? (this.policy.verifyIntegrity ? computeIntegrityHash(value) : undefined)
    const version = options.version ?? this.policy.version

    // Replace an existing entry first so the accounting stays correct.
    if (this.cache.has(key)) this.delete(key)

    while (this.currentSize + sizeBytes > this.policy.maxSize && this.cache.size > 0) {
      this.evict()
    }

    // A single value larger than the whole cache cannot be stored.
    if (sizeBytes > this.policy.maxSize) return

    const now = Date.now()
    this.cache.set(key, {
      key,
      value,
      timestamp: now,
      lastAccess: now,
      accessCount: 0,
      size: sizeBytes,
      hash,
      version
    })
    this.currentSize += sizeBytes
  }

  delete(key: string): boolean {
    const entry = this.cache.get(key)
    if (!entry) return false
    const removed = this.cache.delete(key)
    this.currentSize -= entry.size
    return removed
  }

  clear(): void {
    this.cache.clear()
    this.currentSize = 0
  }

  getStats() {
    return {
      entries: this.cache.size,
      sizeBytes: this.currentSize,
      maxSize: this.policy.maxSize,
      utilizationPercent: this.policy.maxSize > 0 ? (this.currentSize / this.policy.maxSize) * 100 : 0,
      version: this.policy.version,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      integrityFailures: this.integrityFailures
    }
  }

  private evict(): void {
    let keyToEvict: string | undefined

    switch (this.policy.strategy) {
      case 'lru':
        keyToEvict = this.evictLRU()
        break
      case 'fifo':
        keyToEvict = this.cache.keys().next().value as string | undefined
        break
      case 'lfu':
        keyToEvict = this.evictLFU()
        break
    }

    if (keyToEvict !== undefined) {
      this.delete(keyToEvict)
      this.evictions++
    }
  }

  private evictLRU(): string | undefined {
    let oldest: CacheEntry<T> | undefined
    let oldestKey: string | undefined

    for (const [key, entry] of this.cache.entries()) {
      if (!oldest || entry.lastAccess < oldest.lastAccess) {
        oldest = entry
        oldestKey = key
      }
    }
    return oldestKey
  }

  private evictLFU(): string | undefined {
    let leastUsed: CacheEntry<T> | undefined
    let leastUsedKey: string | undefined

    for (const [key, entry] of this.cache.entries()) {
      if (!leastUsed || entry.accessCount < leastUsed.accessCount) {
        leastUsed = entry
        leastUsedKey = key
      }
    }
    return leastUsedKey
  }
}

// Singleton instance
const cacheManager = new CacheManager()

/** Configure cache policy. */
export function configureCache(policy: Partial<CachePolicy>): void {
  cacheManager.configure(policy)
}

/** Get from cache (undefined on miss, expiry, version mismatch or corruption). */
export function getCached<T>(key: string): T | undefined {
  return cacheManager.get(key) as T | undefined
}

/** Set in cache, with optional integrity digest and version. */
export function setCached<T>(key: string, value: T, sizeBytes: number, options?: CacheSetOptions): void {
  cacheManager.set(key, value, sizeBytes, options)
}

/** Remove a single entry. */
export function deleteCached(key: string): boolean {
  return cacheManager.delete(key)
}

/** Clear entire cache. */
export function clearCache(): void {
  cacheManager.clear()
}

/** Get cache statistics. */
export function getCacheStats() {
  return cacheManager.getStats()
}
