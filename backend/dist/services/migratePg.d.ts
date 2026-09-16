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
import { type MigrationResult, type MigrationOptions, type AppliedMigration } from "./migrate.js";
import { type SqlFlavor } from "./dbDialect.js";
/** Postgres advisory-lock key. Arbitrary but stable — collisions would only
 *  serialise unrelated advisory locks, never corrupt state. */
export declare const MIGRATION_ADVISORY_LOCK_KEY = 2053833477;
/**
 * Where the migration files for a given SQL flavour live.
 *
 * `migrations/postgres/` is a subdirectory of `migrations/`, and
 * `loadMigrations()` only picks up `*.sql` entries (never directories), so the
 * SQLite runner is unaffected by its presence.
 */
export declare function migrationsDirFor(flavor?: SqlFlavor): string;
/** Minimal async SQL executor — satisfied by `pg.Pool` and by test doubles. */
export interface SqlExecutor {
    query: (text: string, values?: unknown[]) => Promise<{
        rows: Array<Record<string, unknown>>;
    }>;
}
export declare function getAppliedMigrationsPg(exec: SqlExecutor): Promise<AppliedMigration[]>;
export declare function migrateUpPg(exec: SqlExecutor, options?: MigrationOptions & {
    migrationsDir?: string;
}): Promise<MigrationResult[]>;
export declare function migrateDownPg(exec: SqlExecutor, options?: MigrationOptions & {
    migrationsDir?: string;
}): Promise<MigrationResult[]>;
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
export declare function checkMigrationParity(sqliteDir?: string, postgresDir?: string): MigrationParityReport;
//# sourceMappingURL=migratePg.d.ts.map