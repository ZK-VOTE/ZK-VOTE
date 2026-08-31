import { Kysely } from "kysely";
import type { DB } from "../generated/db-types.js";
import { getDb } from "./db.js";
import { createDialect, resolveDbBackend } from "./dbDialect.js";

/**
 * Kysely entry point for the relay.
 *
 * The dialect is chosen by `DB_BACKEND` (issue #305) instead of being hardwired
 * to SQLite. On the default `sqlite` backend this is byte-for-byte the previous
 * behaviour: Kysely reuses the existing better-sqlite3 connection returned by
 * `getDb()` rather than opening its own. On `postgres` it builds a lazily
 * connected `pg` pool, so nothing tries to reach the database at import time.
 */
export const kysely = new Kysely<DB>({
  dialect: createDialect({
    backend: resolveDbBackend(),
    sqliteDatabase: () => getDb(),
  }),
});
