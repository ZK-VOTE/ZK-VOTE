/**
 * Database Migration Framework
 *
 * Executes ordered SQL migration files with:
 * - Forward (up) and rollback (down) support
 * - Transaction wrapping per migration for atomicity
 * - Migration state tracking via _migrations table
 * - Checksum verification for idempotency
 * - Dry-run mode for testing
 * - Lock mechanism to prevent concurrent migrations
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { type Database as DatabaseType } from "better-sqlite3";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const LOCK_KEY = "migration_lock";
const LOCK_TIMEOUT_MS = 60_000; // 1 minute lock timeout

// ============================================
// TYPES
// ============================================

export interface MigrationFile {
  id: string; // e.g. "001"
  name: string; // e.g. "001_initial_schema"
  up: string; // SQL content for forward migration
  down: string; // SQL content for rollback
  checksum: string; // SHA256 of the up SQL
}

export interface AppliedMigration {
  id: string;
  applied_at: string;
  checksum: string | null;
  duration_ms: number | null;
}

export interface MigrationResult {
  id: string;
  direction: "up" | "down";
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface MigrationOptions {
  dryRun?: boolean;
  target?: string; // Target migration ID (exclusive for up, inclusive for down)
}

// ============================================
// LOGGER
// ============================================

import { createLogger } from "./logger.js";

const migrateLogger = createLogger("migrate");
const log = (
  level: "debug" | "info" | "warn" | "error",
  event: string,
  meta: Record<string, unknown> = {},
): void => {
  migrateLogger[level](event, meta);
};

// ============================================
// FILE LOADING
// ============================================

/**
 * Parse a migration ID from a filename like "001_initial_schema.up.sql"
 */
function parseMigrationId(filename: string): string | null {
  const match = filename.match(/^(\d+)_.*\.(up|down)\.sql$/);
  return match ? match[1] : null;
}

/**
 * Parse migration name (without direction suffix) from filename.
 * E.g. "001_initial_schema.up.sql" → "001_initial_schema"
 */
function parseMigrationName(filename: string): string | null {
  const match = filename.match(/^(\d+_.+)\.(up|down)\.sql$/);
  return match ? match[1] : null;
}

/**
 * Compute SHA256 checksum of SQL content.
 */
function computeChecksum(sql: string): string {
  return crypto.createHash("sha256").update(sql, "utf-8").digest("hex");
}

/**
 * Load all migration files from the migrations directory.
 * Returns migrations sorted by ID ascending.
 */
