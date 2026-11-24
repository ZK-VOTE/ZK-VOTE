// API utilities with exponential backoff and relayer status tracking

import type {
  ContentEnvelope,
  ContentType,
  KeyEpoch,
} from "./groupEncryption";
// Issue #556 — single config source: RELAYER_URL is now the canonical export
// from config/env.ts so all three service URLs stay in one place.
import { RELAYER_URL } from "../config/env";

const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || "http://localhost:3001";
// Relayer shared secrets must NEVER be baked into the public JS bundle (#647).
// Browser writes authenticate via CSRF + origin checks; server-to-server
// clients supply X-Relayer-Auth from a private environment.

/**
 * Generate an idempotency key for payment operations.
 * Uses crypto.randomUUID if available, falls back to timestamp+random.
 */
export function generateIdempotencyKey(prefix = "pay"): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  // Fallback for older browsers
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  return `${prefix}_${timestamp}_${random}`;
}

// ============================================
// CSRF TOKEN MANAGEMENT
// ============================================

/** In-memory CSRF token obtained from the relayer on initialization. */
let csrfToken: string | null = null;

/**
 * Fetch a fresh CSRF token from the relayer and cache it for subsequent
 * state-changing requests.  Should be called once on SPA startup (or
 * lazily before the first write).  The token is returned in the
 * X-CSRF-Token response header.
 */
export async function initCsrf(): Promise<void> {
  try {
    const url = `${RELAYER_URL}/csrf-token`;
    const headers = new Headers();
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok) {
      const token = response.headers.get("X-CSRF-Token");
      if (token) {
        csrfToken = token;
      }
    }
  } catch {
    // Non-fatal — the first write will fail with a 403 and the UI can retry
    console.warn("[csrf] Failed to initialise CSRF token");
  }
}

/** Return the cached CSRF token (may be null if initCsrf has not been called). */
export function getCsrfToken(): string | null {
  return csrfToken;
}

// ============================================
// ERROR TYPES
// ============================================

