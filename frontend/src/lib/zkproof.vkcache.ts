// Hardened client-side VK cache.
//
// The registry is the single source of truth: VKs are only accepted when the
// backend hash verifies against the canonical VK preimage. This module stores
// the full circuit binding (circuitId + circuitType + version +
// numPublicSignals + ceremony transcript hash) alongside the key so that
// witness generation and proof verification can bind to the exact same
// circuit instance. It never synthesizes a verification key.
//
// Hash algorithm MUST stay in sync with `packages/sdk/src/keys.ts` and
// `backend/src/services/circuit-registry.ts` (domain "zkvote-vk-v1").

export const VK_CACHE_TTL_MS = 5 * 60 * 1000;
export const VK_CACHE_KEY_PREFIX = "zkvote_bound_vk_cache_v2";
export const CIRCUIT_HASH_DOMAIN = "zkvote-vk-v1";

export type CircuitType = "Vote" | "Comment" | "Tally";

export interface CircuitBinding {
  circuitId: string;
  circuitType: CircuitType;
  version: number;
  numPublicSignals: number;
  hash: string;
  ceremonyTranscriptHash?: string;
  daoId?: number;
}

export interface Groth16VerificationKey {
  alpha: string;
  beta: string;
  gamma: string;
  delta: string;
  ic: string[];
}

export interface BoundVK extends CircuitBinding {
  vk: Groth16VerificationKey;
  currentVersion: number;
  source: string;
  fetchedAt: number;
}

export class StaleVKError extends Error {
  readonly status = 410;
  constructor(
    public readonly circuitId: string,
    public readonly version: number,
    public readonly currentVersion?: number,
  ) {
    super(
      `Stale VK: ${circuitId} v${version} is no longer current` +
        (currentVersion !== undefined ? ` (current v${currentVersion})` : ""),
    );
    this.name = "StaleVKError";
  }
}

export class RegistryUnavailableError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = "RegistryUnavailableError";
  }
}

export class VKIntegrityError extends Error {
  constructor(
    public readonly circuitId: string,
    public readonly version: number,
  ) {
    super(`VK integrity check failed for ${circuitId} v${version}`);
    this.name = "VKIntegrityError";
  }
}

