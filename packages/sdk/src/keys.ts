/**
 * Key management and verification
 */

import { createHash } from 'crypto'

export interface KeyManifest {
  version: string
  keys: {
    [circuitName: string]: {
      wasm: string
      zkey: string
      vkey: string
      hash: string
      size: number
    }
  }
}

export interface KeyLoadOptions {
  manifestUrl?: string
  offlinePack?: boolean
  cacheDir?: string
}

class KeyManager {
  private manifest?: KeyManifest
  private loadedKeys: Map<string, any> = new Map()
  private verified: boolean = false

  /**
   * Load proving keys from manifest
   */
  async loadKeys(options: KeyLoadOptions): Promise<void> {
    console.log('Loading proving keys...')

    if (options.offlinePack) {
      await this.loadOfflineKeys()
    } else if (options.manifestUrl) {
      await this.loadFromManifest(options.manifestUrl)
    } else {
      throw new Error('Must provide either manifestUrl or offlinePack option')
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

  private async loadFromManifest(manifestUrl: string): Promise<void> {
    // Fetch manifest
    const response = await fetch(manifestUrl)
    if (!response.ok) {
      throw new Error(`Failed to fetch manifest: ${response.statusText}`)
    }

    const manifest = (await response.json()) as KeyManifest
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

  private async loadOfflineKeys(): Promise<void> {
    // Load keys bundled with the SDK
    console.log('Loading offline key pack...')
    
    // Placeholder - would load from bundled files
    this.manifest = {
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

    this.loadedKeys.set('vote', {
      wasm: 'bundled_wasm',
      zkey: 'bundled_zkey',
      vkey: 'bundled_vkey'
    })
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