export const ErrorCode = {
  VOTE_ALREADY_CAST: "VOTE_ALREADY_CAST",
  VOTING_PERIOD_CLOSED: "VOTING_PERIOD_CLOSED",
  INVALID_PROOF: "INVALID_PROOF",
  NOT_ELIGIBLE: "NOT_ELIGIBLE",
  PROPOSAL_NOT_FOUND: "PROPOSAL_NOT_FOUND",
  DAO_NOT_FOUND: "DAO_NOT_FOUND",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  UNAUTHORIZED: "UNAUTHORIZED",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  TIMEOUT: "TIMEOUT",
  NOT_FOUND: "NOT_FOUND",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface StructuredError {
  code: ErrorCode;
  message: string;
  details?: unknown;
  requestId: string;
  timestamp: string;
}

export interface ApiErrorResponse {
  error: StructuredError | string;
}

/**
 * Helper to safely extract the error message from an API response,
 * maintaining backwards compatibility with older plain string errors.
 */
export function parseApiError(data: any): string {
  if (!data || !data.error) return "Unknown error occurred";
  if (typeof data.error === "string") return data.error;
  return data.error.message || "Unknown error occurred";
}

export function getApiErrorCode(data: any): ErrorCode | undefined {
  if (!data || !data.error || typeof data.error === "string") return undefined;
  return data.error.code as ErrorCode;
}

// Relayer connection state
interface RelayerState {
  connected: boolean;
  lastChecked: number;
  consecutiveFailures: number;
  backoffUntil: number;
}

const state: RelayerState = {
  connected: true,
  lastChecked: 0,
  consecutiveFailures: 0,
  backoffUntil: 0,
};

// Subscribers for connection state changes
type ConnectionListener = (connected: boolean) => void;
const listeners: Set<ConnectionListener> = new Set();

// Degraded auxiliary services (#204)
type DegradationListener = (services: string[]) => void;
const degradationListeners: Set<DegradationListener> = new Set();
let lastDegradedServices: string[] = [];

export function subscribeToServiceDegradation(
  listener: DegradationListener,
): () => void {
  degradationListeners.add(listener);
  listener(lastDegradedServices);
  return () => degradationListeners.delete(listener);
}

export function getDegradedServices(): string[] {
  return [...lastDegradedServices];
}

/**
 * User-facing impact of degraded upstream sources (#745). The relayer reports
 * external dependencies by name in X-Service-Degraded; money-path ones need a
 * specific message rather than the generic "reduced functionality" line.
 */
export interface DegradedSourceImpact {
  service: string;
  /** Whether the dependency sits on a vote or money path. */
  critical: boolean;
  message: string;
}

const DEGRADED_SOURCE_IMPACT: Record<string, Omit<DegradedSourceImpact, "service">> = {
  soroban_rpc: {
    critical: true,
    message: "Voting may be slower or briefly unavailable while the network connection recovers.",
  },
  horizon: {
    critical: true,
    message: "Payments and swaps may be delayed or temporarily unavailable.",
  },
  dao_sync: {
    critical: false,
    message: "DAO directory data is cached and may be stale. An empty list does not confirm there are no DAOs.",
  },
  indexer: {
    critical: false,
    message: "Blockchain indexing is delayed; listings and activity may be stale until synchronization recovers.",
  },
  swap_quotes: {
    critical: false,
    message: "Swap prices come from a backup source and may differ at execution.",
  },
  anchor_usdc: {
    critical: false,
    message: "USDC deposits and withdrawals may be delayed.",
  },
  anchor_eurc: {
    critical: false,
    message: "EURC deposits and withdrawals may be delayed.",
  },
};

export function describeDegradedSources(services: string[]): DegradedSourceImpact[] {
  return services
    .filter((service) => service in DEGRADED_SOURCE_IMPACT)
    .map((service) => ({ service, ...DEGRADED_SOURCE_IMPACT[service] }));
}

function notifyDegradation(services: string[]) {
  const key = services.slice().sort().join(",");
  const prev = lastDegradedServices.slice().sort().join(",");
  lastDegradedServices = services;
  if (key !== prev) {
    degradationListeners.forEach((l) => l(services));
  }
}

function readDegradedHeader(response: Response): void {
  const header = response.headers.get("X-Service-Degraded");
  if (header) {
    notifyDegradation(
      header
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
}

export function subscribeToRelayerStatus(
  listener: ConnectionListener,
): () => void {
  listeners.add(listener);
  // Immediately notify of current state
  listener(state.connected);
  return () => listeners.delete(listener);
}

export function getRelayerStatus(): {
  connected: boolean;
  backoffRemaining: number;
} {
  const now = Date.now();
  return {
    connected: state.connected,
    backoffRemaining: Math.max(0, state.backoffUntil - now),
  };
}

function notifyListeners() {
  listeners.forEach((listener) => listener(state.connected));
}

function markSuccess() {
  const wasDisconnected = !state.connected;
  state.connected = true;
  state.consecutiveFailures = 0;
  state.backoffUntil = 0;
  state.lastChecked = Date.now();
  if (wasDisconnected) {
    notifyListeners();
  }
}

function markFailure() {
  state.consecutiveFailures++;
  state.lastChecked = Date.now();

  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
  const backoffMs = Math.min(
    1000 * Math.pow(2, state.consecutiveFailures - 1),
    30000,
  );
  state.backoffUntil = Date.now() + backoffMs;

  // After 3 consecutive failures, mark as disconnected
  if (state.consecutiveFailures >= 3 && state.connected) {
    state.connected = false;
    notifyListeners();
  }
}

function isInBackoff(): boolean {
  return Date.now() < state.backoffUntil;
}

export interface FetchOptions extends RequestInit {
  maxRetries?: number;
  skipBackoff?: boolean;
  idempotencyKey?: string;
}

export class RelayerError extends Error {
  status?: number;
  code?: string;
  retryAfterMs?: number;
  isRateLimited: boolean;
  isBackoff: boolean;
  isNetworkError: boolean;

  constructor(
    message: string,
    status?: number,
    code?: string,
    isNetworkError = false,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RelayerError";
    this.status = status;
    this.code = code;
    this.isRateLimited = status === 429;
    this.isBackoff = false;
    this.isNetworkError = isNetworkError;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Parse a `Retry-After` header value into milliseconds (#576).
 * Supports delta-seconds ("120") and HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT").
 * Returns undefined when absent/unparseable; clamps to [0, 60_000].
 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.max(0, Math.round(seconds * 1000)), 60000);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), 60000);
  }
  return undefined;
}

export interface SafeJsonResult {
  data: any;
  /** Raw text snippet (truncated) when the body was not JSON — e.g. HTML 429 pages. */
  rawText?: string;
  isJson: boolean;
}

/**
 * Content-type aware JSON guard (#576).
 *
 * Never calls `response.json()` blindly: HTML/text error pages (proxies,
 * rate limiters, WAFs) previously threw a SyntaxError that was swallowed by
 * `.catch(() => ({}))`, hiding 429s. Returns `{ isJson: false }` with a
 * truncated snippet instead so callers can surface an explicit rate-limit
 * error with `Retry-After`.
 */
export async function safeParseJsonResponse(
  response: Response,
): Promise<SafeJsonResult> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("json")) {
    const text = await response.text().catch(() => "");
    return {
      data: undefined,
      rawText: text.slice(0, 500),
      isJson: false,
    };
  }
  try {
    const data = await response.json();
    return { data, isJson: true };
  } catch {
    const text = await response.text().catch(() => "");
    return {
      data: undefined,
      rawText: text.slice(0, 500),
      isJson: false,
    };
  }
}

