// @ts-nocheck
/**
 * SEP-41 transfer-attempt guard — preflight simulator (#925)
 *
 * Before any governance action that depends on the soulbound guarantee (e.g.
 * a contract upgrade), callers must run `simulateSoulboundInvariant()` to
 * confirm the target WASM still exposes the three `TransferAttempted` stubs.
 *
 * The simulation is done via Soroban's preflight / `simulateTransaction` RPC:
 * we construct a dry-run invocation of each guarded function and confirm the
 * result is a `TransferAttempted` error rather than "function not found" or
 * an unexpected success.
 *
 * A SHA-256 evidence hash of the simulation result is written to the audit
 * log so the check is auditable without storing the full XDR envelope.
 */

import { createHash } from "node:crypto";
import type { LoggerPort } from "./interfaces.js";

export const SBT_GUARDED_FUNCTIONS = ["transfer", "transfer_from", "approve"] as const;
export type SbtGuardedFunction = typeof SBT_GUARDED_FUNCTIONS[number];

export interface PreflightResult {
  /** All three stubs verified as panicking with TransferAttempted. */
  invariantHeld: boolean;
  /** Per-function outcomes. */
  outcomes: Record<SbtGuardedFunction, "rejected" | "not_found" | "unexpected_success" | "error">;
  /** SHA-256 of the JSON-serialised outcomes (audit evidence). */
  evidenceHash: string;
  /** ISO timestamp of this simulation run. */
  simulatedAt: string;
}

export interface SbtPreflightDeps {
  /** RPC server that exposes simulateTransaction / getContractData. */
  server: {
    simulateTransaction(tx: unknown): Promise<{ error?: string; results?: unknown[] }>;
  };
  /** Stellar SDK for building the dry-run transaction. */
  buildTransferSimTx(
    contractId: string,
    fn: SbtGuardedFunction,
  ): Promise<unknown>;
  /** Audit log writer. */
  writeAuditEntry(entry: {
    action: string;
    contractId: string;
    evidenceHash: string;
    invariantHeld: boolean;
    simulatedAt: string;
  }): void;
  log: LoggerPort["log"];
}

let preflightDeps: SbtPreflightDeps | null = null;

export function initSbtPreflight(d: SbtPreflightDeps): void {
  preflightDeps = d;
}

function deps(): SbtPreflightDeps {
  if (!preflightDeps) {
    throw new Error("sbt-preflight: initSbtPreflight() must be called before use");
  }
  return preflightDeps;
}

/**
 * Simulate all three guarded entrypoints and verify each panics with
 * `TransferAttempted`.  Returns a `PreflightResult` with an evidence hash
 * suitable for recording in the audit log.
 *
 * A WASM that is missing any stub causes `invariantHeld: false`, which MUST
 * block the upgrade / governance action calling this function.
 */
export async function simulateSoulboundInvariant(
  contractId: string,
): Promise<PreflightResult> {
  const d = deps();
  const simulatedAt = new Date().toISOString();
  const outcomes: PreflightResult["outcomes"] = {
    transfer: "error",
    transfer_from: "error",
    approve: "error",
  };

  for (const fn of SBT_GUARDED_FUNCTIONS) {
    try {
      const tx = await d.buildTransferSimTx(contractId, fn);
      const result = await d.server.simulateTransaction(tx);

      if (result.error) {
        // A "function not found" or similar host-level error means the stub
        // was removed — that's the regression case we guard against.
        const errLower = result.error.toLowerCase();
        if (errLower.includes("function not found") || errLower.includes("missing")) {
          outcomes[fn] = "not_found";
        } else if (errLower.includes("transferattempted") || errLower.includes("transfer_attempted")) {
          // Expected: the stub panics with TransferAttempted.
          outcomes[fn] = "rejected";
        } else {
          outcomes[fn] = "error";
        }
      } else if (result.results && result.results.length > 0) {
        // A simulation that *succeeded* (returned a result) means the stub
        // was replaced with a function that doesn't panic — guard regression.
        outcomes[fn] = "unexpected_success";
      } else {
        outcomes[fn] = "error";
      }
    } catch (err) {
      d.log("warn", "sbt_preflight_simulation_failed", {
        contractId,
        fn,
        error: (err as Error).message,
      });
      outcomes[fn] = "error";
    }
  }

  const invariantHeld = SBT_GUARDED_FUNCTIONS.every((fn) => outcomes[fn] === "rejected");

  const evidencePayload = JSON.stringify({ contractId, simulatedAt, outcomes });
  const evidenceHash = createHash("sha256").update(evidencePayload).digest("hex");

  const result: PreflightResult = { invariantHeld, outcomes, evidenceHash, simulatedAt };

  // Record in audit log regardless of outcome so regressions are traceable.
  try {
    d.writeAuditEntry({
      action: "sbt_preflight_simulation",
      contractId,
      evidenceHash,
      invariantHeld,
      simulatedAt,
    });
  } catch (auditErr) {
    d.log("warn", "sbt_preflight_audit_write_failed", {
      error: (auditErr as Error).message,
    });
  }

  if (!invariantHeld) {
    d.log("error", "sbt_guard_regression_detected", {
      contractId,
      outcomes,
      evidenceHash,
    });
  } else {
    d.log("info", "sbt_preflight_invariant_confirmed", {
      contractId,
      evidenceHash,
    });
  }

  return result;
}

/**
 * Enforce the soulbound invariant as a preflight gate.
 *
 * Throws if the invariant does not hold.  Call this before every governance
 * action that depends on non-transferability (upgrades, member additions
 * that gate on SBT existence, etc.).
 */
export async function enforceSoulboundPreflight(contractId: string): Promise<PreflightResult> {
  const result = await simulateSoulboundInvariant(contractId);
  if (!result.invariantHeld) {
    throw new Error(
      `SEP-41 soulbound invariant check failed for ${contractId}: ` +
        `one or more TransferAttempted stubs are missing. ` +
        `Evidence hash: ${result.evidenceHash}`,
    );
  }
  return result;
}
