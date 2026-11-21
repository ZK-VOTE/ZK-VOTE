/**
 * Core Web Vitals collector (Issues #210, #502).
 *
 * Captures LCP, CLS and INP with the `web-vitals` library, plus FID from the
 * browser's `first-input` entry (web-vitals 5+ dropped FID in favour of INP,
 * but our budget still tracks it). Each final value is:
 *   - rated against `VITAL_THRESHOLDS` (LCP ≤ 2.5s, FID ≤ 100ms, CLS ≤ 0.1, INP ≤ 200ms);
 *   - in development, flagged in the console when it misses the budget;
 *   - sent with `navigator.sendBeacon` (keepalive `fetch` as fallback) to the
 *     performance endpoint, unless Do Not Track / Global Privacy Control is on.
 *
 * Reports carry no query strings, wallet addresses, cookies or user identity:
 * only the metric, the path (with Stellar addresses masked) and a coarse
 * viewport class.
 */
import { onCLS, onINP, onLCP, type Metric } from "web-vitals";
import {
  formatVital,
  rateVital,
  VITAL_THRESHOLDS,
  type VitalName,
  type VitalRating,
} from "./webVitalsThresholds";

export { VITAL_THRESHOLDS, rateVital, formatVital } from "./webVitalsThresholds";
export type { VitalName, VitalRating } from "./webVitalsThresholds";

/** Same-origin Vercel function that receives the beacons. */
export const DEFAULT_VITALS_ENDPOINT = "/api/performance/vitals";

export type ViewportClass = "mobile" | "tablet" | "desktop";

export interface VitalSample {
  name: VitalName;
  value: number;
  delta: number;
  id: string;
  navigationType: string;
}

/** The body of each beacon. */
export interface VitalReport extends VitalSample {
  rating: VitalRating;
  path: string;
  viewport: ViewportClass;
  timestamp: number;
}

export type VitalListener = (sample: VitalSample) => void;

export interface VitalSources {
  onLCP: (listener: VitalListener) => void;
  onCLS: (listener: VitalListener) => void;
  onINP: (listener: VitalListener) => void;
  onFID: (listener: VitalListener) => void;
}

export interface WebVitalsOptions {
  /** Where beacons go; `null` or `""` disables sending. Defaults to `VITE_WEB_VITALS_ENDPOINT`, then `DEFAULT_VITALS_ENDPOINT`. */
  endpoint?: string | null;
  /** Console alerts for budget misses. Defaults to on in development builds only. */
  devAlerts?: boolean;
  logger?: Pick<Console, "warn" | "error">;
  navigator?: Navigator;
  /** Replace metric sources (tests, or a different measurement library). */
  sources?: Partial<VitalSources>;
}

const STELLAR_ADDRESS = /\b[GCM][A-Z2-7]{55}\b/g;

function fromMetric(metric: Metric): VitalSample {
  return {
    name: metric.name as VitalName,
    value: metric.value,
    delta: metric.delta,
    id: metric.id,
    navigationType: metric.navigationType,
  };
}

function navigationType(): string {
  const [entry] = (globalThis.performance?.getEntriesByType?.("navigation") ??
    []) as PerformanceNavigationTiming[];
  return entry?.type?.replace(/_/g, "-") ?? "navigate";
}

/**
 * First Input Delay: time from the first user interaction to the moment the
 * browser could start handling it. Reported once per page load.
 */
export function onFID(
  listener: VitalListener,
  Observer: typeof PerformanceObserver | undefined = globalThis.PerformanceObserver,
): void {
  if (typeof Observer !== "function") return;
  let reported = false;
  try {
    const observer = new Observer((list) => {
      if (reported) return;
      const [entry] = list.getEntries() as PerformanceEventTiming[];
      if (!entry) return;
      reported = true;
      observer.disconnect();
      const value = Math.max(0, entry.processingStart - entry.startTime);
      listener({
        name: "FID",
        value,
        delta: value,
        id: `fid-${Math.round(entry.startTime)}`,
        navigationType: navigationType(),
      });
    });
    observer.observe({ type: "first-input", buffered: true });
  } catch {
    // Browsers without first-input support simply report no FID.
  }
}

export const defaultVitalSources: VitalSources = {
  onLCP: (listener) => onLCP((metric) => listener(fromMetric(metric))),
  onCLS: (listener) => onCLS((metric) => listener(fromMetric(metric))),
  onINP: (listener) => onINP((metric) => listener(fromMetric(metric))),
  onFID: (listener) => onFID(listener),
};