function mapBackendError(status: number, data?: any, rawText?: string): string {
  if (status === 429) {
    const hint = rawText ? ` (${rawText.slice(0, 120)})` : "";
    return `Rate limited (429). Please wait and try again later.${hint}`;
  }
  if (status === 503 || status === 504)
    return "The blockchain network is currently unreachable. Operating in degraded mode.";
  if (status === 500) return "An internal error occurred on the relayer.";
  if (data && typeof data.error === "string") return data.error;
  if (data && data.error) return data.error;
  if (rawText) return `Request failed (${status}): ${rawText.slice(0, 120)}`;
  return "An unexpected error occurred.";
}

/**
 * Fetch with exponential backoff and relayer status tracking.
 * Will automatically retry failed requests with increasing delays.
 */
export async function relayerFetch(
  endpoint: string,
  options: FetchOptions = {},
): Promise<Response> {
  // Default to not retrying write operations unless explicitly specified
  const isWrite =
    options.method &&
    !["GET", "HEAD", "OPTIONS"].includes(options.method.toUpperCase());
  const {
    maxRetries = isWrite ? 1 : 3,
    skipBackoff = false,
    idempotencyKey,
    ...fetchOptions
  } = options;
  const url = endpoint.startsWith("http")
    ? endpoint
    : `${RELAYER_URL}${endpoint}`;

  // Check if we're in backoff period
  if (!skipBackoff && isInBackoff()) {
    const error = new RelayerError(
      "Relayer temporarily unavailable (backing off)",
    );
    error.isBackoff = true;
    throw error;
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Browser clients must not hold a shared relayer auth token (#647).
      const headers = new Headers(fetchOptions.headers);

      // Add idempotency key for write operations
      if (isWrite && idempotencyKey) {
        headers.set("Idempotency-Key", idempotencyKey);
      }

      // Add CSRF token for all state-changing requests (POST, PUT, DELETE, PATCH).
      // The token is obtained from GET /csrf-token on initialisation.
      if (isWrite && csrfToken) {
        headers.set("X-CSRF-Token", csrfToken);
      }

      const response = await fetch(url, {
        ...fetchOptions,
        headers,
        signal: fetchOptions.signal || AbortSignal.timeout(15000),
      });

      // Check for rate limiting (429) - treat as failure with backoff.
      // #576: use the content-type aware guard so HTML/text 429 pages from
      // proxies are surfaced explicitly instead of being swallowed by a
      // blind response.json() call, and always honor Retry-After.
      if (response.status === 429) {
        markFailure();
        const retryAfterMs =
          parseRetryAfterMs(response.headers.get("Retry-After")) ??
          Math.min(1000 * Math.pow(2, attempt + 1), 30000);
        const parsed = await safeParseJsonResponse(response);
        const message = mapBackendError(429, parsed.data, parsed.rawText);

        // On last attempt, throw an explicit rate-limit error
        if (attempt >= maxRetries - 1) {
          throw new RelayerError(
            message,
            429,
            parsed.data?.code ?? parsed.data?.error?.code,
            false,
            retryAfterMs,
          );
        }

        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(retryAfterMs, 30000)),
        );
        lastError = new RelayerError(
          message,
          429,
          parsed.data?.code ?? parsed.data?.error?.code,
          false,
          retryAfterMs,
        );
        continue;
      }

      if (!response.ok) {
        const parsed = await safeParseJsonResponse(response);
        const errorData = parsed.data;

        const errorMessage = mapBackendError(
          response.status,
          errorData,
          parsed.rawText,
        );
        lastError = new RelayerError(
          errorMessage,
          response.status,
          errorData?.code ?? errorData?.error?.code,
        );

        // Don't retry client errors (except 429 which is handled above)
        if (response.status >= 400 && response.status < 500) {
          throw lastError;
        }

        throw lastError; // Throw so catch block can handle retries for 5xx
      }

      // Success - reset failure count
      markSuccess();
      readDegradedHeader(response);
      return response;
    } catch (error) {
      if (
        error instanceof RelayerError &&
        error.status &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429
      ) {
        throw error;
      }

      lastError =
        error instanceof RelayerError
          ? error
          : new RelayerError(
              "Unable to reach the relayer service. Please check your internet connection.",
              undefined,
              undefined,
              true,
            );

      // Don't retry on abort
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }

      // Don't retry on rate limit errors (already handled max retries)
      if (lastError instanceof RelayerError && lastError.isRateLimited) {
        throw lastError;
      }

      // Mark failure and wait before retry
      markFailure();

      if (attempt < maxRetries - 1) {
        // Wait before retry (exponential backoff within request)
        const delay = Math.min(500 * Math.pow(2, attempt), 4000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw (
    lastError ||
    new RelayerError(
      "Unable to reach the relayer service. Please check your internet connection.",
      undefined,
      undefined,
      true,
    )
  );
}

/**
 * Health check for the relayer.
 * Returns true if connected (including degraded mode), false otherwise.
 */
export async function checkRelayerHealth(): Promise<boolean> {
  try {
    const response = await relayerFetch("/health", {
      maxRetries: 1,
      skipBackoff: true,
    });
    if (!response.ok) return false;
    const { data: body } = await safeParseJsonResponse(response);
    if (!body || typeof body !== "object") return response.ok;
    if (body.services) {
      notifyDegradation([
        ...(body.services.degraded ?? []),
        ...(body.services.unavailable ?? []),
      ]);
    } else if (body.status === "ok") {
      notifyDegradation([]);
    }
    // Degraded still means the API is reachable
    return body.status === "ok" || body.status === "degraded" || response.ok;
  } catch {
    return false;
  }
}

export interface HealthServicesSnapshot {
  status: "ok" | "degraded";
  degraded: string[];
  unavailable: string[];
}

/** Fetch /health service degradation details for the UI banner. */
export async function checkRelayerHealthDetails(): Promise<HealthServicesSnapshot | null> {
  try {
    const response = await relayerFetch("/health", {
      maxRetries: 1,
      skipBackoff: true,
    });
    if (!response.ok) return null;
    const { data: body, isJson } = await safeParseJsonResponse(response);
    if (!isJson || !body || typeof body !== "object") return null;
    if (body.services) {
      notifyDegradation([
        ...(body.services.degraded ?? []),
        ...(body.services.unavailable ?? []),
      ]);
      return body.services;
    }
    return {
      status: body.status === "degraded" ? "degraded" : "ok",
      degraded: [],
      unavailable: [],
    };
  } catch {
    return null;
  }
}

/**
 * Force a reconnection attempt (clears backoff state).
 */
export function forceReconnect(): void {
  state.backoffUntil = 0;
  state.consecutiveFailures = 0;
}

// Export the base URL for direct use if needed
export { RELAYER_URL };

// Event types for notification
export type EventType =
  | "proposal_created"
  | "vote_cast"
  | "member_added"
  | "member_revoked"
  | "member_left"
  | "voter_registered"
  | "voter_removed"
  | "vk_updated"
  | "tree_init"
  | "dao_create"
  | "admin_transfer"
  | "membership_mode_changed"
  | "proposal_mode_changed"
  | "profile_updated";

/**
 * Notify the relayer of an event from the frontend.
 * The relayer will verify the event on-chain before trusting it.
 * This is fire-and-forget - we don't wait for verification.
 */
export async function notifyEvent(
  daoId: number,
  type: EventType,
  txHash: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    await relayerFetch("/events/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        daoId,
        type,
        txHash,
        data: data || {},
      }),
      maxRetries: 1, // Don't retry aggressively - it's just a notification
    });
  } catch (error) {
    // Log but don't throw - this is best-effort
    console.warn("Failed to notify relayer of event:", error);
  }
}

