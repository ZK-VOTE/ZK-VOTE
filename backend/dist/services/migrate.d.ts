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
import { type Database as DatabaseType } from "better-sqlite3";
export interface MigrationFile {
    id: string;
    name: string;
    up: string;
    down: string;
    checksum: string;
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
    target?: string;
}
/**
 * Load all migration files from the migrations directory.
 * Returns migrations sorted by ID ascending.
 */
export declare function loadMigrations(migrationsDir?: string): MigrationFile[];
/**
 * Get all applied migrations, sorted by ID ascending.
 */
export declare function getAppliedMigrations(database: DatabaseType): AppliedMigration[];
/**
 * Get migration status — list all migrations with their applied state.
 */
export declare function getMigrationStatus(database: DatabaseType, migrationsDir?: string): Array<MigrationFile & {
    applied: boolean;
    applied_at: string | null;
    checksum_match: boolean | null;
}>;
/**
 * Run all pending forward migrations.
 * Returns the list of results.
 */
export declare function migrateUp(database: DatabaseType, options?: MigrationOptions): MigrationResult[];
/**
 * Rollback migrations. By default rolls back the last applied migration.
 * If target is specified, rolls back down to (but not including) target.
 * Returns the list of results.
 */
export declare function migrateDown(database: DatabaseType, options?: MigrationOptions): MigrationResult[];
/**
 * Print migration status as a formatted table to stdout.
 */
export declare function printMigrationStatus(database: DatabaseType): void;
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
declare function cli(): Promise<void>;
export { cli as runMigrationCli };
//# sourceMappingURL=migrate.d.ts.map