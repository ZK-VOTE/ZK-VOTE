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
import { SqliteDialect, PostgresDialect } from "kysely";

import { config } from "../config.js";
import { createLogger } from "./logger.js";

const dialectLogger = createLogger("db-dialect");

// ============================================
// BACKEND / FLAVOR
// ============================================

export type DbBackend = "sqlite" | "postgres" | "spanner";

/** SQL dialects the migration runner and query helpers know how to emit. */
export type SqlFlavor = "sqlite" | "postgres";

/** Backends that are wired end to end today. `spanner` is design-only. */
export const SUPPORTED_BACKENDS: readonly DbBackend[] = ["sqlite", "postgres"];

export function resolveDbBackend(): DbBackend {
  return config.dbBackend as DbBackend;
}

/**
 * Map a backend onto the SQL flavour its migrations are written in.
 *
 * Spanner's GoogleSQL dialect is close enough to Postgres for the *migration
 * file layout* (it also offers a PostgreSQL-interface mode), so it reuses the
 * `postgres` migration set. Actually connecting to Spanner is out of scope for
 * the spike — see `docs/spikes/305-pluggable-relay-db.md`.
 */
export function sqlFlavorFor(backend: DbBackend = resolveDbBackend()): SqlFlavor {
  return backend === "sqlite" ? "sqlite" : "postgres";
}

/** True when the process is still on the embedded single-file SQLite path. */
export function isSqliteBackend(backend: DbBackend = resolveDbBackend()): boolean {
  return backend === "sqlite";
}

// ============================================
// CAPABILITY MATRIX
// ============================================

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

export const CAPABILITIES: Record<DbBackend, BackendCapabilities> = {
  sqlite: {
    materializedViews: false,
    concurrentWriters: false,
    readReplicas: false,
    transactionalDdl: true,
    changeNotifications: false,
    advisoryLocks: false,
    nativeJson: false,
  },
  postgres: {
    materializedViews: true,
    concurrentWriters: true,
    readReplicas: true,
    transactionalDdl: true,
    changeNotifications: true,
    advisoryLocks: true,
    nativeJson: true,
  },
  spanner: {
    materializedViews: false, // Spanner has no MATERIALIZED VIEW; use change streams + a rollup table.
    concurrentWriters: true,
    readReplicas: true,
    transactionalDdl: false, // Schema updates are async, outside a transaction.
    changeNotifications: true, // Change streams.
    advisoryLocks: false,
    nativeJson: true,
  },
};

export function capabilitiesFor(
  backend: DbBackend = resolveDbBackend(),
): BackendCapabilities {
  return CAPABILITIES[backend];
}

// ============================================
// PORTABLE SQL FRAGMENTS
// ============================================

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

export const PORTABILITY: Record<SqlFlavor, PortabilityProfile> = {
  sqlite: {
    placeholder: () => "?",
    autoIncrementPk: "INTEGER PRIMARY KEY AUTOINCREMENT",
    nowIso: "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    trueLiteral: "1",
    falseLiteral: "0",
    onConflict: (columns) =>
      `ON CONFLICT(${columns.join(", ")}) DO UPDATE SET`,
    quoteIdent: (ident) => `"${ident.replace(/"/g, '""')}"`,
    jsonColumn: "TEXT",
  },
  postgres: {
    placeholder: (n) => `$${n}`,
    autoIncrementPk: "BIGSERIAL PRIMARY KEY",
    nowIso: "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
    trueLiteral: "TRUE",
    falseLiteral: "FALSE",
    onConflict: (columns) =>
      `ON CONFLICT (${columns.join(", ")}) DO UPDATE SET`,
    quoteIdent: (ident) => `"${ident.replace(/"/g, '""')}"`,
    jsonColumn: "JSONB",
  },
};

export function portabilityFor(
  flavor: SqlFlavor = sqlFlavorFor(),
): PortabilityProfile {
  return PORTABILITY[flavor];
}