export interface SponsoredFeeRequest {
  sponsor?: "relayer" | "voter";
  feePayer?: string;
  feeBudgetStroops?: number;
}

export interface CommitVoteInput {
  daoId: number;
  proposalId: number;
  nullifier: string;
  commitmentHash: string;
  timestamp: number;
}

/**
 * Commit to a proof hash before revealing
 */
export async function commitVoteProof(input: CommitVoteInput): Promise<{
  success: boolean;
  commitmentHash: string;
  expiresAt: string;
}> {
  const response = await relayerFetch("/vote/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const parsed = await safeParseJsonResponse(response);
    if (response.status === 429) {
      throw new RelayerError(
        mapBackendError(429, parsed.data, parsed.rawText),
        429,
        undefined,
        false,
        parseRetryAfterMs(response.headers.get("Retry-After")),
      );
    }
    throw new Error(
      parseApiError(parsed.data ?? parsed.rawText) ||
        "Failed to commit vote proof",
    );
  }

  const parsed = await safeParseJsonResponse(response);
  return parsed.data;
}

/**
 * Fetch relayer public key for proof encryption
 */
export async function fetchRelayerPublicKey(): Promise<string> {
  const response = await relayerFetch("/relayer/pubkey");
  if (!response.ok) {
    const parsed = await safeParseJsonResponse(response);
    if (response.status === 429) {
      throw new RelayerError(
        mapBackendError(429, parsed.data, parsed.rawText),
        429,
        undefined,
        false,
        parseRetryAfterMs(response.headers.get("Retry-After")),
      );
    }
    throw new Error("Failed to fetch relayer public key");
  }
  const { data } = await safeParseJsonResponse(response);
  return data.publicKey;
}