export function loadMigrations(migrationsDir?: string): MigrationFile[] {
  const dir = migrationsDir ?? MIGRATIONS_DIR;

  if (!fs.existsSync(dir)) {
    log("info", "no_migrations_dir", { path: dir });
    return [];
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql"));
  const migrationMap = new Map<string, { up?: string; down?: string }>();

  for (const file of files) {
    const name = parseMigrationName(file);
    const id = parseMigrationId(file);
    if (!name || !id) continue;

    if (!migrationMap.has(name)) {
      migrationMap.set(name, {});
    }

    const entry = migrationMap.get(name)!;
    const content = fs.readFileSync(path.join(dir, file), "utf-8");

    if (file.endsWith(".up.sql")) {
      entry.up = content;
    } else if (file.endsWith(".down.sql")) {
      entry.down = content;
    }
  }

  // Build sorted list
  const migrations: MigrationFile[] = [];
  for (const [name, { up, down }] of migrationMap) {
    // Extract the numeric ID from the beginning of the name (e.g. "001" from "001_initial_schema")
    const idMatch = name.match(/^(\d+)/);
    if (!idMatch) {
      log("warn", "migration_missing_id", { name });
      continue;
    }
    const id = idMatch[1];
    if (!up) {
      log("warn", "migration_missing_up", { name });
      continue;
    }
    migrations.push({
      id,
      name,
      up,
      down: down ?? "",
      checksum: computeChecksum(up),
    });
  }

  migrations.sort((a, b) => a.id.localeCompare(b.id));
  return migrations;
}

// ============================================
// STATE TRACKING
// ============================================

/**
 * Ensure the _migrations tracking table exists.
 */
function ensureMigrationsTable(database: DatabaseType): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      checksum TEXT,
      duration_ms INTEGER
    )
  `);
}

/**
 * Get all applied migrations, sorted by ID ascending.
 */
export function getAppliedMigrations(
  database: DatabaseType,
): AppliedMigration[] {
  ensureMigrationsTable(database);
  const rows = database
    .prepare(
      "SELECT id, applied_at, checksum, duration_ms FROM _migrations ORDER BY id ASC",
    )
    .all() as AppliedMigration[];
  return rows;
}

/**
 * Get migration status — list all migrations with their applied state.
 */
export function getMigrationStatus(
  database: DatabaseType,
  migrationsDir?: string,
): Array<
  MigrationFile & {
    applied: boolean;
    applied_at: string | null;
    checksum_match: boolean | null;
  }
> {
  const migrations = loadMigrations(migrationsDir);
  const applied = getAppliedMigrations(database);
  const appliedMap = new Map(applied.map((a) => [a.id, a]));

  return migrations.map((m) => {
    const app = appliedMap.get(m.id);
    return {
      ...m,
      applied: !!app,
      applied_at: app?.applied_at ?? null,
      checksum_match: app ? app.checksum === m.checksum : null,
    };
  });
}

// ============================================
// LOCK MECHANISM
// ============================================

/**
 * Acquire a migration lock to prevent concurrent migrations.
 * Returns true if lock acquired, false if already locked.
 */
function acquireLock(database: DatabaseType): boolean {
  const existing = database
    .prepare("SELECT value FROM metadata WHERE key = ?")
    .get(LOCK_KEY) as { value: string } | undefined;

  if (existing) {
    const lockData = JSON.parse(existing.value) as {
      lockedAt: number;
      pid: number;
    };
    const elapsed = Date.now() - lockData.lockedAt;
    if (elapsed < LOCK_TIMEOUT_MS) {
      return false; // Still locked
    }
    // Lock expired — allow stealing
    log("warn", "migration_lock_stolen", {
      lockedAt: new Date(lockData.lockedAt).toISOString(),
      elapsedMs: elapsed,
    });
  }

  database
    .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
    .run(LOCK_KEY, JSON.stringify({ lockedAt: Date.now(), pid: process.pid }));
  return true;
}

/**
 * Release the migration lock.
 */
function releaseLock(database: DatabaseType): void {
  database.prepare("DELETE FROM metadata WHERE key = ?").run(LOCK_KEY);
}

// ============================================
// DRY-RUN EXECUTION
// ============================================

/**
 * Execute a migration in dry-run mode — just logs what would happen
 * without actually running any SQL.
 */
function dryRunMigration(
  migration: MigrationFile,
  direction: "up" | "down",
): MigrationResult {
  const sql = direction === "up" ? migration.up : migration.down;
  const lines = sql
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("--"))
    .filter((l) => !l.startsWith("/*"));

  log("info", "dry_run", {
    migration: migration.name,
    direction,
    statements: lines.length,
    sql: sql.slice(0, 500) + (sql.length > 500 ? "..." : ""),
  });

  return {
    id: migration.id,
    direction,
    success: true,
    durationMs: 0,
  };
}

function columnExists(database: DatabaseType, table: string, column: string): boolean {
  const rows = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function shouldSkipNoopAddColumn(
  database: DatabaseType,
  sql: string,
): { skip: boolean; table?: string; column?: string } {
  const match = sql.match(
    /ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)/i,
  );
  if (!match) {
    return { skip: false };
  }

  const [, table, column] = match;
  if (columnExists(database, table, column)) {
    return { skip: true, table, column };
  }

  return { skip: false };
}

// ============================================
// MIGRATION EXECUTION
// ============================================

/**
 * Run a single migration in a transaction.
 */
function applyMigration(
  database: DatabaseType,
  migration: MigrationFile,
  direction: "up" | "down",
): MigrationResult {
  const sql = direction === "up" ? migration.up : migration.down;
  const start = performance.now();

  try {
    database.transaction(() => {
      const noopAddColumn = shouldSkipNoopAddColumn(database, sql);
      if (!noopAddColumn.skip && sql.trim()) {
        database.exec(sql);
      }

      if (noopAddColumn.skip) {
        log("info", "migration_skipped_existing_column", {
          migration: migration.name,
          table: noopAddColumn.table,
          column: noopAddColumn.column,
        });
      }

      // Record the migration in _migrations table
      if (direction === "up") {
        database
          .prepare(
            `INSERT OR REPLACE INTO _migrations (id, applied_at, checksum, duration_ms)
             VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)`,
          )
          .run(
            migration.id,
            migration.checksum,
            Math.round(performance.now() - start),
          );
      } else {
        database
          .prepare("DELETE FROM _migrations WHERE id = ?")
          .run(migration.id);
      }
    })();

    const durationMs = performance.now() - start;
    log("info", "migration_applied", {
      migration: migration.name,
      direction,
      durationMs: Math.round(durationMs),
    });

    return {
      id: migration.id,
      direction,
      success: true,
      durationMs,
    };
  } catch (err) {
    const error = err as Error;
    log("error", "migration_failed", {
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

// ============================================
// MIGRATE UP
// ============================================

/**
 * Run all pending forward migrations.
 * Returns the list of results.
 */
export function migrateUp(
  database: DatabaseType,
  options: MigrationOptions = {},
): MigrationResult[] {
  const results: MigrationResult[] = [];
  const migrations = loadMigrations();
  const applied = getAppliedMigrations(database);
  const appliedIds = new Set(applied.map((a) => a.id));

  if (migrations.length === 0) {
    log("info", "no_migrations_to_apply");
    return results;
  }

  // Determine target — apply up to but not including target
  let targetReached = false;
  const target = options.target;

  if (!acquireLock(database)) {
    const lockData = database
      .prepare("SELECT value FROM metadata WHERE key = ?")
      .get(LOCK_KEY) as { value: string } | undefined;
    const lockInfo = lockData ? JSON.parse(lockData.value) : {};
    log("error", "migration_lock_failed", {
      lockedAt: new Date(lockInfo.lockedAt).toISOString(),
      pid: lockInfo.pid,
    });
    throw new Error(
      `Migration lock held by PID ${lockInfo.pid} since ${new Date(lockInfo.lockedAt).toISOString()}. ` +
        `Wait ${LOCK_TIMEOUT_MS / 1000}s or delete metadata key '${LOCK_KEY}' to force.`,
    );
  }

  try {
    for (const migration of migrations) {
      if (appliedIds.has(migration.id)) {
        // Verify checksum for already-applied migrations
        const existing = applied.find((a) => a.id === migration.id);
        if (existing && existing.checksum !== migration.checksum) {
          log("warn", "migration_checksum_mismatch", {
            migration: migration.name,
            expected: migration.checksum,
            actual: existing.checksum,
          });
        }
        continue;
      }

      if (target && migration.id >= target) {
        targetReached = true;
        break;
      }

      if (options.dryRun) {
        results.push(dryRunMigration(migration, "up"));
      } else {
        const result = applyMigration(database, migration, "up");
        results.push(result);
        if (!result.success) {
          log("error", "migration_chain_stopped", {
            failedAt: migration.name,
          });
          break; // Stop on first failure
        }
      }
    }

    if (target && !targetReached && options.target) {
      log("info", "target_never_reached", { target });
    }
  } finally {
    if (!options.dryRun) {
      releaseLock(database);
    }
  }

  return results;
}

// ============================================
// MIGRATE DOWN
// ============================================

/**
 * Rollback migrations. By default rolls back the last applied migration.
 * If target is specified, rolls back down to (but not including) target.
 * Returns the list of results.
 */
export function migrateDown(
  database: DatabaseType,
  options: MigrationOptions = {},
): MigrationResult[] {
  const results: MigrationResult[] = [];
  const migrations = loadMigrations();
  const applied = getAppliedMigrations(database);
  const appliedIds = new Set(applied.map((a) => a.id));

  // Determine which migrations to roll back
  const toRollback: MigrationFile[] = [];
  const target = options.target;

  for (const migration of migrations.reverse()) {
    if (!appliedIds.has(migration.id)) continue;
    if (target && migration.id <= target) break;
    toRollback.push(migration);
  }

  // Reverse back to forward order for sequential rollback
  toRollback.reverse();

  if (toRollback.length === 0) {
    log("info", "no_migrations_to_rollback");
    return results;
  }

  if (!acquireLock(database)) {
    log("error", "migration_lock_failed_down");
    throw new Error("Could not acquire migration lock for rollback");
  }

  try {
    for (const migration of toRollback) {
      if (!migration.down) {
        log("warn", "rollback_no_down_sql", {
          migration: migration.name,
        });
        results.push({
          id: migration.id,
          direction: "down",
          success: false,
          durationMs: 0,
          error: "No down SQL available",
        });
        continue;
      }

      if (options.dryRun) {
        results.push(dryRunMigration(migration, "down"));
      } else {
        const result = applyMigration(database, migration, "down");
        results.push(result);
        if (!result.success) {
          log("error", "rollback_chain_stopped", {
            failedAt: migration.name,
          });
          break;
        }
      }
    }
  } finally {
    if (!options.dryRun) {
      releaseLock(database);
    }
  }

  return results;
}

// ============================================
// MIGRATE STATUS COMMAND
// ============================================

/**
 * Print migration status as a formatted table to stdout.
 */
export function printMigrationStatus(database: DatabaseType): void {
  const status = getMigrationStatus(database);

  if (status.length === 0) {
    console.info("No migrations found.");
    return;
  }

  console.info("\nMigration Status:");
  console.info("-".repeat(100));
  console.info(
    "  ID    │ Name                                    │ Applied │ Checksum │ Duration ",
  );
  console.info("-".repeat(100));

  for (const m of status) {
    const applied = m.applied ? "✓" : "✗";
    const checksumOk =
      m.checksum_match === null ? "—" : m.checksum_match ? "✓" : "✗";
    const duration = m.applied_at ? `${m.applied_at}` : "—";
    console.info(
      `  ${m.id.padEnd(5)}│ ${m.name.padEnd(39)}│ ${applied.padEnd(7)} │ ${checksumOk.padEnd(8)} │ ${duration}`,
    );
  }
  console.info("-".repeat(100));
  console.info(
    `\n${status.filter((m) => m.applied).length}/${status.length} migrations applied.`,
  );
}

// ============================================
// COMMAND LINE INTERFACE
// ============================================

/**
 * Run migrations from the command line.
 * Usage: node dist/services/migrate.js <command> [options]
 *
 * Commands:
 *   up          Apply pending migrations
 *   down        Rollback last migration
 *   down --all  Rollback all migrations
 *   status      Show migration status
 *   dry-run     Show what would be applied without running
 */
async function cli(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || "status";

  // Initialize a temporary database connection
  const { default: Database } = await import("better-sqlite3");
  const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
  const DB_FILE = path.join(DATA_DIR, "zkvote.db");

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const database = new Database(DB_FILE);
  database.pragma("journal_mode = WAL");

  try {
    switch (command) {
      case "up": {
        const target = args[1] === "--target" ? args[2] : undefined;
        const results = migrateUp(database, { target });
        if (results.length === 0) {
          console.info("Already at latest migration.");
        } else {
          for (const r of results) {
            console.info(
              `  ${r.success ? "✓" : "✗"} ${r.direction} ${r.id}: ${r.durationMs.toFixed(0)}ms${r.error ? ` — ${r.error}` : ""}`,
            );
          }
        }
        break;
      }
      case "down": {
        const allFlag = args.includes("--all") || args.includes("-a");
        const target = allFlag ? "000" : undefined;
        const results = migrateDown(database, { target });
        if (results.length === 0) {
          console.info("Nothing to roll back.");
        } else {
          for (const r of results) {
            console.info(
              `  ${r.success ? "✓" : "✗"} ${r.direction} ${r.id}: ${r.durationMs.toFixed(0)}ms${r.error ? ` — ${r.error}` : ""}`,
            );
          }
        }
        break;
      }
      case "dry-run": {
        console.info("\n=== DRY RUN — No changes will be made ===\n");
        const results = migrateUp(database, { dryRun: true });
        if (results.length === 0) {
          console.info("No pending migrations to apply.");
        }
        break;
      }
      case "status":
      default:
        printMigrationStatus(database);
        break;
    }
  } finally {
    database.close();
  }
}

// Run CLI if executed directly
if (
  process.argv[1] &&
  (process.argv[1].endsWith("migrate.js") ||
    process.argv[1].endsWith("migrate.ts"))
) {
  cli();
}

export { cli as runMigrationCli };
