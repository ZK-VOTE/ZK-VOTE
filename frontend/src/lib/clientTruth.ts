/**
 * Client/server circuit-version truth reconciliation (ZV-113 / #953, #755).
 *
 * `zkproof.ts`'s `fetchVersionedVK()` caches each circuit's VK locally and
 * only checks staleness against whatever version it happens to fetch
 * next - a client that goes a while without casting a vote for a given
 * circuit can keep a cached VK that has since fallen out of the backend's
 * supported N/N-1 window without ever finding out, which is exactly the
 * "clients can silently use an unsupported circuit version" gap described
 * in EPIC-004.
 *
 * This module is the reconciliation point: call `reconcileCircuitTruth()`
 * on reconnect (pairs with `queryClient`'s `refetchOnReconnect`, #755) or
 * periodically, to compare the locally cached circuit versions against the
 * backend's live compatibility matrix (`GET /circuits/compatibility-matrix`,
 * ZV-113) and invalidate anything that fell out of the supported window -
 * forcing the next proof attempt to fetch a current VK instead of silently
 * reusing a stale one.
 */
import { getCachedVK, invalidateVKCache } from "./zkproof";

export interface CompatibilityMatrixEntry {
  circuitId: string;
  currentVersion: number | null;
  supportedVersions: number[];
}

export type CircuitTruthStatus = "current" | "fallback" | "unsupported" | "unknown";

export interface CircuitTruthEntry {
  circuitId: string;
  cachedVersion: number | null;
  registryCurrentVersion: number | null;
  status: CircuitTruthStatus;
  warning?: string;
}

function relayerBaseUrl(): string {
  return (
    (import.meta as unknown as { env: Record<string, string> })?.env
      ?.VITE_RELAYER_URL ?? "http://localhost:3001"
  );
}

/** Fetch the backend's live circuit-compatibility matrix (ZV-113). */
export async function fetchCompatibilityMatrix(
  fetchFn: typeof fetch = fetch,
): Promise<CompatibilityMatrixEntry[]> {
  const res = await fetchFn(`${relayerBaseUrl()}/circuits/compatibility-matrix`);
  if (!res.ok) {
    throw new Error(`Failed to fetch compatibility matrix: ${res.status}`);
  }
  const data = (await res.json()) as { matrix?: unknown };
  if (!Array.isArray(data.matrix)) {
    throw new Error("Malformed compatibility matrix response");
  }
  return data.matrix as CompatibilityMatrixEntry[];
}

/**
 * Compare one circuit's locally cached version against the registry's
 * current version. Mirrors `packages/sdk/src/version.ts`'s
 * `checkCircuitVersion()` tiers (current / N-1 fallback / unsupported),
 * but never throws - the UI needs a status to render, not an exception.
 */
export function reconcileCircuitVersion(
  circuitId: string,
  cachedVersion: number | null,
  matrix: CompatibilityMatrixEntry[],
): CircuitTruthEntry {
  const entry = matrix.find((e) => e.circuitId === circuitId);
  const registryCurrentVersion = entry?.currentVersion ?? null;

  if (cachedVersion === null || registryCurrentVersion === null) {
    return { circuitId, cachedVersion, registryCurrentVersion, status: "unknown" };
  }
  if (cachedVersion === registryCurrentVersion) {
    return { circuitId, cachedVersion, registryCurrentVersion, status: "current" };
  }
  if (cachedVersion === registryCurrentVersion - 1) {
    return {
      circuitId,
      cachedVersion,
      registryCurrentVersion,
      status: "fallback",
      warning:
        `Using circuit "${circuitId}" version ${cachedVersion}, one version behind the ` +
        `current ${registryCurrentVersion} (N-1 fallback window). It will stop working once ` +
        `the backend moves past this window.`,
    };
  }
  return {
    circuitId,
    cachedVersion,
    registryCurrentVersion,
    status: "unsupported",
    warning:
      `Circuit "${circuitId}" cached version ${cachedVersion} is no longer supported ` +
      `(registry current version: ${registryCurrentVersion}). It must be refetched before voting.`,
  };
}

/**
 * Reconcile every circuit in `circuitIds` against the live compatibility
 * matrix. Any locally cached VK found to be `unsupported` is invalidated
 * (not re-fetched here - that stays `fetchVersionedVK`'s job, triggered
 * naturally the next time that circuit is used) so a stale VK can never be
 * silently reused once this has run.
 */
export async function reconcileCircuitTruth(
  circuitIds: string[],
  fetchFn: typeof fetch = fetch,
): Promise<CircuitTruthEntry[]> {
  const matrix = await fetchCompatibilityMatrix(fetchFn);
  const results: CircuitTruthEntry[] = [];

  for (const circuitId of circuitIds) {
    const entry = matrix.find((e) => e.circuitId === circuitId);
    // getCachedVK() needs a version to look up; the only versions a client
    // could legitimately have cached under the current policy are the
    // registry's N/N-1, so check those rather than guessing further back.
    const candidates = entry?.currentVersion
      ? [entry.currentVersion, entry.currentVersion - 1].filter((v) => v >= 1)
      : [];
    const cachedVersion =
      candidates.find((v) => getCachedVK(circuitId, v) !== null) ?? null;

    const result = reconcileCircuitVersion(circuitId, cachedVersion, matrix);
    if (result.status === "unsupported" && cachedVersion !== null) {
      invalidateVKCache(circuitId, cachedVersion);
    }
    results.push(result);
  }

  return results;
}
