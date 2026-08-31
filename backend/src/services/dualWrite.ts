/**
 * Dual-Write Bridge (issue #305)
 *
 * A relay cannot be cut over from SQLite to Postgres in one step: the schema
 * has to be proven under real traffic before anything depends on it. The bridge
 * mirrors every relay write into a shadow backend while the primary keeps
 * serving reads, so a cutover is rehearsed rather than attempted.
 *
 * Three modes, in the order a migration actually goes through them:
 *
 *   1. `off`          — SQLite only. The default; zero overhead.
 *   2. `shadow`       — primary SQLite, mirrored writes to Postgres. Shadow
 *                       failures are counted, not raised (unless
 *                       DB_DUAL_WRITE_STRICT). Reads still come from SQLite.
 *   3. `primary-swap` — DB_BACKEND=postgres with the bridge pointed back at
 *                       SQLite, so the old store stays warm for rollback.
 *
 * The bridge is deliberately at the *statement* level rather than the ORM
 * level: the relay's writes go through both raw `better-sqlite3` prepares and
 * Kysely, and only a statement-level seam catches both.
 */

import { config } from "../config.js";
import { createLogger } from "./logger.js";
import type { SqlExecutor } from "./migratePg.js";

const bridgeLogger = createLogger("dual-write");

export type DualWriteMode = "off" | "shadow" | "primary-swap";

export interface DualWriteStats {
  mode: DualWriteMode;
  /** Writes mirrored successfully to the shadow backend. */
  mirrored: number;
  /** Writes that failed on the shadow backend. */
  failed: number;
  /** Writes skipped because the shadow backend was unavailable. */
  skipped: number;
  /** Rows reconciled by `backfill()`. */
  backfilled: number;
  /** Divergences found by `verify()`. */
  divergences: number;
  lastError: string | null;
  lastMirrorAt: string | null;
}

const stats: DualWriteStats = {
  mode: "off",
  mirrored: 0,
  failed: 0,
  skipped: 0,
  backfilled: 0,
  divergences: 0,
  lastError: null,
  lastMirrorAt: null,
};

let shadow: SqlExecutor | null = null;

/**
 * Resolve the bridge mode from configuration.
 *
 * Note that `primary-swap` is inferred, not configured: it is simply what
 * "dual write is on and the primary is already Postgres" means.
 */
export function resolveDualWriteMode(): DualWriteMode {
  if (!config.dbDualWrite) return "off";
  return config.dbBackend === "postgres" ? "primary-swap" : "shadow";
}

/**
 * Attach a shadow executor. Called once at boot when DB_DUAL_WRITE is on.
 *
 * The executor is passed in rather than built here so the bridge stays testable
 * and so the `primary-swap` direction (Postgres primary, SQLite shadow) reuses
 * the same code. Handing over an executor *is* the enable signal — the env flag
 * decides whether boot constructs one at all — so an explicit executor with
 * `DB_DUAL_WRITE` unset still comes up in `shadow`. Pass `mode` to override.
 */
export function initDualWrite(
  executor: SqlExecutor | null,
  mode?: DualWriteMode,
): DualWriteMode {
  shadow = executor;
  if (mode) {
    stats.mode = executor ? mode : "off";
  } else if (!executor) {
    stats.mode = "off";
  } else {
    const resolved = resolveDualWriteMode();
    stats.mode = resolved === "off" ? "shadow" : resolved;
  }
  bridgeLogger.info("dual_write_init", {
    mode: stats.mode,
    strict: config.dbDualWriteStrict,
  });
  return stats.mode;
}

export function isDualWriteEnabled(): boolean {
  return stats.mode !== "off" && shadow !== null;
}

export function getDualWriteStats(): DualWriteStats {
  return { ...stats };
}

export function resetDualWriteStats(): void {
  stats.mirrored = 0;
  stats.failed = 0;
  stats.skipped = 0;
  stats.backfilled = 0;
  stats.divergences = 0;
  stats.lastError = null;
  stats.lastMirrorAt = null;
}

/**
 * Mirror one write to the shadow backend.
 *
 * Always returns — the caller's transaction on the primary must never be held
 * hostage by the shadow, except when DB_DUAL_WRITE_STRICT is set, which is what
 * you turn on for the final rehearsal before a cutover.
 */
export async function mirrorWrite(
  sql: string,
  params: unknown[] = [],
): Promise<boolean> {
  if (!isDualWriteEnabled()) {
    stats.skipped += 1;
    return false;
  }
  try {
    await shadow!.query(sql, params);
    stats.mirrored += 1;
    stats.lastMirrorAt = new Date().toISOString();
    return true;
  } catch (err) {
    const error = err as Error;
    stats.failed += 1;
    stats.lastError = error.message;
    bridgeLogger.warn("dual_write_mirror_failed", {
      error: error.message,
      // The statement shape is useful; the bound values are not logged because
      // they can carry nullifiers and commitments.
      statement: sql.slice(0, 120),
    });
    if (config.dbDualWriteStrict) {
      throw new Error(`Dual-write mirror failed: ${error.message}`);
    }
    return false;
  }
}

