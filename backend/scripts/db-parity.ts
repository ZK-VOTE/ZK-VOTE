/**
 * db:parity — report row-count divergence between the authoritative SQLite
 * store and the dual-write shadow (Postgres).
 *
 * Exits non-zero when any table diverges, so it can be scheduled as the
 * cutover gate. With dual-write disabled it is a deliberate no-op: there is no
 * shadow to compare and the primary store is untouched.
 *
 *   npm run db:parity
 */
import { config } from "../src/config.js";
import { createPgPool } from "../src/services/dbDialect.js";
import { getWriteDb } from "../src/services/db.js";
import {
  BRIDGED_TABLES,
  initDualWrite,
  isDualWriteEnabled,
  verify,
} from "../src/services/dualWrite.js";
import type { SqlExecutor } from "../src/services/migratePg.js";

function safeIdent(ident: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
    throw new Error(`Refusing unsafe identifier: ${ident}`);
  }
  return `"${ident}"`;
}

function primaryTables(): string[] {
  const db = getWriteDb();
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'events_%' OR name IN (" +
        BRIDGED_TABLES.map(() => "?").join(", ") +
        ")) ORDER BY name",
    )
    .all(...BRIDGED_TABLES) as Array<{ name: string }>;
  return rows.map((r) => r.name).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

async function main(): Promise<void> {
  if (!config.dbDualWrite || !config.dbDualWriteUrl) {
    console.log("db:parity — dual-write is disabled; primary store is authoritative and untouched.");
    return;
  }
  const pool = await createPgPool({ connectionString: config.dbDualWriteUrl });
  initDualWrite(pool as unknown as SqlExecutor);
  if (!isDualWriteEnabled()) {
    console.error("db:parity — could not attach the shadow executor");
    process.exitCode = 1;
    return;
  }

  const tables = primaryTables();
  const divergences = await verify(tables, (table) => {
    const row = getWriteDb()
      .prepare(`SELECT COUNT(*) AS n FROM ${safeIdent(table)}`)
      .get() as { n: number };
    return Number(row.n);
  });

  if (divergences.length === 0) {
    console.log(`db:parity — OK: ${tables.length} tables, zero divergence.`);
    return;
  }
  for (const d of divergences) {
    console.error(
      `::error::db:parity ${d.table}: primary=${d.primaryCount} shadow=${d.shadowCount} delta=${d.delta}`,
    );
  }
  console.error(`db:parity — FAILED: ${divergences.length} divergent table(s). Run a backfill before cutover.`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`db:parity — FAILED: ${(err as Error).message}`);
  process.exitCode = 1;
});
