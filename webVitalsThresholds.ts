/**
 * Core Web Vitals budgets (Issue #502), shared by the browser collector and the
 * /api/performance/vitals endpoint so both rate a value the same way.
 */

export const VITAL_NAMES = ["LCP", "FID", "CLS", "INP"] as const;
export type VitalName = (typeof VITAL_NAMES)[number];

export const VITAL_RATINGS = ["good", "needs-improvement", "poor"] as const;
export type VitalRating = (typeof VITAL_RATINGS)[number];

/**
 * `[good, poor]` bounds: a value up to `good` is good, up to `poor` needs
 * improvement, and anything above `poor` is poor. LCP, FID and INP are in
 * milliseconds; CLS is unitless. These match Google's published thresholds.
 */
export const VITAL_THRESHOLDS: Record<VitalName, readonly [good: number, poor: number]> = {
  LCP: [2500, 4000],
  FID: [100, 300],
  CLS: [0.1, 0.25],
  INP: [200, 500],
};

export function rateVital(name: VitalName, value: number): VitalRating {
  const [good, poor] = VITAL_THRESHOLDS[name];
  if (value > poor) return "poor";
  if (value > good) return "needs-improvement";
  return "good";
}

/** `2.6s`, `84ms`, `0.142`: how a value reads in logs and console alerts. */
export function formatVital(name: VitalName, value: number): string {
  if (name === "CLS") return value.toFixed(3);
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}