/**
 * Mirror a batch inside a single shadow transaction.
 *
 * Used for the multi-statement relay writes (an event insert plus its partition
 * registry touch, say) so the shadow never observes a half-applied unit.
 */
export async function mirrorBatch(
  statements: Array<{ sql: string; params?: unknown[] }>,
): Promise<boolean> {
  if (!isDualWriteEnabled()) {
    stats.skipped += statements.length;
    return false;
  }
  try {
    await shadow!.query("BEGIN");
    try {
      for (const s of statements) {
        await shadow!.query(s.sql, s.params ?? []);
      }
      await shadow!.query("COMMIT");
    } catch (inner) {
      await shadow!.query("ROLLBACK");
      throw inner;
    }
    stats.mirrored += statements.length;
    stats.lastMirrorAt = new Date().toISOString();
    return true;
  } catch (err) {
    const error = err as Error;
    stats.failed += statements.length;
    stats.lastError = error.message;
    bridgeLogger.warn("dual_write_batch_failed", {
      error: error.message,
      statements: statements.length,
    });
    if (config.dbDualWriteStrict) {
      throw new Error(`Dual-write batch failed: ${error.message}`);
    }
    return false;
  }
}

// ============================================
// VERIFICATION / BACKFILL
// ============================================

export interface TableDivergence {
  table: string;
  primaryCount: number;
  shadowCount: number;
  delta: number;
}

/** Row-count reader for the primary store, injected so this module never
 *  imports `db.ts` (which would create a cycle through `kysely.ts`). */
export type PrimaryCounter = (table: string) => number | Promise<number>;

/**
 * Compare row counts between primary and shadow.
 *
 * Row counts are a coarse check by design: they are cheap enough to run on a
 * schedule against production, and any real divergence (a dropped mirror, a
 * constraint rejecting a row) shows up as a non-zero delta. Content-level
 * verification is the job of the backfill's checksum pass.
 */
export async function verify(
  tables: string[],
  countPrimary: PrimaryCounter,
): Promise<TableDivergence[]> {
  if (!isDualWriteEnabled()) return [];

  const divergences: TableDivergence[] = [];
  for (const table of tables) {
    const primaryCount = await countPrimary(table);
    const { rows } = await shadow!.query(
      `SELECT COUNT(*)::bigint AS count FROM ${quoteIdent(table)}`,
    );
    const shadowCount = Number(rows[0]?.count ?? 0);
    if (primaryCount !== shadowCount) {
      divergences.push({
        table,
        primaryCount,
        shadowCount,
        delta: primaryCount - shadowCount,
      });
    }
  }
  stats.divergences = divergences.length;
  if (divergences.length > 0) {
    bridgeLogger.warn("dual_write_divergence", { divergences });
  }
  return divergences;
}

/**
 * Copy rows the shadow is missing.
 *
 * `rows` is supplied by the caller (read from the primary) rather than read
 * here, again to keep this module free of a dependency on `db.ts`. Inserts use
 * `ON CONFLICT DO NOTHING` so a backfill is safe to re-run and safe to run
 * concurrently with live mirroring.
 */
export async function backfill(
  table: string,
  rows: Array<Record<string, unknown>>,
  conflictColumns: string[],
): Promise<number> {
  if (!isDualWriteEnabled() || rows.length === 0) return 0;

  let inserted = 0;
  for (const row of rows) {
    const columns = Object.keys(row);
    if (columns.length === 0) continue;
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
    const sql =
      `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")}) ` +
      `VALUES (${placeholders}) ` +
      `ON CONFLICT (${conflictColumns.map(quoteIdent).join(", ")}) DO NOTHING`;
    try {
      await shadow!.query(
        sql,
        columns.map((c) => row[c]),
      );
      inserted += 1;
    } catch (err) {
      stats.failed += 1;
      stats.lastError = (err as Error).message;
      bridgeLogger.warn("dual_write_backfill_failed", {
        table,
        error: (err as Error).message,
      });
    }
  }
  stats.backfilled += inserted;
  bridgeLogger.info("dual_write_backfill", { table, inserted });
  return inserted;
}

/**
 * Identifier quoting for interpolated table/column names.
 *
 * Table names here come from module-internal constants and from column keys of
 * rows the relay itself produced, never from request input, but they are still
 * quoted and validated so this helper cannot become an injection point if a
 * future caller is less careful.
 */
function quoteIdent(ident: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
    throw new Error(`Refusing to interpolate unsafe identifier: ${ident}`);
  }
  return `"${ident}"`;
}

/** Tables the bridge mirrors and verifies. */
export const BRIDGED_TABLES = [
  "daos",
  "events",
  "metadata",
  "partition_registry",
  "vote_receipts",
] as const;
