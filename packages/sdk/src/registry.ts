/**
 * Circuit registry client (ZV-113 / Issue #953).
 *
 * The SDK previously only had a static `CIRCUIT_COMPATIBILITY` constant
 * (see version.ts) with no way to check it against what is actually
 * registered server-side, so a client could silently use an unsupported
 * circuit version. This module talks to the backend's circuit registry
 * (`backend/src/routes/circuits.ts`, `GET /circuits/compatibility-matrix`)
 * to find the real current version for a circuit.
 *
 * `RegistryClient` is an interface rather than a hardcoded fetch call so
 * tests (and air-gapped/offline SDK consumers) can supply a fixture
 * instead of making a network call.
 */

export interface CircuitMatrixEntry {
  circuitId: string
  /** Current version registered server-side, or null if unknown to the registry. */
  currentVersion: number | null
  /** [currentVersion, currentVersion - 1], clamped at 1 - the SDK's "N and N-1" window. */
  supportedVersions: number[]
}

export interface RegistryClient {
  getCompatibilityMatrix(): Promise<CircuitMatrixEntry[]>
}

/**
 * HTTP registry client backed by the real endpoint. `baseUrl` is the
 * backend's origin (e.g. `https://api.zkvote.io`), not including
 * `/circuits/...`.
 */
export function createHttpRegistryClient(baseUrl: string): RegistryClient {
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  return {
    async getCompatibilityMatrix(): Promise<CircuitMatrixEntry[]> {
      const response = await fetch(`${normalizedBase}/circuits/compatibility-matrix`)
      if (!response.ok) {
        throw new Error(
          `Circuit registry request failed: ${response.status} ${response.statusText}`
        )
      }
      const data = (await response.json()) as { matrix: CircuitMatrixEntry[] }
      if (!Array.isArray(data.matrix)) {
        throw new Error('Circuit registry returned a malformed compatibility matrix')
      }
      return data.matrix
    },
  }
}

/**
 * A fixed-fixture registry client for tests and offline/air-gapped use,
 * where the matrix is bundled rather than fetched live.
 */
export function createStaticRegistryClient(matrix: CircuitMatrixEntry[]): RegistryClient {
  return {
    async getCompatibilityMatrix(): Promise<CircuitMatrixEntry[]> {
      return matrix
    },
  }
}
