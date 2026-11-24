/**
 * Cache policy and management
 */

export interface CachePolicy {
  enabled: boolean
  ttl: number // Time to live in seconds
  maxSize: number // Max cache size in bytes
  strategy: 'lru' | 'fifo' | 'lfu'
}

export interface CacheEntry<T> {
  key: string
  value: T
  timestamp: number
  accessCount: number
  size: number
}

class CacheManager<T = any> {
  private cache: Map<string, CacheEntry<T>> = new Map()
  private policy: CachePolicy = {
    enabled: true,
    ttl: 3600, // 1 hour default
    maxSize: 100 * 1024 * 1024, // 100MB default
    strategy: 'lru'
  }
  private currentSize: number = 0

  /**
   * Configure cache policy
   */
  configure(policy: Partial<CachePolicy>): void {
    this.policy = { ...this.policy, ...policy }
  }

  /**
   * Get value from cache
   */
  get(key: string): T | undefined {
    if (!this.policy.enabled) {
      return undefined
    }

    const entry = this.cache.get(key)
    if (!entry) {
      return undefined
    }

    // Check TTL
    const age = (Date.now() - entry.timestamp) / 1000
    if (age > this.policy.ttl) {
      this.delete(key)
      return undefined
    }

    // Update access count for LFU
    entry.accessCount++
    
    return entry.value
  }

  /**
   * Set value in cache
   */
  set(key: string, value: T, sizeBytes: number): void {
    if (!this.policy.enabled) {
      return
    }

    // Check if we need to evict
    while (this.currentSize + sizeBytes > this.policy.maxSize && this.cache.size > 0) {
      this.evict()
    }

    // Add to cache
    const entry: CacheEntry<T> = {
      key,
      value,
      timestamp: Date.now(),
      accessCount: 0,
      size: sizeBytes
    }

    this.cache.set(key, entry)
    this.currentSize += sizeBytes
  }

  /**
   * Delete from cache
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key)
    if (!entry) {
      return false
    }

    this.cache.delete(key)
    this.currentSize -= entry.size
    return true
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    this.cache.clear()
    this.currentSize = 0
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      entries: this.cache.size,
      sizeBytes: this.currentSize,
      maxSize: this.policy.maxSize,
      utilizationPercent: (this.currentSize / this.policy.maxSize) * 100
    }
  }

  /**
   * Evict entry based on policy
   */
  private evict(): void {
    let keyToEvict: string | undefined

    switch (this.policy.strategy) {
      case 'lru':
        keyToEvict = this.evictLRU()
        break
      case 'fifo':
        keyToEvict = this.evictFIFO()
        break
      case 'lfu':
        keyToEvict = this.evictLFU()
        break
    }

    if (keyToEvict) {
      this.delete(keyToEvict)
    }
  }

  private evictLRU(): string | undefined {
    let oldest: CacheEntry<T> | undefined
    let oldestKey: string | undefined

    for (const [key, entry] of this.cache.entries()) {
      if (!oldest || entry.timestamp < oldest.timestamp) {
        oldest = entry
        oldestKey = key
      }
    }

    return oldestKey
  }

  private evictFIFO(): string | undefined {
    // First key inserted
    return this.cache.keys().next().value
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

/**
 * Configure cache policy
 */
export function configureCache(policy: Partial<CachePolicy>): void {
  cacheManager.configure(policy)
}

/**
 * Get from cache
 */
export function getCached<T>(key: string): T | undefined {
  return cacheManager.get(key)
}

/**
 * Set in cache
 */
export function setCached<T>(key: string, value: T, sizeBytes: number): void {
  cacheManager.set(key, value, sizeBytes)
}

/**
 * Clear cache
 */
export function clearCache(): void {
  cacheManager.clear()
}

/**
 * Get cache stats
 */
export function getCacheStats() {
  return cacheManager.getStats()
}
