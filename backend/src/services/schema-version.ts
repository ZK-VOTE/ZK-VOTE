/**
 * Schema version tracking and migration drift guard (#920 ZV-077)
 *
 * `SCHEMA_VERSION` is the single source of truth for the current migration
 * count.  It must match the highest numbered migration pair on both SQLite and
 * Postgres.  Any discrepancy is surfaced by `checkSchemaDrift()`, which is
 * called during startup and in CI.
 */

import type { Database as DatabaseType } from "better-sqlite3";

/** Canonical schema version — matches the count of applied migration pairs. */
export const SCHEMA_VERSION = 19;

export interface SchemaDriftResult {
  version: number;
  expected: number;
  drift: boolean;
  details: string[];
}

/**
 * Assert that the running database has exactly `SCHEMA_VERSION` migrations
 * applied.  Also checks that every applied SQLite migration has a Postgres
 * parity file when `pgMigrationsDir` is supplied.
 *
 * Throws in production (`NODE_ENV === 'production'`) when drift is detected so
 * the process refuses to start against a stale schema (#920 acceptance
 * criterion — stale docs or missing parity migration fails CI/startup).
 */
export function checkSchemaDrift(
  db: DatabaseType,
  opts: { pgMigrationsDir?: string; throwOnDrift?: boolean } = {},
): SchemaDriftResult {
  const details: string[] = [];
  let applied = 0;

  try {
    const row = db
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM _migrations`)
      .get();
    applied = row?.n ?? 0;
  } catch {
    details.push(
      "_migrations table not found — run migrateUp() before calling checkSchemaDrift()",
    );
    const result: SchemaDriftResult = { version: 0, expected: SCHEMA_VERSION, drift: true, details };
    if (opts.throwOnDrift ?? process.env.NODE_ENV === "production") {
      throw new Error("Schema drift detected: " + details.join("; "));
    }
    return result;
  }

  if (applied !== SCHEMA_VERSION) {
    details.push(
      `Applied migrations: ${applied}, expected: ${SCHEMA_VERSION}`,
    );
  }

  if (opts.pgMigrationsDir) {
    try {
      const { readdirSync } = await import("fs");
      const pgFiles = new Set(
        readdirSync(opts.pgMigrationsDir).map((f) => f.replace(/\.(?:up|down)\.sql$/i, "")),
      );
      const applied_ids = db
        .prepare<[], { id: string }>(`SELECT id FROM _migrations`)
        .all();
      for (const { id } of applied_ids) {
        const prefix = id.replace(/^0+/, "");
        const hasParity = [...pgFiles].some((f) => f.replace(/^0+/, "").startsWith(prefix));
        if (!hasParity) {
          details.push(
            `SQLite migration ${id} has no Postgres parity in ${opts.pgMigrationsDir}`,
          );
        }
      }
    } catch (e) {
      details.push(`Postgres parity check failed: ${(e as Error).message}`);
    }
  }

  const drift = details.length > 0;
  if (drift && (opts.throwOnDrift ?? process.env.NODE_ENV === "production")) {
    throw new Error("Schema drift detected: " + details.join("; "));
  }
  return { version: applied, expected: SCHEMA_VERSION, drift, details };
}