// ============================================
// POSTGRES POOL (LAZY)
// ============================================

/** The slice of `pg.Pool` this module actually uses. */
export interface PgPoolLike {
  connect: () => Promise<unknown>;
  end: () => Promise<void>;
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
}

interface PgModuleLike {
  Pool: new (options: Record<string, unknown>) => PgPoolLike;
  default?: { Pool: new (options: Record<string, unknown>) => PgPoolLike };
}

export interface PgPoolOptions {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

/**
 * Load `pg` at runtime. The specifier is held in a variable so TypeScript does
 * not try to resolve the module at build time — the SQLite deployment does not
 * ship `pg`, and `npm run typecheck` must still pass there.
 */
export async function loadPgModule(): Promise<PgModuleLike> {
  const specifier = "pg";
  try {
    const mod = (await import(specifier)) as unknown as PgModuleLike;
    return mod.Pool ? mod : (mod.default as PgModuleLike);
  } catch (err) {
    throw new Error(
      `DB_BACKEND=postgres requires the 'pg' package. Install it with ` +
        `\`npm install pg\` in backend/ (see docs/spikes/305-pluggable-relay-db.md). ` +
        `Original error: ${(err as Error).message}`,
    );
  }
}

export async function createPgPool(
  options: PgPoolOptions,
): Promise<PgPoolLike> {
  const pg = await loadPgModule();
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? config.dbPoolMax,
    idleTimeoutMillis: options.idleTimeoutMillis ?? config.dbPoolIdleTimeoutMs,
    connectionTimeoutMillis:
      options.connectionTimeoutMillis ?? config.dbConnectTimeoutMs,
    ...(options.ssl ? { ssl: options.ssl } : {}),
  });
}

// ============================================
// DIALECT FACTORY
// ============================================

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
export function createDialect(options: DialectOptions = {}): Dialect {
  const backend = options.backend ?? resolveDbBackend();

  if (backend === "spanner") {
    throw new Error(
      "DB_BACKEND=spanner is not implemented yet — the #305 spike evaluated it " +
        "but only sqlite and postgres have a working path. " +
        "See docs/spikes/305-pluggable-relay-db.md.",
    );
  }

  if (backend === "postgres") {
    const connectionString = options.connectionString ?? config.databaseUrl;
    if (!connectionString) {
      throw new Error("DB_BACKEND=postgres requires DATABASE_URL to be set.");
    }
    dialectLogger.info("dialect_created", {
      backend,
      poolMax: config.dbPoolMax,
      ssl: config.dbSsl,
    });
    return new PostgresDialect({
      pool: (async () =>
        createPgPool({
          connectionString,
          ssl: config.dbSsl ? { rejectUnauthorized: true } : false,
        })) as never,
    });
  }

  if (!options.sqliteDatabase) {
    throw new Error(
      "createDialect: the sqlite backend requires a `sqliteDatabase` thunk.",
    );
  }
  dialectLogger.debug("dialect_created", { backend });
  return new SqliteDialect({
    database: options.sqliteDatabase as never,
  });
}

/**
 * Boot-time guard. Called before the DB is opened so a misconfigured backend
 * surfaces as a startup error rather than as a confusing query failure later.
 */
export function assertBackendConfigured(
  backend: DbBackend = resolveDbBackend(),
): void {
  if (!SUPPORTED_BACKENDS.includes(backend)) {
    throw new Error(
      `DB_BACKEND=${backend} is recognised but not implemented. ` +
        `Supported: ${SUPPORTED_BACKENDS.join(", ")}.`,
    );
  }
  if (backend === "postgres" && !config.databaseUrl) {
    throw new Error("DB_BACKEND=postgres requires DATABASE_URL to be set.");
  }
  if (config.dbDualWrite && !config.dbDualWriteUrl) {
    throw new Error("DB_DUAL_WRITE=true requires DB_DUAL_WRITE_URL to be set.");
  }
}
