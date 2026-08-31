// API utilities with exponential backoff and relayer status tracking

const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || "http://localhost:3001";
const RELAYER_AUTH_TOKEN = import.meta.env.VITE_RELAYER_AUTH_TOKEN || "";

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
    if (RELAYER_AUTH_TOKEN) {
      headers.set("X-Relayer-Auth", RELAYER_AUTH_TOKEN);
    }
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
}

export class RelayerError extends Error {
  status?: number;
  code?: string;
  isRateLimited: boolean;
  isBackoff: boolean;
  isNetworkError: boolean;

  constructor(
    message: string,
    status?: number,
    code?: string,
    isNetworkError = false,
  ) {
    super(message);
    this.name = "RelayerError";
    this.status = status;
    this.code = code;
    this.isRateLimited = status === 429;
    this.isBackoff = false;
    this.isNetworkError = isNetworkError;
  }
}

function mapBackendError(status: number, data?: any): string {
  if (status === 429)
    return "The network is congested. Please try again later.";
  if (status === 503 || status === 504)
    return "The blockchain network is currently unreachable. Operating in degraded mode.";
  if (status === 500) return "An internal error occurred on the relayer.";
  if (data && data.error) return data.error;
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
      // Add auth header if token is configured
      const headers = new Headers(fetchOptions.headers);
      if (RELAYER_AUTH_TOKEN) {
        headers.set("X-Relayer-Auth", RELAYER_AUTH_TOKEN);
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

      // Check for rate limiting (429) - treat as failure with backoff
      if (response.status === 429) {
        markFailure();

        // On last attempt, throw an error
        if (attempt >= maxRetries - 1) {
          throw new RelayerError(mapBackendError(429), 429);
        }

        // Wait longer for rate limits - use Retry-After header if present
        const retryAfter = response.headers.get("Retry-After");
        const delay = retryAfter
          ? Math.min(parseInt(retryAfter, 10) * 1000, 30000)
          : Math.min(1000 * Math.pow(2, attempt + 1), 30000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (!response.ok) {
        let errorData;
        try {
          errorData = await response.json();
        } catch {
          // Ignore parse errors if no JSON
        }

        const errorMessage = mapBackendError(response.status, errorData);
        lastError = new RelayerError(
          errorMessage,
          response.status,
          errorData?.code,
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
    const body = (await response.json()) as {
      status?: string;
      services?: HealthServicesSnapshot;
    };
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
    const body = (await response.json()) as {
      status?: string;
      services?: HealthServicesSnapshot;
    };
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
  walletAddress?: string;
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
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || "Failed to commit vote proof");
  }

  return response.json();
}

/**
 * Fetch relayer public key for proof encryption
 */
export async function fetchRelayerPublicKey(): Promise<string> {
  const response = await relayerFetch("/relayer/pubkey");
  if (!response.ok) {
    throw new Error("Failed to fetch relayer public key");
  }
  const data = await response.json();
  return data.publicKey;
}