export function viewportClass(width: number): ViewportClass {
  if (width < 768) return "mobile";
  if (width < 1024) return "tablet";
  return "desktop";
}

/** The current path without query string or hash, with Stellar addresses masked. */
export function reportPath(pathname: string): string {
  return (pathname || "/").replace(STELLAR_ADDRESS, "[address]");
}

export function toReport(sample: VitalSample, now = Date.now()): VitalReport {
  return {
    ...sample,
    value: sample.name === "CLS" ? Number(sample.value.toFixed(4)) : Math.round(sample.value),
    delta: sample.name === "CLS" ? Number(sample.delta.toFixed(4)) : Math.round(sample.delta),
    rating: rateVital(sample.name, sample.value),
    path: reportPath(globalThis.location?.pathname ?? "/"),
    viewport: viewportClass(globalThis.innerWidth ?? 1024),
    timestamp: now,
  };
}

/** True unless the visitor asked not to be tracked (Do Not Track or Global Privacy Control). */
export function trackingAllowed(nav: Navigator | undefined = globalThis.navigator): boolean {
  if (!nav) return false;
  const withPrivacy = nav as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
  const windowDnt = (globalThis as { doNotTrack?: string }).doNotTrack;
  return !(
    nav.doNotTrack === "1" ||
    nav.doNotTrack === "yes" ||
    withPrivacy.msDoNotTrack === "1" ||
    windowDnt === "1" ||
    withPrivacy.globalPrivacyControl === true
  );
}

/**
 * Sends one report. Prefers `sendBeacon`, which survives the page being
 * hidden or closed (when LCP and CLS are finalised); falls back to a keepalive
 * `fetch` when the beacon is unavailable or refused. Never sends credentials.
 */
export function sendVitalReport(
  report: VitalReport,
  endpoint: string,
  nav: Navigator | undefined = globalThis.navigator,
): "beacon" | "fetch" | "none" {
  const body = JSON.stringify(report);
  if (nav && typeof nav.sendBeacon === "function") {
    try {
      if (nav.sendBeacon(endpoint, new Blob([body], { type: "application/json" }))) return "beacon";
    } catch {
      // Fall through to fetch.
    }
  }
  if (typeof globalThis.fetch === "function") {
    void globalThis
      .fetch(endpoint, {
        method: "POST",
        body,
        keepalive: true,
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
      })
      .catch(() => {});
    return "fetch";
  }
  return "none";
}

/** Console alert for a value over budget: `warn` for needs-improvement, `error` for poor. */
export function alertOnBreach(
  report: VitalReport,
  logger: Pick<Console, "warn" | "error"> = console,
): void {
  if (report.rating === "good") return;
  const [good, poor] = VITAL_THRESHOLDS[report.name];
  const value = formatVital(report.name, report.value);
  if (report.rating === "poor") {
    logger.error(
      `[web-vitals] ${report.name} ${value} is poor: over the ${formatVital(report.name, poor)} limit (target ${formatVital(report.name, good)}) on ${report.path}`,
    );
  } else {
    logger.warn(
      `[web-vitals] ${report.name} ${value} needs improvement: over the ${formatVital(report.name, good)} target on ${report.path}`,
    );
  }
}

let started = false;

/**
 * Starts collecting. Safe to call more than once; only the first call
 * registers observers. Returns false when nothing was started.
 */
export function initWebVitals(options: WebVitalsOptions = {}): boolean {
  if (started || typeof window === "undefined") return false;
  started = true;

  const nav = options.navigator ?? globalThis.navigator;
  const configured =
    options.endpoint === undefined ? import.meta.env.VITE_WEB_VITALS_ENDPOINT : options.endpoint;
  const endpoint = configured === undefined ? DEFAULT_VITALS_ENDPOINT : configured;
  const canSend = Boolean(endpoint) && trackingAllowed(nav);
  const devAlerts = options.devAlerts ?? Boolean(import.meta.env.DEV);
  const logger = options.logger ?? console;
  const sources: VitalSources = { ...defaultVitalSources, ...options.sources };

  const handle: VitalListener = (sample) => {
    const report = toReport(sample);
    if (devAlerts) alertOnBreach(report, logger);
    if (canSend && endpoint) sendVitalReport(report, endpoint, nav);
  };

  sources.onLCP(handle);
  sources.onCLS(handle);
  sources.onINP(handle);
  sources.onFID(handle);
  return true;
}

/** Allows `initWebVitals` to run again. For tests. */
export function resetWebVitalsForTesting(): void {
  started = false;
}
