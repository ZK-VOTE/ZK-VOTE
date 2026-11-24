/**
 * SDK version and compatibility information
 */
import type { RegistryClient } from './registry'

export const VERSION = '1.0.0'

/**
 * Circuit compatibility matrix
 * SDK version N supports circuits version N and N-1
 *
 * NOTE (ZV-113 / #953): this is a static, offline declaration of what this
 * SDK build *was written* to support. It is not checked against anything
 * at runtime - see `checkCircuitVersion()` below for the registry-backed
 * check that actually verifies a specific circuit's *currently deployed*
 * version, which is what decides whether the SDK will refuse to prove.
 */
export const CIRCUIT_COMPATIBILITY = {
  '1.0.0': ['1.0', '0.9'],
  '0.9.0': ['0.9', '0.8']
}

/**
 * Check if circuit version is compatible with current SDK, per the static
 * table above only. Kept for backward compatibility; prefer
 * `checkCircuitVersion()` for anything that gates actual proving.
 */
export function isCircuitCompatible(circuitVersion: string): boolean {
  const compatible = CIRCUIT_COMPATIBILITY[VERSION as keyof typeof CIRCUIT_COMPATIBILITY]
  return compatible ? compatible.includes(circuitVersion) : false
}

/**
 * Get SDK version
 */
export function getVersion(): string {
  return VERSION
}

/**
 * Get supported circuit versions
 */
export function getSupportedCircuitVersions(): string[] {
  return CIRCUIT_COMPATIBILITY[VERSION as keyof typeof CIRCUIT_COMPATIBILITY] || []
}

/**
 * Result of a registry-backed circuit version check (ZV-113).
 */
export interface CircuitVersionCheck {
  circuitId: string
  declaredVersion: number
  /** The circuit's actual current version per the registry, or null if the registry doesn't know this circuit at all. */
  registryCurrentVersion: number | null
  compatible: boolean
  /** True when `declaredVersion` is one behind the registry's current version (the "N-1" window). */
  usedFallback: boolean
  warning?: string
}

/**
 * Thrown by `checkCircuitVersion()` when a circuit version is not in the
 * SDK's supported N/N-1 window relative to the registry's current
 * version, or when the registry does not know the circuit at all. This is
 * what makes "the SDK refuses to prove with an unsupported circuit
 * version" an actual thrown error rather than a comment.
 */
export class UnsupportedCircuitVersionError extends Error {
  readonly check: CircuitVersionCheck

  constructor(check: CircuitVersionCheck) {
    super(
      check.registryCurrentVersion === null
        ? `Circuit "${check.circuitId}" is not a circuit this registry knows about.`
        : `Circuit "${check.circuitId}" version ${check.declaredVersion} is not supported ` +
          `(registry current version: ${check.registryCurrentVersion}). This SDK (${VERSION}) ` +
          `only supports a circuit's current version and the one immediately before it.`
    )
    this.name = 'UnsupportedCircuitVersionError'
    this.check = check
  }
}

/**
 * Runtime circuit-compatibility check (ZV-113). Unlike `isCircuitCompatible()`
 * (static table only), this asks `registry` for the circuit's *actual*
 * currently registered version and checks `declaredVersion` against it:
 *
 * - equal to the registry's current version: fully compatible.
 * - exactly one behind (N-1): compatible, but `usedFallback` is true and a
 *   `warning` is set - callers should surface this to the user/operator.
 * - anything else (including the registry not knowing the circuit at all):
 *   throws `UnsupportedCircuitVersionError`.
 */
export async function checkCircuitVersion(
  circuitId: string,
  declaredVersion: number,
  registry: RegistryClient
): Promise<CircuitVersionCheck> {
  const matrix = await registry.getCompatibilityMatrix()
  const entry = matrix.find((e) => e.circuitId === circuitId)
  const registryCurrentVersion = entry?.currentVersion ?? null

  if (registryCurrentVersion === null) {
    throw new UnsupportedCircuitVersionError({
      circuitId,
      declaredVersion,
      registryCurrentVersion,
      compatible: false,
      usedFallback: false,
    })
  }

  if (declaredVersion === registryCurrentVersion) {
    return {
      circuitId,
      declaredVersion,
      registryCurrentVersion,
      compatible: true,
      usedFallback: false,
    }
  }

  if (declaredVersion === registryCurrentVersion - 1) {
    return {
      circuitId,
      declaredVersion,
      registryCurrentVersion,
      compatible: true,
      usedFallback: true,
      warning:
        `Using circuit "${circuitId}" version ${declaredVersion}, one version behind the ` +
        `registry's current version ${registryCurrentVersion} (N-1 fallback window). ` +
        `Upgrade soon - this SDK does not support N-2.`,
    }
  }

  throw new UnsupportedCircuitVersionError({
    circuitId,
    declaredVersion,
    registryCurrentVersion,
    compatible: false,
    usedFallback: false,
  })
}

/**
 * Semver and circuit lifecycle policy specification (ZV-033)
 */
export const SEMVER_POLICY = {
  MAJOR: 'Breaking API changes or dropping circuit version N-1 compatibility',
  MINOR: 'Backwards-compatible features or adding support for new circuit version N+1',
  PATCH: 'Backwards-compatible bug fixes and internal performance optimizations',
} as const

export const DEPRECATION_POLICY = {
  SUPPORTED_WINDOW: 'Current circuit version (N) and immediately prior version (N-1)',
  DEPRECATION_WARNING_WINDOW: 'N-1 circuit fallback with warning notification',
  UNSUPPORTED_ACTION: 'Refuse proof generation with UnsupportedCircuitVersionError',
  DEPRECATION_CYCLE_DAYS: 90,
} as const

/**
 * Validates whether a given tarball hex checksum matches the expected manifest hash.
 */
export function verifyChecksum(actualHex: string, expectedHex: string): boolean {
  if (!actualHex || !expectedHex) return false
  return actualHex.toLowerCase().trim() === expectedHex.toLowerCase().trim()
}

