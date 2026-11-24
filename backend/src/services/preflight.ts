/**
 * Deployment Preflight — ZV-070 (#914)
 *
 * Validates that every required runtime dependency is reachable before the
 * server begins accepting traffic.  Any failed check is logged at `error` level
 * and causes `runPreflight` to throw, so the process exits non-zero and the
 * platform (Fly.io, Docker, Kubernetes) can restart or surface the issue.
 *
 * Adding a new check: implement `PreflightCheck`, push it onto the `CHECKS`
 * array, and optionally mark it `required: false` to demote it from a fatal
 * fail to a warning.
 */

import { log } from "./logger.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PreflightResult {
  name: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface PreflightCheck {
  name: string;
  /** When false a failure is logged as a warning but does not abort startup. */
  required?: boolean;
  run(): Promise<void>;
}

export interface PreflightReport {
  passed: boolean;
  results: PreflightResult[];
  durationMs: number;
}

// ── Built-in checks ──────────────────────────────────────────────────────────

/**
 * Checks that one or more required environment variables are present and
 * non-empty.  Use for secrets that cannot have a sensible default.
 */
export function envVarCheck(vars: string[]): PreflightCheck {
  return {
    name: `env:${vars.join(",")}`,
    required: true,
    async run() {
      const missing = vars.filter((v) => !process.env[v]);
      if (missing.length > 0) {
        throw new Error(`Missing required env vars: ${missing.join(", ")}`);
      }
    },
  };
}

/**
 * Verifies that a URL is reachable via a simple HTTP HEAD (or GET) request.
 * Times out after `timeoutMs` (default: 5 000 ms).
 */
export function httpReachabilityCheck(
  name: string,
  url: string,
  options: { method?: string; timeoutMs?: number; required?: boolean } = {},
): PreflightCheck {
  return {
    name,
    required: options.required ?? true,
    async run() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
      try {
        const res = await fetch(url, {
          method: options.method ?? "HEAD",
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Checks that a Soroban RPC endpoint responds to `getLatestLedger`.
 */
export function sorobanRpcCheck(rpcUrl: string): PreflightCheck {
  return {
    name: `soroban_rpc:${rpcUrl}`,
    required: true,
    async run() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      try {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger", params: [] }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
        const body = (await res.json()) as { result?: { sequence?: number }; error?: unknown };
        if (body.error) throw new Error(`RPC error: ${JSON.stringify(body.error)}`);
        if (typeof body.result?.sequence !== "number") {
          throw new Error("Unexpected RPC response shape");
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Checks that a PostgreSQL-compatible database is accepting connections.
 * Accepts any object with a `query` method (Postgres.js, pg, etc.).
 */
export function databaseCheck(
  db: { query(sql: string): Promise<unknown> },
  label = "database",
): PreflightCheck {
  return {
    name: label,
    required: true,
    async run() {
      await db.query("SELECT 1");
    },
  };
}

// ── Runner ───────────────────────────────────────────────────────────────────

/**
 * Run all checks concurrently and return a report.
 *
 * Throws if any `required` check fails; non-required failures are included in
 * the report as warnings but do not cause a throw.
 */
export async function runPreflight(
  checks: PreflightCheck[],
): Promise<PreflightReport> {
  const start = Date.now();

  const results = await Promise.all(
    checks.map(async (check): Promise<PreflightResult & { required: boolean }> => {
      const t0 = Date.now();
      try {
        await check.run();
        return { name: check.name, ok: true, durationMs: Date.now() - t0, required: check.required ?? true };
      } catch (err) {
        return {
          name: check.name,
          ok: false,
          durationMs: Date.now() - t0,
          error: (err as Error).message,
          required: check.required ?? true,
        };
      }
    }),
  );

  const passed = results.every((r) => r.ok || !r.required);

  for (const r of results) {
    if (r.ok) {
      log("info", "preflight_check_passed", { check: r.name, durationMs: r.durationMs });
    } else if (r.required) {
      log("error", "preflight_check_failed", { check: r.name, error: r.error, durationMs: r.durationMs });
    } else {
      log("warn", "preflight_check_warning", { check: r.name, error: r.error, durationMs: r.durationMs });
    }
  }

  const report: PreflightReport = {
    passed,
    results: results.map(({ required: _, ...r }) => r),
    durationMs: Date.now() - start,
  };

  if (!passed) {
    const failed = results.filter((r) => !r.ok && r.required).map((r) => r.name);
    throw new Error(`Deployment preflight failed: ${failed.join(", ")}`);
  }

  log("info", "preflight_complete", { passed, durationMs: report.durationMs });
  return report;
}
