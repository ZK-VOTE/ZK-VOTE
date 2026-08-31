/**
 * Postgres Migration Runner (issue #305)
 *
 * The existing runner in `migrate.ts` is synchronous because better-sqlite3 is
 * synchronous. A Postgres driver is not, so rather than making every SQLite
 * call site async this module provides the second half of the pair: the same
 * migration semantics (ordered files, checksum tracking, per-migration
 * transaction, lock, dry-run, targeted rollback) driven over an async executor.
 *
 * Both runners read migration files through `loadMigrations()`, so file naming,
 * ID parsing and checksums are shared. The only thing that differs is the
 * directory (`migrations/` vs `migrations/postgres/`) and how SQL is executed.
 *
 * The executor is an interface, not a `pg.Pool`, so the runner is testable
 * without a live database and without `pg` installed.
 */

import path from "path";
import { fileURLToPath } from "url";

import {
  loadMigrations,
  type MigrationFile,
  type MigrationResult,
  type MigrationOptions,
  type AppliedMigration,
} from "./migrate.js";
import { sqlFlavorFor, type SqlFlavor } from "./dbDialect.js";
import { createLogger } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SQLITE_MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const POSTGRES_MIGRATIONS_DIR = path.resolve(
  __dirname,
  "..",
  "migrations",
  "postgres",
);

const pgLogger = createLogger("migrate-pg");

/** Postgres advisory-lock key. Arbitrary but stable — collisions would only
 *  serialise unrelated advisory locks, never corrupt state. */
export const MIGRATION_ADVISORY_LOCK_KEY = 0x7a6b_0305;

/**
 * Where the migration files for a given SQL flavour live.
 *
 * `migrations/postgres/` is a subdirectory of `migrations/`, and
 * `loadMigrations()` only picks up `*.sql` entries (never directories), so the
 * SQLite runner is unaffected by its presence.
 */
export function migrationsDirFor(flavor: SqlFlavor = sqlFlavorFor()): string {
  return flavor === "postgres" ? POSTGRES_MIGRATIONS_DIR : SQLITE_MIGRATIONS_DIR;
}

