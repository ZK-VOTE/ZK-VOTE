/**
 * Device-aware proof provisioner (ZV-129).
 *
 * These values are CONSERVATIVE baseline estimates from the existing worker
 * (#728), not yet release-device measurements. CI's fixture matrix must be
 * updated when validated peak-memory measurements become available.
 * The Merkle depth is an election/circuit property: never lower it to fit RAM.
 */
export const MIN_DEVICE_MEMORY_GB = 2; // historical compatibility hint
export const DEPTH_PEAK_MEMORY_MIB = {
  18: 420,
  20: 600,
  25: 1200,
} as const;

export type SupportedProofDepth = keyof typeof DEPTH_PEAK_MEMORY_MIB;
export type ProvingRoute = "worker" | "main" | "unavailable";
export interface ProvingPlan {
  route: ProvingRoute;
  depth: number;
  requiredMib: number | null;
  budgetMib: number | null;
  reason: string | null;
}

export function selectProvingPlan(
  depth: number,
  options: {
    navigator?: Pick<Navigator, "userAgent"> & { deviceMemory?: number };
    workerAvailable?: boolean;
    rustAvailable?: boolean;
  } = {},
): ProvingPlan {
  const requiredMib = Object.prototype.hasOwnProperty.call(DEPTH_PEAK_MEMORY_MIB, depth)
    ? DEPTH_PEAK_MEMORY_MIB[depth as SupportedProofDepth]
    : null;
  if (requiredMib === null) {
    return {
      route: "unavailable",
      depth,
      requiredMib: null,
      budgetMib: null,
      reason: `This election uses Merkle depth ${depth}, which has no validated local proving memory profile. The depth cannot be changed for an individual voter. Use a supported device or contact the election administrator.`,
    };
  }

  const nav = options.navigator ??
    (typeof navigator === "undefined" ? undefined : navigator);
  const memoryGb = (nav as { deviceMemory?: number } | undefined)?.deviceMemory;
  // deviceMemory is a coarse browser hint, not available in every engine.
  // Do not pretend a missing measurement establishes sufficient capacity.
  const budgetMib = typeof memoryGb === "number" && Number.isFinite(memoryGb) && memoryGb > 0
    ? Math.floor(memoryGb * 1024 * 0.85)
    : null;
  if (budgetMib !== null && requiredMib > budgetMib) {
    return {
      route: "unavailable",
      depth,
      requiredMib,
      budgetMib,
      reason: `This election requires a depth-${depth} proof (estimated peak ${requiredMib} MiB), but this device's measured browser memory budget is ${budgetMib} MiB. No proof was started. Use a device with more memory; the election depth cannot safely be reduced. Remote witness submission is not enabled because it would expose private vote inputs.`,
    };
  }

  const hasWorker = options.workerAvailable ?? (typeof Worker !== "undefined");
  // On constrained/unknown-memory devices prefer worker isolation; the
  // optional Rust main-thread prover is reserved for high-memory browsers.
  const useMain = options.rustAvailable === true && budgetMib !== null && budgetMib >= 4096;
  if (!hasWorker && !useMain) {
    return {
      route: "unavailable", depth, requiredMib, budgetMib,
      reason: "This browser cannot run a proving worker safely. Try an up-to-date desktop browser. Private witness data is never sent to an untrusted proving server.",
    };
  }
  return { route: useMain ? "main" : "worker", depth, requiredMib, budgetMib, reason: null };
}

/** Legacy UI helper: only a definitive preflight failure is returned. */
export function provingPreflightError(
  nav: Navigator = (typeof navigator === "undefined" ? {} : navigator) as Navigator,
  depth = 18,
): string | null {
  return selectProvingPlan(depth, {
    navigator: nav,
    workerAvailable: true,
    rustAvailable: false,
  }).reason;
}
