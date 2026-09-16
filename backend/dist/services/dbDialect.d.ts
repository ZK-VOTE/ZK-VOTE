/**
 * Pluggable Database Dialect (issue #305)
 *
 * The relay was built directly on top of `better-sqlite3`: `db.ts` opens a file,
 * `kysely.ts` wraps that same handle in Kysely's `SqliteDialect`, and every
 * migration is SQLite-flavoured DDL. That is fine for a single relay process but
 * blocks the two things #305 is a prerequisite for — materialized views for
 * analytics (#4) and running more than one relay against shared state.
 *
 * This module is the seam. It answers three questions for the rest of the
 * backend, without any caller having to know which engine is underneath:
 *
 *   1. Which backend is configured?          → `resolveDbBackend()`
 *   2. What SQL flavour does it speak?       → `sqlFlavorFor()` + `PORTABILITY`
 *   3. Give me a Kysely dialect for it.      → `createDialect()`
 *
 * `pg` is imported lazily through a non-literal specifier so the SQLite build
 * neither needs the dependency installed nor pays for loading it. Selecting
 * `postgres` without `pg` present fails loudly at boot with an actionable
 * message rather than silently degrading to SQLite.
 */
import type { Dialect } from "kysely";
export type DbBackend = "sqlite" | "postgres" | "spanner";
/** SQL dialects the migration runner and query helpers know how to emit. */
export type SqlFlavor = "sqlite" | "postgres";
/** Backends that are wired end to end today. `spanner` is design-only. */
export declare const SUPPORTED_BACKENDS: readonly DbBackend[];
export declare function resolveDbBackend(): DbBackend;
/**
 * Map a backend onto the SQL flavour its migrations are written in.
 *
 * Spanner's GoogleSQL dialect is close enough to Postgres for the *migration
 * file layout* (it also offers a PostgreSQL-interface mode), so it reuses the
 * `postgres` migration set. Actually connecting to Spanner is out of scope for
 * the spike — see `docs/spikes/305-pluggable-relay-db.md`.
 */
export declare function sqlFlavorFor(backend?: DbBackend): SqlFlavor;
/** True when the process is still on the embedded single-file SQLite path. */
export declare function isSqliteBackend(backend?: DbBackend): boolean;
/**
 * What each backend can do, expressed as data so callers can branch on a
 * capability instead of on an engine name. Adding a third engine then means
 * adding a row here, not hunting for `=== "sqlite"` checks.
 */
export interface BackendCapabilities {
    /** `CREATE MATERIALIZED VIEW` — the analytics blocker in #4. */
    materializedViews: boolean;
    /** More than one writer process against the same data. */
    concurrentWriters: boolean;
    /** Read replicas / horizontal read scale-out. */
    readReplicas: boolean;
    /** DDL participates in transactions (so a failed migration rolls back). */
    transactionalDdl: boolean;
    /** `LISTEN`/`NOTIFY`-style change streams for indexer fan-out. */
    changeNotifications: boolean;
    /** Advisory locks usable for the migration lock instead of a metadata row. */
    advisoryLocks: boolean;
    /** Native JSON column type with server-side operators. */
    nativeJson: boolean;
}
export declare const CAPABILITIES: Record<DbBackend, BackendCapabilities>;
export declare function capabilitiesFor(backend?: DbBackend): BackendCapabilities;
/**
 * The handful of places where SQLite and Postgres genuinely disagree and the
 * relay's own SQL has to care. Keeping them in one table is what makes
 * "migration parity" checkable rather than aspirational.
 */
export interface PortabilityProfile {
    /** Positional placeholder for parameter `n` (1-indexed). */
    placeholder: (n: number) => string;
    /** Auto-incrementing surrogate primary key column definition. */
    autoIncrementPk: string;
    /** Expression producing an ISO-8601 UTC timestamp string. */
    nowIso: string;
    /** Boolean literals as stored on that engine. */
    trueLiteral: string;
    falseLiteral: string;
    /** Upsert clause prefix, e.g. `ON CONFLICT (id) DO UPDATE SET`. */
    onConflict: (columns: string[]) => string;
    /** Quote an identifier (table/column). */
    quoteIdent: (ident: string) => string;
    /** Text/blob column used for opaque JSON payloads. */
    jsonColumn: string;
}
export declare const PORTABILITY: Record<SqlFlavor, PortabilityProfile>;
export declare function portabilityFor(flavor?: SqlFlavor): PortabilityProfile;
/** The slice of `pg.Pool` this module actually uses. */
export interface PgPoolLike {
    connect: () => Promise<unknown>;
    end: () => Promise<void>;
    query: (text: string, values?: unknown[]) => Promise<{
        rows: unknown[];
    }>;
}
interface PgModuleLike {
    Pool: new (options: Record<string, unknown>) => PgPoolLike;
    default?: {
        Pool: new (options: Record<string, unknown>) => PgPoolLike;
    };
}
export interface PgPoolOptions {
    connectionString: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    ssl?: boolean | {
        rejectUnauthorized: boolean;
    };
}
/**
 * Load `pg` at runtime. The specifier is held in a variable so TypeScript does
 * not try to resolve the module at build time — the SQLite deployment does not
 * ship `pg`, and `npm run typecheck` must still pass there.
 */
export declare function loadPgModule(): Promise<PgModuleLike>;
export declare function createPgPool(options: PgPoolOptions): Promise<PgPoolLike>;
export interface DialectOptions {
    backend?: DbBackend;
    /** SQLite only: a thunk returning the live better-sqlite3 handle. */
    sqliteDatabase?: () => unknown;
    /** Postgres only: overrides `config.databaseUrl`. */
    connectionString?: string;
}
/**
 * Build the Kysely dialect for the configured backend.
 *
 * Synchronous by design so `kysely.ts` can keep exporting a ready-to-use
 * instance and no call site has to become async. The Postgres pool is created
 * lazily: `PostgresDialect` accepts a `() => Promise<Pool>` thunk, so `pg` is
 * only imported when the first query actually runs.
 *
 * SQLite keeps its existing behaviour exactly — Kysely borrows the already-open
 * `better-sqlite3` handle rather than opening a second one, so WAL settings,
 * pragmas and the checkpointing in `walResilience.ts` all still apply.
 */
export declare function createDialect(options?: DialectOptions): Dialect;
/**
 * Boot-time guard. Called before the DB is opened so a misconfigured backend
 * surfaces as a startup error rather than as a confusing query failure later.
 */
export declare function assertBackendConfigured(backend?: DbBackend): void;
export {};
//# sourceMappingURL=dbDialect.d.ts.map