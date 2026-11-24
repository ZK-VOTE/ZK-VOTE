/**
 * Common types and typed errors for ZKVote SDK
 */

export interface CircuitInputs {
  [key: string]: string | number | bigint | string[] | number[] | bigint[]
}

/**
 * A Groth16 verification key as exported by `snarkjs zkey export verificationkey`.
 * Coordinates are decimal strings over the BN254 scalar/base fields.
 */
export interface VerificationKey {
  protocol: string
  curve: string
  nPublic: number
  vk_alpha_1: string[]
  vk_beta_2: string[][]
  vk_gamma_2: string[][]
  vk_delta_2: string[][]
  vk_alphabeta_12: string[][][]
  IC: string[][]
}

/**
 * Legacy error codes. Kept for backwards compatibility; the typed error
 * classes below are the recommended way to discriminate failures.
 */
export const ErrorCodes = {
  KEYS_NOT_LOADED: 'KEYS_NOT_LOADED',
  KEYS_NOT_VERIFIED: 'KEYS_NOT_VERIFIED',
  INVALID_INPUT: 'INVALID_INPUT',
  PROOF_GENERATION_FAILED: 'PROOF_GENERATION_FAILED',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  CACHE_ERROR: 'CACHE_ERROR',
  KEY_LOAD_FAILED: 'KEY_LOAD_FAILED',
  KEY_INTEGRITY_FAILED: 'KEY_INTEGRITY_FAILED',
  WORKER_UNAVAILABLE: 'WORKER_UNAVAILABLE',
  ABORTED: 'ABORTED'
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

export interface SDKError {
  code: string
  message: string
  details?: unknown
}

/**
 * Base class for every error thrown by the SDK.
 *
 * `instanceof` checks work across the whole hierarchy, while `code` gives a
 * stable, serialisable discriminator for callers that cross a process or
 * worker boundary.
 */
export class ZKVoteError extends Error implements SDKError {
  readonly code: string
  readonly details?: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.details = details
    // Maintain a proper prototype chain when targeting ES5/ES2015.
    Object.setPrototypeOf(this, new.target.prototype)
  }

  toJSON(): SDKError {
    return { code: this.code, message: this.message, details: this.details }
  }
}

/** An argument failed validation. */
export class InvalidInputError extends ZKVoteError {
  constructor(message: string, details?: unknown) {
    super(ErrorCodes.INVALID_INPUT, message, details)
  }
}

/** `getKey()` was called before any artifacts were loaded. */
export class KeysNotLoadedError extends ZKVoteError {
  constructor(message = 'Proving keys are not loaded. Call loadKeys() first.', details?: unknown) {
    super(ErrorCodes.KEYS_NOT_LOADED, message, details)
  }
}

/** `getKey()` was called before integrity verification succeeded. */
export class KeysNotVerifiedError extends ZKVoteError {
  constructor(message = 'Proving keys have not been verified. Call verifyKeyIntegrity() first.', details?: unknown) {
    super(ErrorCodes.KEYS_NOT_VERIFIED, message, details)
  }
}

/** A manifest or artifact could not be fetched/read/decoded. */
export class KeyLoadError extends ZKVoteError {
  constructor(message: string, details?: unknown) {
    super(ErrorCodes.KEY_LOAD_FAILED, message, details)
  }
}

/** A downloaded artifact is missing, malformed, the wrong size or hash-mismatched. */
export class KeyIntegrityError extends ZKVoteError {
  constructor(message: string, details?: unknown) {
    super(ErrorCodes.KEY_INTEGRITY_FAILED, message, details)
  }
}

/** snarkjs witness calculation or proof generation failed. */
export class ProofGenerationError extends ZKVoteError {
  constructor(message: string, details?: unknown) {
    super(ErrorCodes.PROOF_GENERATION_FAILED, message, details)
  }
}

/** Cryptographic verification failed, or the proof/VK was malformed. */
export class VerificationError extends ZKVoteError {
  constructor(message: string, details?: unknown) {
    super(ErrorCodes.VERIFICATION_FAILED, message, details)
  }
}

/** A network request failed. */
export class NetworkError extends ZKVoteError {
  constructor(message: string, details?: unknown) {
    super(ErrorCodes.NETWORK_ERROR, message, details)
  }
}

/** Cache configuration or integrity verification failed. */
export class CacheError extends ZKVoteError {
  constructor(message: string, details?: unknown) {
    super(ErrorCodes.CACHE_ERROR, message, details)
  }
}

/** A requested worker runtime is not available in this environment. */
export class WorkerUnavailableError extends ZKVoteError {
  constructor(message: string, details?: unknown) {
    super(ErrorCodes.WORKER_UNAVAILABLE, message, details)
  }
}

/** The caller-supplied AbortSignal fired before proving completed. */
export class AbortError extends ZKVoteError {
  constructor(message = 'Proof generation was aborted', details?: unknown) {
    super(ErrorCodes.ABORTED, message, details)
  }
}

/** Options accepted by proving APIs that support cancellation. */
export interface ProveOptions {
  /** Cancels cooperative proving (main thread) or terminates the worker. */
  signal?: AbortSignal
  /** Circuit name to load artifacts for. Defaults to the API-specific circuit. */
  circuitName?: string
}