// ============================================
// E2E ENCRYPTED GOVERNANCE CONTENT (#324)
// ============================================

const ENCRYPTION_BASE = "/api/v1/encryption";

export type { ContentEnvelope, ContentType, KeyEpoch };

export interface WrappedGroupKey {
  daoId: number;
  epoch: number;
  keyCommitment: string;
  /** base64 blob only the addressed member can open. */
  wrapped: string;
}

async function encryptionJson<T>(
  path: string,
  options: FetchOptions = {},
): Promise<T> {
  const response = await relayerFetch(path, options);
  if (!response.ok) {
    const parsed = await safeParseJsonResponse(response);
    if (response.status === 429) {
      throw new RelayerError(
        mapBackendError(429, parsed.data, parsed.rawText),
        429,
        undefined,
        false,
        parseRetryAfterMs(response.headers.get("Retry-After")),
      );
    }
    throw new RelayerError(
      parseApiError(parsed.data) ||
        (parsed.rawText
          ? `Encryption request failed (${response.status}): ${parsed.rawText.slice(0, 120)}`
          : `Encryption request failed (${response.status})`),
      response.status,
      getApiErrorCode(parsed.data),
    );
  }
  const parsed = await safeParseJsonResponse(response);
  return parsed.data as T;
}

/**
 * The DAO's current key epoch.
 *
 * Clients must read this before encrypting: writing under a stale epoch is
 * rejected by the relay, because content sealed to a superseded key would be
 * unreadable by the members who were just rotated in.
 */
export async function fetchKeyEpoch(daoId: number): Promise<KeyEpoch | null> {
  const response = await relayerFetch(`${ENCRYPTION_BASE}/daos/${daoId}/epoch`);
  if (response.status === 404) return null;
  if (!response.ok) {
    const parsed = await safeParseJsonResponse(response);
    if (response.status === 429) {
      throw new RelayerError(
        mapBackendError(429, parsed.data, parsed.rawText),
        429,
        undefined,
        false,
        parseRetryAfterMs(response.headers.get("Retry-After")),
      );
    }
    throw new RelayerError(
      parseApiError(parsed.data) || "Failed to fetch key epoch",
      response.status,
    );
  }
  const { data } = await safeParseJsonResponse(response);
  return data;
}

