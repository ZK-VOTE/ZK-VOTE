/**
 * Common types for ZKVote SDK
 */

export interface CircuitInputs {
  [key: string]: string | number | bigint | string[] | number[] | bigint[]
}

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

export interface SDKError {
  code: string
  message: string
  details?: any
}

export const ErrorCodes = {
  KEYS_NOT_LOADED: 'KEYS_NOT_LOADED',
  KEYS_NOT_VERIFIED: 'KEYS_NOT_VERIFIED',
  INVALID_INPUT: 'INVALID_INPUT',
  PROOF_GENERATION_FAILED: 'PROOF_GENERATION_FAILED',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  CACHE_ERROR: 'CACHE_ERROR'
} as const