export interface ResolveBoundVkOptions {
  daoId?: number;
  circuitId: string;
  circuitType?: CircuitType;
  version?: number;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

const memoryCache = new Map<string, BoundVK>();

function cacheKey(binding: {
  daoId?: number;
  circuitId: string;
  circuitType?: CircuitType;
  version: number;
}): string {
  return `${binding.daoId ?? "*"}:${binding.circuitId}:${binding.circuitType ?? "Vote"}:${binding.version}`;
}

/** Deterministic JSON: object keys sorted, array order preserved. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Canonical SHA-256 digest of the VK binding, lowercase hex. */
export async function computeBoundVKHash(input: {
  vk: Groth16VerificationKey;
  circuitId: string;
  version: number;
  ceremonyTranscriptHash?: string;
}): Promise<string> {
  const preimage = [
    CIRCUIT_HASH_DOMAIN,
    input.circuitId,
    String(input.version),
    input.ceremonyTranscriptHash ?? "",
    stableStringify(input.vk),
  ].join("\n");
  const bytes = new TextEncoder().encode(preimage);
  const cryptoApi = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (!cryptoApi?.subtle) {
    throw new Error("VK hashing requires Web Crypto (globalThis.crypto.subtle)");
  }
  const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function persist(entry: BoundVK): void {
  try {
    safeStorage()?.setItem(
      `${VK_CACHE_KEY_PREFIX}_${cacheKey(entry)}`,
      JSON.stringify(entry),
    );
  } catch {
    /* storage quota / disabled — in-memory cache still works */
  }
}

function load(circuitId: string, circuitType: CircuitType, version: number, daoId?: number): BoundVK | null {
  try {
    const key = `${VK_CACHE_KEY_PREFIX}_${cacheKey({ daoId, circuitId, circuitType, version })}`;
    const raw = safeStorage()?.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as BoundVK;
    if (
      entry.circuitId !== circuitId ||
      entry.version !== version ||
      entry.circuitType !== circuitType ||
      (daoId !== undefined && entry.daoId !== daoId) ||
      typeof entry.hash !== "string" ||
      typeof entry.numPublicSignals !== "number"
    ) {
      safeStorage()?.removeItem(key);
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

/**
 * Fetch a VK from the versioned registry endpoint, verify its canonical hash,
 * and cache the full circuit binding. Fails closed on unavailable registry,
 * stale version, malformed response, or hash mismatch.
 */
export async function fetchBoundVK(
  options: ResolveBoundVkOptions,
): Promise<BoundVK> {
  const {
    daoId,
    circuitId,
    circuitType = "Vote",
    version,
    fetchFn = fetch,
  } = options;
  const baseUrl = (
    options.baseUrl ??
    (import.meta as unknown as { env?: Record<string, string> })?.env
      ?.VITE_RELAYER_URL ??
    "http://localhost:3001"
  ).replace(/\/$/, "");

  const key = cacheKey({ daoId, circuitId, circuitType, version: version ?? 0 });
  const cached =
    (version !== undefined ? memoryCache.get(key) : undefined) ??
    load(circuitId, circuitType, version ?? 1, daoId);
  if (
    cached &&
    version !== undefined &&
    cached.version === version &&
    Date.now() - cached.fetchedAt < VK_CACHE_TTL_MS
  ) {
    return cached;
  }

  const daoQuery = daoId !== undefined ? `&daoId=${encodeURIComponent(String(daoId))}` : "";
  const url =
    version === undefined
      ? `${baseUrl}/circuits/vk/${encodeURIComponent(circuitId)}?circuitType=${encodeURIComponent(circuitType)}${daoQuery}`
      : `${baseUrl}/circuits/vk/${encodeURIComponent(circuitId)}/${version}?circuitType=${encodeURIComponent(circuitType)}${daoQuery}`;

  const response = await fetchFn(url);
  if (response.status === 410 || response.status === 409) {
    if (version !== undefined) invalidateVKCache({ daoId, circuitId, circuitType, version });
    throw new StaleVKError(circuitId, version ?? -1);
  }
  if (!response.ok) {
    const body = (await response.text().catch(() => ""))?.slice(0, 200);
    throw new RegistryUnavailableError(
      `Circuit registry unavailable for ${circuitId}: ${response.status} ${body}`,
    );
  }

  const data = (await response.json()) as Partial<BoundVK> & {
    vk?: Groth16VerificationKey;
    code?: string;
  };
  if (!data?.vk || typeof data.hash !== "string" || typeof data.version !== "number") {
    throw new RegistryUnavailableError(`Malformed VK response for ${circuitId}`);
  }
  if (!Array.isArray(data.vk.ic) || typeof data.numPublicSignals !== "number") {
    throw new VKIntegrityError(circuitId, data.version);
  }

  const ceremonyTranscriptHash = data.ceremonyTranscriptHash ?? undefined;
  const recomputed = await computeBoundVKHash({
    vk: data.vk,
    circuitId: data.circuitId ?? circuitId,
    version: data.version,
    ceremonyTranscriptHash,
  });
  if (recomputed.toLowerCase() !== data.hash.toLowerCase()) {
    invalidateVKCache({ daoId, circuitId, circuitType, version: data.version });
    throw new VKIntegrityError(circuitId, data.version);
  }
  if (
    data.circuitId !== undefined &&
    data.circuitId !== circuitId
  ) {
    throw new VKIntegrityError(circuitId, data.version);
  }
  if (
    data.currentVersion !== undefined &&
    data.currentVersion > data.version
  ) {
    invalidateVKCache({ daoId, circuitId, circuitType, version: data.version });
    throw new StaleVKError(circuitId, data.version, data.currentVersion);
  }

  const entry: BoundVK = {
    vk: data.vk,
    circuitId: data.circuitId ?? circuitId,
    circuitType: data.circuitType ?? circuitType,
    version: data.version,
    currentVersion: data.currentVersion ?? data.version,
    numPublicSignals: data.numPublicSignals,
    hash: data.hash,
    ceremonyTranscriptHash,
    daoId,
    source: data.source ?? "on-chain",
    fetchedAt: Date.now(),
  };
  memoryCache.set(cacheKey(entry), entry);
  persist(entry);
  return entry;
}

/** Return a non-expired cached binding, if any. */
export function getCachedBoundVK(
  circuitId: string,
  version: number,
  circuitType: CircuitType = "Vote",
  daoId?: number,
): BoundVK | null {
  const key = cacheKey({ daoId, circuitId, circuitType, version });
  const entry =
    memoryCache.get(key) ?? load(circuitId, circuitType, version, daoId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt >= VK_CACHE_TTL_MS) {
    invalidateVKCache({ daoId, circuitId, circuitType, version });
    return null;
  }
  return entry;
}

/**
 * Extract the circuit binding used by witness generation + verification.
 * Throws when no verified binding is cached (never returns a synthetic one).
 */
export function getCircuitBinding(
  circuitId: string,
  version: number,
  circuitType: CircuitType = "Vote",
  daoId?: number,
): CircuitBinding {
  const entry = getCachedBoundVK(circuitId, version, circuitType, daoId);
  if (!entry) {
    throw new Error(
      `No verified circuit binding cached for ${circuitId} v${version}`,
    );
  }
  return {
    circuitId: entry.circuitId,
    circuitType: entry.circuitType,
    version: entry.version,
    numPublicSignals: entry.numPublicSignals,
    hash: entry.hash,
    ceremonyTranscriptHash: entry.ceremonyTranscriptHash,
    daoId: entry.daoId,
  };
}

/**
 * Invalidate cached VKs. With no argument, clears everything. With partial
 * arguments, clears matching entries keyed by daoId + circuitId + type + version.
 */
export function invalidateVKCache(
  scope: {
    daoId?: number;
    circuitId?: string;
    circuitType?: CircuitType;
    version?: number;
  } = {},
): void {
  const hasScope = Object.keys(scope).some((k) => scope[k] !== undefined);
  if (!hasScope) {
    memoryCache.clear();
    try {
      const storage = safeStorage();
      if (storage) {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key?.startsWith(VK_CACHE_KEY_PREFIX)) storage.removeItem(key);
        }
      }
    } catch {
      /* ignore */
    }
    return;
  }

  for (const key of Array.from(memoryCache.keys())) {
    const [dao, circuit, type, ver] = key.split(":");
    if (scope.daoId !== undefined && dao !== String(scope.daoId)) continue;
    if (scope.circuitId !== undefined && circuit !== scope.circuitId) continue;
    if (scope.circuitType !== undefined && type !== scope.circuitType) continue;
    if (scope.version !== undefined && ver !== String(scope.version)) continue;
    memoryCache.delete(key);
  }
  try {
    const storage = safeStorage();
    if (storage) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key?.startsWith(`${VK_CACHE_KEY_PREFIX}_`)) continue;
        const [dao, circuit, type, ver] = key
          .slice(`${VK_CACHE_KEY_PREFIX}_`.length)
          .split(":");
        if (scope.daoId !== undefined && dao !== String(scope.daoId)) continue;
        if (scope.circuitId !== undefined && circuit !== scope.circuitId) continue;
        if (scope.circuitType !== undefined && type !== scope.circuitType) continue;
        if (scope.version !== undefined && ver !== String(scope.version)) continue;
        storage.removeItem(key);
      }
    }
  } catch {
    /* ignore */
  }
}

/** Detect that a rotation happened and drop every cached version of the circuit. */
export function applyRotation(
  binding: Pick<CircuitBinding, "daoId" | "circuitId" | "circuitType" | "version">,
): void {
  invalidateVKCache(binding);
  invalidateVKCache({
    daoId: binding.daoId,
    circuitId: binding.circuitId,
    circuitType: binding.circuitType,
  });
}

// Test-only introspection (no production behaviour).
export const __boundVkCacheTestHelpers = {
  _memoryCache: memoryCache,
  _key: cacheKey,
  _clearAll: () => memoryCache.clear(),
};
