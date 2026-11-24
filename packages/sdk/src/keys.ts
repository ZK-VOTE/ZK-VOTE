/**
 * Shared, dependency-light VK / key resolution helpers for every ZK-VOTE client.
 *
 * This module deliberately uses only Web Crypto + built-in JavaScript so it can
 * run in the browser, in Node (18+), and in edge workers with no install step.
 * The hash algorithm here is the canonical one: the backend
 * (`backend/src/services/circuit-registry.ts`) and the frontend cache
 * (`frontend/src/lib/zkproof.vkcache.ts`) MUST produce byte-identical digests.
 *
 * Canonical preimage (UTF-8), newline separated:
 *   "zkvote-vk-v1" | circuitId | version | ceremonyTranscriptHash | stableStringify(vk)
 */

/** Domain separator pinned to the canonical VK hash format. */
export const CIRCUIT_HASH_DOMAIN = "zkvote-vk-v1" as const;

export type CircuitType = "Vote" | "Comment" | "Tally";

/** Minimal structural shape of a Groth16 verification key. */
export interface Groth16VerificationKey {
  alpha: string;
  beta: string;
  gamma: string;
  delta: string;
  ic: string[];
}

/**
 * Everything a prover/verifier needs in order to bind a proof to one specific
 * circuit instance. Pass this alongside witness generation and verification.
 */
export interface CircuitBinding {
  circuitId: string;
  circuitType: CircuitType;
  version: number;
  numPublicSignals: number;
  hash: string;
  ceremonyTranscriptHash?: string;
  daoId?: number;
}

export interface VkRecordLike {
  vk: Groth16VerificationKey;
  numPublicSignals: number;
  version: number;
  ceremonyTranscriptHash?: string;
}

export interface ResolvedVK extends CircuitBinding {
  vk: Groth16VerificationKey;
  currentVersion: number;
  /** "on-chain" | "test-mode-mock" — synthetic keys are always labelled. */
  source: string;
}

export interface ResolveVkRequest {
  daoId?: number;
  circuitId: string;
  circuitType?: CircuitType;
  version?: number;
}

export interface BackendVkResponse {
  vk: Groth16VerificationKey;
  circuitId?: string;
  circuitType?: CircuitType;
  version: number;
  currentVersion?: number;
  numPublicSignals: number;
  hash: string;
  ceremonyTranscriptHash?: string | null;
  daoId?: number;
  source?: string;
  error?: string;
  code?: string;
}

/** Deterministic JSON: object keys sorted, array order preserved. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify(record[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface VkHashInput {
  vk: Groth16VerificationKey;
  circuitId: string;
  version: number;
  ceremonyTranscriptHash?: string;
}

/** SHA-256 of the canonical VK preimage, lowercase hex. */
export async function computeVkHash(input: VkHashInput): Promise<string> {
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
    throw new Error("computeVkHash requires Web Crypto (globalThis.crypto.subtle)");
  }
  const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Verify a backend/on-chain hash against locally recomputed canonical hash. */
export async function verifyVkHash(
  input: VkHashInput,
  expectedHash: string,
): Promise<boolean> {
  const actual = await computeVkHash(input);
  if (typeof expectedHash !== "string") return false;
  const a = actual.toLowerCase();
  const b = expectedHash.toLowerCase();
  if (a.length !== b.length) return false;
  // Constant-time-ish comparison for a public digest (defence in depth).
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Resolve a VK from the relayer's versioned VK endpoint and validate it.
 * Fail-closed: any unavailable registry (503) or stale version (410) rejects.
 */
export async function resolveVkFromBackend(
  request: ResolveVkRequest,
  options: {
    baseUrl: string;
    fetchFn?: typeof fetch;
  },
): Promise<ResolvedVK> {
  const fetchFn = options.fetchFn ?? (globalThis as unknown as { fetch: typeof fetch }).fetch;
  const circuitType = request.circuitType ?? "Vote";
  const version = request.version;
  const path =
    version === undefined
      ? `/circuits/vk/${encodeURIComponent(request.circuitId)}?circuitType=${encodeURIComponent(circuitType)}`
      : `/circuits/vk/${encodeURIComponent(request.circuitId)}/${version}?circuitType=${encodeURIComponent(circuitType)}`;
  const url = `${options.baseUrl.replace(/\/$/, "")}${path}`;
  const response = await fetchFn(url);

  if (response.status === 410 || response.status === 409) {
    throw new Error(
      `Stale VK for ${request.circuitId} v${version ?? "latest"}`,
    );
  }
  if (!response.ok) {
    const body = (await response.text().catch(() => ""))?.slice(0, 200);
    throw new Error(
      `Circuit registry unavailable (${response.status}): ${body}`,
    );
  }

  const data = (await response.json()) as BackendVkResponse;
  if (!data?.vk || typeof data.hash !== "string" || typeof data.version !== "number") {
    throw new Error("Malformed VK response from circuit registry");
  }
  const ceremonyTranscriptHash = data.ceremonyTranscriptHash ?? undefined;
  const ok = await verifyVkHash(
    {
      vk: data.vk,
      circuitId: data.circuitId ?? request.circuitId,
      version: data.version,
      ceremonyTranscriptHash,
    },
    data.hash,
  );
  if (!ok) {
    throw new Error(
      `VK integrity check failed for ${request.circuitId} v${data.version}`,
    );
  }

  const binding: CircuitBinding = {
    circuitId: data.circuitId ?? request.circuitId,
    circuitType: data.circuitType ?? circuitType,
    version: data.version,
    numPublicSignals: data.numPublicSignals,
    hash: data.hash,
    ceremonyTranscriptHash,
    daoId: request.daoId,
  };

  return {
    ...binding,
    vk: data.vk,
    currentVersion: data.currentVersion ?? data.version,
    source: data.source ?? "on-chain",
  };
}

/** Derive a circuit ID from a known family name + version (no registry call). */
export function versionFromCircuitId(circuitId: string): number {
  const match = /_v(\d+)$/.exec(circuitId);
  return match ? Number(match[1]) : 1;
}
