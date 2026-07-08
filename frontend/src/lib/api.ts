// API utilities with exponential backoff and relayer status tracking

const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || "http://localhost:3001";
const RELAYER_AUTH_TOKEN = import.meta.env.VITE_RELAYER_AUTH_TOKEN || "";

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

/**
 * Fetch with exponential backoff and relayer status tracking.
 * Will automatically retry failed requests with increasing delays.
 */
export async function relayerFetch(
  endpoint: string,
  options: FetchOptions = {},
): Promise<Response> {
  const { maxRetries = 3, skipBackoff = false, ...fetchOptions } = options;
  const url = endpoint.startsWith("http")
    ? endpoint
    : `${RELAYER_URL}${endpoint}`;

  // Check if we're in backoff period
  if (!skipBackoff && isInBackoff()) {
    const error = new Error("Relayer temporarily unavailable (backing off)");
    (
      error as Error & { isBackoff: boolean; isRateLimited: boolean }
    ).isBackoff = true;
    (
      error as Error & { isBackoff: boolean; isRateLimited: boolean }
    ).isRateLimited = false;
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
          const error = new Error("Rate limited (429) - too many requests");
          (error as Error & { isRateLimited: boolean }).isRateLimited = true;
          throw error;
        }

        // Wait longer for rate limits - use Retry-After header if present
        const retryAfter = response.headers.get("Retry-After");
        const delay = retryAfter
          ? Math.min(parseInt(retryAfter, 10) * 1000, 30000)
          : Math.min(1000 * Math.pow(2, attempt + 1), 30000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Success - reset failure count
      markSuccess();
      return response;
    } catch (error) {
      lastError = error as Error;

      // Don't retry on abort
      if (lastError.name === "AbortError") {
        throw lastError;
      }

      // Don't retry on rate limit errors (already handled max retries)
      if ((lastError as Error & { isRateLimited?: boolean }).isRateLimited) {
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

  throw lastError || new Error("Failed to fetch from relayer");
}

/**
 * Health check for the relayer.
 * Returns true if connected, false otherwise.
 */
export async function checkRelayerHealth(): Promise<boolean> {
  try {
    const response = await relayerFetch("/health", {
      maxRetries: 1,
      skipBackoff: true,
    });
    return response.ok;
  } catch {
    return false;
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