/** Minimal async SQL executor — satisfied by `pg.Pool` and by test doubles. */
export interface SqlExecutor {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

// ============================================
// STATE TRACKING
// ============================================

async function ensureMigrationsTable(exec: SqlExecutor): Promise<void> {
  await exec.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      checksum TEXT,
      duration_ms INTEGER
    )
  `);
}

export async function getAppliedMigrationsPg(
  exec: SqlExecutor,
): Promise<AppliedMigration[]> {
  await ensureMigrationsTable(exec);
  const { rows } = await exec.query(
    "SELECT id, applied_at, checksum, duration_ms FROM _migrations ORDER BY id ASC",
  );
  return rows as unknown as AppliedMigration[];
}

// ============================================
// LOCK
// ============================================

/**
 * Take the migration lock.
 *
 * SQLite has no advisory locks, so `migrate.ts` emulates one with a row in
 * `metadata` plus a timeout. Postgres has a real session-scoped advisory lock,
 * which is strictly better: it is released automatically if the process dies,
 * so there is no stale lock to steal.
 */
async function acquireLock(exec: SqlExecutor): Promise<boolean> {
  const { rows } = await exec.query("SELECT pg_try_advisory_lock($1) AS locked", [
    MIGRATION_ADVISORY_LOCK_KEY,
  ]);
  return rows[0]?.locked === true;
}

async function releaseLock(exec: SqlExecutor): Promise<void> {
  await exec.query("SELECT pg_advisory_unlock($1)", [
    MIGRATION_ADVISORY_LOCK_KEY,
  ]);
}

// ============================================
// EXECUTION
// ============================================

async function applyMigration(
  exec: SqlExecutor,
  migration: MigrationFile,
  direction: "up" | "down",
): Promise<MigrationResult> {
  const sql = direction === "up" ? migration.up : migration.down;
  const start = performance.now();

  try {
    // Postgres has transactional DDL, so a failed migration leaves no partial
    // schema behind — the same atomicity the SQLite runner gets from
    // `database.transaction()`.
    await exec.query("BEGIN");
    try {
      if (sql.trim()) {
        await exec.query(sql);
      }
      if (direction === "up") {
        await exec.query(
          `INSERT INTO _migrations (id, applied_at, checksum, duration_ms)
           VALUES ($1, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), $2, $3)
           ON CONFLICT (id) DO UPDATE SET
             applied_at = EXCLUDED.applied_at,
             checksum = EXCLUDED.checksum,
             duration_ms = EXCLUDED.duration_ms`,
          [
            migration.id,
            migration.checksum,
            Math.round(performance.now() - start),
          ],
        );
      } else {
        await exec.query("DELETE FROM _migrations WHERE id = $1", [
          migration.id,
        ]);
      }
      await exec.query("COMMIT");
    } catch (inner) {
      await exec.query("ROLLBACK");
      throw inner;
    }

    const durationMs = performance.now() - start;
    pgLogger.info("migration_applied", {
      migration: migration.name,
      direction,
      durationMs: Math.round(durationMs),
    });
    return { id: migration.id, direction, success: true, durationMs };
  } catch (err) {
    const error = err as Error;
    pgLogger.error("migration_failed", {
      migration: migration.name,
      direction,
      error: error.message,
    });
    return {
      id: migration.id,
      direction,
      success: false,
      durationMs: performance.now() - start,
      error: error.message,
    };
  }
}

function dryRun(
  migration: MigrationFile,
  direction: "up" | "down",
): MigrationResult {
  const sql = direction === "up" ? migration.up : migration.down;
  pgLogger.info("dry_run", {
    migration: migration.name,
    direction,
    statements: sql
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("--")).length,
  });
  return { id: migration.id, direction, success: true, durationMs: 0 };
}

// ============================================
// MIGRATE UP / DOWN
// ============================================

export async function migrateUpPg(
  exec: SqlExecutor,
  options: MigrationOptions & { migrationsDir?: string } = {},
): Promise<MigrationResult[]> {
  const results: MigrationResult[] = [];
  const migrations = loadMigrations(
    options.migrationsDir ?? POSTGRES_MIGRATIONS_DIR,
  );
  if (migrations.length === 0) {
    pgLogger.info("no_migrations_to_apply", {});
    return results;
  }

  const applied = await getAppliedMigrationsPg(exec);
  const appliedMap = new Map(applied.map((a) => [a.id, a]));

  if (!options.dryRun && !(await acquireLock(exec))) {
    throw new Error(
      "Could not acquire the Postgres migration advisory lock — another " +
        "migration is in progress.",
    );
  }

  try {
    for (const migration of migrations) {
      const existing = appliedMap.get(migration.id);
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          pgLogger.warn("migration_checksum_mismatch", {
            migration: migration.name,
            expected: migration.checksum,
            actual: existing.checksum,
          });
        }
        continue;
      }
      if (options.target && migration.id >= options.target) break;

      const result = options.dryRun
        ? dryRun(migration, "up")
        : await applyMigration(exec, migration, "up");
      results.push(result);
      if (!result.success) {
        pgLogger.error("migration_chain_stopped", {
          failedAt: migration.name,
        });
        break;
      }
    }
  } finally {
    if (!options.dryRun) {
      await releaseLock(exec);
    }
  }

  return results;
}

export async function migrateDownPg(
  exec: SqlExecutor,
  options: MigrationOptions & { migrationsDir?: string } = {},
): Promise<MigrationResult[]> {
  const results: MigrationResult[] = [];
  const migrations = loadMigrations(
    options.migrationsDir ?? POSTGRES_MIGRATIONS_DIR,
  );
  const applied = await getAppliedMigrationsPg(exec);
  const appliedIds = new Set(applied.map((a) => a.id));

  const toRollback: MigrationFile[] = [];
  for (const migration of [...migrations].reverse()) {
    if (!appliedIds.has(migration.id)) continue;
    if (options.target && migration.id <= options.target) break;
    toRollback.push(migration);
  }
  toRollback.reverse();

  if (toRollback.length === 0) {
    pgLogger.info("no_migrations_to_rollback", {});
    return results;
  }

  if (!options.dryRun && !(await acquireLock(exec))) {
    throw new Error("Could not acquire the Postgres migration advisory lock.");
  }

  try {
    for (const migration of toRollback) {
      if (!migration.down) {
        results.push({
          id: migration.id,
          direction: "down",
          success: false,
          durationMs: 0,
          error: "No down SQL available",
        });
        continue;
      }
      const result = options.dryRun
        ? dryRun(migration, "down")
        : await applyMigration(exec, migration, "down");
      results.push(result);
      if (!result.success) break;
    }
  } finally {
    if (!options.dryRun) {
      await releaseLock(exec);
    }
  }

  return results;
}

// ============================================
// PARITY CHECK
// ============================================

export interface MigrationParityEntry {
  id: string;
  sqliteName: string | null;
  postgresName: string | null;
  /** Both flavours define this migration, under the same name. */
  matched: boolean;
  /** Both flavours ship a rollback for it. */
  bothHaveDown: boolean;
}

export interface MigrationParityReport {
  entries: MigrationParityEntry[];
  missingInPostgres: string[];
  missingInSqlite: string[];
  nameMismatches: string[];
  missingDown: string[];
  inParity: boolean;
}

/**
 * Compare the two migration sets and report drift.
 *
 * "Migration parity" in the #305 acceptance criteria means: every migration
 * that exists for SQLite has a same-ID, same-name counterpart for Postgres,
 * and both directions exist on both sides. This function is what makes that
 * assertable in CI — it is deliberately structural, since the SQL bodies must
 * differ by construction.
 */
export function checkMigrationParity(
  sqliteDir: string = SQLITE_MIGRATIONS_DIR,
  postgresDir: string = POSTGRES_MIGRATIONS_DIR,
): MigrationParityReport {
  const sqlite = loadMigrations(sqliteDir);
  const postgres = loadMigrations(postgresDir);

  const sqliteMap = new Map(sqlite.map((m) => [m.id, m]));
  const postgresMap = new Map(postgres.map((m) => [m.id, m]));
  const ids = [...new Set([...sqliteMap.keys(), ...postgresMap.keys()])].sort();

  const entries: MigrationParityEntry[] = [];
  const missingInPostgres: string[] = [];
  const missingInSqlite: string[] = [];
  const nameMismatches: string[] = [];
  const missingDown: string[] = [];

  for (const id of ids) {
    const s = sqliteMap.get(id);
    const p = postgresMap.get(id);
    if (!p) missingInPostgres.push(id);
    if (!s) missingInSqlite.push(id);
    if (s && p && s.name !== p.name) nameMismatches.push(id);
    if ((s && !s.down.trim()) || (p && !p.down.trim())) missingDown.push(id);

    entries.push({
      id,
      sqliteName: s?.name ?? null,
      postgresName: p?.name ?? null,
      matched: !!s && !!p && s.name === p.name,
      bothHaveDown: !!s?.down.trim() && !!p?.down.trim(),
    });
  }

  return {
    entries,
    missingInPostgres,
    missingInSqlite,
    nameMismatches,
    missingDown,
    inParity:
      missingInPostgres.length === 0 &&
      missingInSqlite.length === 0 &&
      nameMismatches.length === 0 &&
      missingDown.length === 0,
  };
}
