// Drift guard — ensures frontend CONTRACTS stay in sync with on-chain deployments
import { CONTRACTS, NETWORK_CONFIG } from "../config/contracts";

export interface DriftReport {
  driftDetected: boolean;
  mismatches: Array<{ field: string; frontend: string; expected: string }>;
  checkedAt: number;
}

/**
 * Check for contract drift against an optional expected map (e.g., from backend /config)
 * If no expected provided, performs basic sanity checks (valid Stellar addresses).
 */
export async function checkContractDrift(
  expected?: Partial<typeof CONTRACTS>,
): Promise<DriftReport> {
  const mismatches: DriftReport["mismatches"] = [];
  if (expected) {
    for (const [key, val] of Object.entries(expected)) {
      const frontendVal = (CONTRACTS as Record<string, string>)[key];
      if (frontendVal && frontendVal !== val) {
        mismatches.push({
          field: key,
          frontend: frontendVal,
          expected: val as string,
        });
      }
    }
  } else {
    for (const [key, val] of Object.entries(CONTRACTS)) {
      if (!/^C[A-Z2-7]{55}$/.test(val as string)) {
        mismatches.push({
          field: key,
          frontend: val as string,
          expected: "valid C... address",
        });
      }
    }
    // Also ensure network config is consistent
    if (!NETWORK_CONFIG.rpcUrl || !NETWORK_CONFIG.networkPassphrase) {
      mismatches.push({
        field: "NETWORK_CONFIG",
        frontend: JSON.stringify(NETWORK_CONFIG),
        expected: "valid network config",
      });
    }
  }
  const report: DriftReport = {
    driftDetected: mismatches.length > 0,
    mismatches,
    checkedAt: Date.now(),
  };
  if (report.driftDetected) {
    console.warn("[DriftGuard] drift detected", report);
  }
  return report;
}

export function assertNoDrift(report: DriftReport): void {
  if (report.driftDetected) {
    throw new Error(
      `Contract drift detected: ${JSON.stringify(report.mismatches, null, 2)}`,
    );
  }
}

// CLI helper for CI: run with `npx tsx frontend/src/lib/driftGuard.ts` or via node script
if (import.meta.url === `file://${process.argv[1]}`) {
  checkContractDrift().then((r) => {
    if (r.driftDetected) {
      console.error("Drift detected:", r.mismatches);
      process.exit(1);
    } else {
      console.log("Drift check passed — no drift detected");
    }
  });
}
