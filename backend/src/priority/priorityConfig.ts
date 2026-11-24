export enum PriorityTier {
  CRITICAL = "CRITICAL",
  HIGH = "HIGH",
  NORMAL = "NORMAL",
  LOW = "LOW",
}

export interface TierSettings {
  concurrency: number;
  maxQueueWaitMs: number;
}

export const TIER_ORDER: readonly PriorityTier[] = [
  PriorityTier.CRITICAL,
  PriorityTier.HIGH,
  PriorityTier.NORMAL,
  PriorityTier.LOW,
];

export const TIER_SETTINGS: Readonly<Record<PriorityTier, TierSettings>> = {
  [PriorityTier.CRITICAL]: {
    concurrency: 16,
    maxQueueWaitMs: 5_000,
  },
  // Admin interventions and dispute intake: an incident responder or an
  // anchor/user reporting a settlement dispute must not be stuck behind a
  // payment burst (ZV-110).
  [PriorityTier.HIGH]: {
    concurrency: 8,
    maxQueueWaitMs: 10_000,
  },
  // Bulk payment traffic (pay/swap/ramp): reserved capacity of its own so
  // it can never fill the HIGH or CRITICAL pools, but bounded tighter than
  // LOW so a payment burst still drains promptly on its own.
  [PriorityTier.NORMAL]: {
    concurrency: 8,
    maxQueueWaitMs: 20_000,
  },
  [PriorityTier.LOW]: {
    concurrency: 4,
    maxQueueWaitMs: 30_000,
  },
};

/**
 * Express reports the path differently before and after a mounted router.
 * Normalize the public API prefixes so all three mounts receive identical
 * scheduling behavior.
 */
export function normalizePriorityPath(path: string): string {
  return path.replace(/^\/api\/v[12](?=\/|$)/, "") || "/";
}

export function classifyPriority(
  method: string,
  path: string,
): PriorityTier | null {
  if (method.toUpperCase() !== "POST") return null;

  const normalizedPath = normalizePriorityPath(path);
  if (/^\/vote(?:\/|$)/.test(normalizedPath)) {
    return PriorityTier.CRITICAL;
  }
  if (/^\/admin(?:\/|$)/.test(normalizedPath)) {
    return PriorityTier.HIGH;
  }
  if (/^\/disputes?(?:\/|$)/.test(normalizedPath)) {
    return PriorityTier.HIGH;
  }
  if (/^\/(?:pay|swap|ramp)(?:\/|$)/.test(normalizedPath)) {
    return PriorityTier.NORMAL;
  }
  if (/^\/comments?(?:\/|$)/.test(normalizedPath)) {
    return PriorityTier.LOW;
  }
  return null;
}

export function isCriticalRequest(method: string, path: string): boolean {
  return classifyPriority(method, path) === PriorityTier.CRITICAL;
}
