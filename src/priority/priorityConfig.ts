/**
 * priorityConfig.ts
 * -----------------------------------------------------------------------
 * Central definition of the request priority model for issue #188.
 *
 * Tiers (highest to lowest):
 *   CRITICAL - vote submissions; must never be delayed by lower tiers
 *   HIGH     - comment submissions, event notifications
 *   MEDIUM   - proposal results, Merkle root queries
 *   LOW      - DAO listings, health checks, IPFS fetches
 * -----------------------------------------------------------------------
 */

export enum PriorityTier {
  CRITICAL = "CRITICAL",
  HIGH = "HIGH",
  MEDIUM = "MEDIUM",
  LOW = "LOW",
}

/** Order used for queue draining -- lower index = served first. */
export const TIER_ORDER: PriorityTier[] = [
  PriorityTier.CRITICAL,
  PriorityTier.HIGH,
  PriorityTier.MEDIUM,
  PriorityTier.LOW,
];

export interface TierSettings {
  /** Max number of requests processed concurrently for this tier. */
  concurrency: number;
  /** Requests allowed per windowMs (token-bucket-ish rate limit). */
  rateLimit: { max: number; windowMs: number };
  /** How long a request may sit in queue before it's rejected (ms). */
  maxQueueWaitMs: number;
}

export const TIER_SETTINGS: Record<PriorityTier, TierSettings> = {
  [PriorityTier.CRITICAL]: {
    concurrency: 32,
    rateLimit: { max: 600, windowMs: 60_000 }, // generous -- must not be delayed
    maxQueueWaitMs: 5_000,
  },
  [PriorityTier.HIGH]: {
    concurrency: 16,
    rateLimit: { max: 300, windowMs: 60_000 },
    maxQueueWaitMs: 8_000,
  },
  [PriorityTier.MEDIUM]: {
    concurrency: 8,
    rateLimit: { max: 150, windowMs: 60_000 },
    maxQueueWaitMs: 15_000,
  },
  [PriorityTier.LOW]: {
    concurrency: 4,
    rateLimit: { max: 60, windowMs: 60_000 },
    maxQueueWaitMs: 30_000,
  },
};

/**
 * Route -> tier mapping. Matched in order; first match wins.
 * `method` is optional (defaults to matching any method).
 */
export interface RouteRule {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathPattern: RegExp;
  tier: PriorityTier;
}

export const ROUTE_RULES: RouteRule[] = [
  // Critical: vote submissions
  { method: "POST", pathPattern: /^\/vote(\/|$)/, tier: PriorityTier.CRITICAL },

  // High: comments, notifications
  { method: "POST", pathPattern: /^\/comments?(\/|$)/, tier: PriorityTier.HIGH },
  { method: "POST", pathPattern: /^\/notifications?(\/|$)/, tier: PriorityTier.HIGH },

  // Medium: proposal results, Merkle root queries
  { pathPattern: /^\/proposals\/.*\/results?(\/|$)/, tier: PriorityTier.MEDIUM },
  { pathPattern: /^\/merkle-root(\/|$)/, tier: PriorityTier.MEDIUM },

  // Low: DAO listings, health checks, IPFS fetches
  { pathPattern: /^\/health(\/|$)/, tier: PriorityTier.LOW },
  { pathPattern: /^\/daos?(\/|$)/, tier: PriorityTier.LOW },
  { pathPattern: /^\/ipfs(\/|$)/, tier: PriorityTier.LOW },
];

/** Fallback tier for anything not matched above. */
export const DEFAULT_TIER = PriorityTier.MEDIUM;

export function classifyRequest(method: string, path: string): PriorityTier {
  for (const rule of ROUTE_RULES) {
    if (rule.method && rule.method !== method.toUpperCase()) continue;
    if (rule.pathPattern.test(path)) return rule.tier;
  }
  return DEFAULT_TIER;
}
