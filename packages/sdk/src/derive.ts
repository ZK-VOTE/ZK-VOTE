/**
 * Identity derivation functions
 */

import { createHash } from 'crypto'

/**
 * Derive identity commitment from secret
 */
export function deriveIdentityCommitment(secret: Uint8Array): string {
  if (secret.length !== 32) {
    throw new Error('Secret must be 32 bytes')
  }

  // Use Poseidon hash in production
  // For now, use SHA256 as placeholder
  const hash = createHash('sha256')
  hash.update(secret)
  hash.update(Buffer.from('identity_commitment'))
  
  return '0x' + hash.digest('hex')
}

/**
 * Derive nullifier from secret and poll ID
 */
export function deriveNullifier(secret: Uint8Array, pollId: string): string {
  if (secret.length !== 32) {
    throw new Error('Secret must be 32 bytes')
  }

  if (!pollId) {
    throw new Error('Poll ID is required')
  }

  // Use Poseidon hash in production
  const hash = createHash('sha256')
  hash.update(secret)
  hash.update(Buffer.from(pollId))
  hash.update(Buffer.from('nullifier'))
  
  return '0x' + hash.digest('hex')
}

/**
 * Derive trapdoor for membership tree
 */
export function deriveTrapdoor(secret: Uint8Array): string {
  if (secret.length !== 32) {
    throw new Error('Secret must be 32 bytes')
  }

  const hash = createHash('sha256')
  hash.update(secret)
  hash.update(Buffer.from('trapdoor'))
  
  return '0x' + hash.digest('hex')
}

/**
 * Generate random secret
 */
export function generateSecret(): Uint8Array {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    return crypto.getRandomValues(new Uint8Array(32))
  }
  
  // Node.js fallback
  const { randomBytes } = require('crypto')
  return randomBytes(32)
}