/**
 * This member's sealed copy of the current group key.
 *
 * Returns `null` for a non-member: the relay holds no wrap for them and cannot
 * synthesise one, so there is nothing to fall back to.
 */
export async function fetchWrappedGroupKey(
  daoId: number,
  memberId: string,
): Promise<WrappedGroupKey | null> {
  const response = await relayerFetch(
    `${ENCRYPTION_BASE}/daos/${daoId}/members/${encodeURIComponent(memberId)}/key`,
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    const parsed = await safeParseJsonResponse(response);
    if (response.status === 429) {
      throw new RelayerError(
        mapBackendError(429, parsed.data, parsed.rawText),
        429,
        undefined,
        false,
        parseRetryAfterMs(response.headers.get("Retry-After")),
      );
    }
    throw new RelayerError(
      parseApiError(parsed.data) || "Failed to fetch group key",
      response.status,
    );
  }
  const { data } = await safeParseJsonResponse(response);
  return data;
}

/**
 * Publish a new key epoch after a membership change.
 *
 * `wraps` and `recoveryShares` must already be sealed on this device — there is
 * no parameter here that could carry a raw group key.
 */
export async function publishKeyEpoch(
  daoId: number,
  epoch: {
    threshold: number;
    keyCommitment: string;
    rotationReason:
      | "genesis"
      | "member_joined"
      | "member_left"
      | "member_revoked"
      | "manual";
    wraps: Array<{ memberId: string; wrapped: string }>;
    recoveryShares?: Array<{ index: number; wrappedShare: string }>;
  },
): Promise<KeyEpoch> {
  return encryptionJson(`${ENCRYPTION_BASE}/daos/${daoId}/epoch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recoveryShares: [], ...epoch }),
  });
}

/** Store an encrypted proposal or comment body. */
export async function putEncryptedContent(
  envelope: ContentEnvelope,
): Promise<void> {
  await encryptionJson(
    `${ENCRYPTION_BASE}/daos/${envelope.daoId}/content/${envelope.contentType}/${encodeURIComponent(envelope.contentId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        v: envelope.v,
        epoch: envelope.epoch,
        nonce: envelope.nonce,
        ciphertext: envelope.ciphertext,
        tag: envelope.tag,
      }),
    },
  );
}

export interface RedactedContent {
  redacted: true;
  redactedAt: string | null;
  reason: string | null;
}

/**
 * Fetch an encrypted body.
 *
 * Returns `null` when nothing is stored, and a redaction tombstone when the
 * body was removed — callers should render "removed", not "failed to load".
 */
export async function fetchEncryptedContent(
  daoId: number,
  contentType: ContentType,
  contentId: string,
): Promise<ContentEnvelope | RedactedContent | null> {
  const response = await relayerFetch(
    `${ENCRYPTION_BASE}/daos/${daoId}/content/${contentType}/${encodeURIComponent(contentId)}`,
  );

  if (response.status === 404) return null;
  if (response.status === 410) {
    const { data } = await safeParseJsonResponse(response);
    return {
      redacted: true,
      redactedAt: data?.redactedAt ?? null,
      reason: data?.reason ?? null,
    };
  }
  if (!response.ok) {
    const parsed = await safeParseJsonResponse(response);
    if (response.status === 429) {
      throw new RelayerError(
        mapBackendError(429, parsed.data, parsed.rawText),
        429,
        undefined,
        false,
        parseRetryAfterMs(response.headers.get("Retry-After")),
      );
    }
    throw new RelayerError(
      parseApiError(parsed.data) || "Failed to fetch encrypted content",
      response.status,
    );
  }

  const { data } = await safeParseJsonResponse(response);
  return data;
}

/** True when a fetch result is a redaction tombstone rather than a body. */
export function isRedacted(
  content: ContentEnvelope | RedactedContent | null,
): content is RedactedContent {
  return content !== null && "redacted" in content;
}
