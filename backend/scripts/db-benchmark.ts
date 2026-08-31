/**
 * Relay DB Backend Benchmark (issue #305)
 *
 * Measures the workload the relay actually runs — indexer event ingest, the
 * per-DAO event scans the frontend polls, nullifier lookups, and the analytics
 * aggregate that #4 wants to serve from a materialized view — against whichever
 * backend `DB_BACKEND` selects.
 *
 * Usage:
 *   DB_BACKEND=sqlite   tsx scripts/db-benchmark.ts
 *   DB_BACKEND=postgres DATABASE_URL=postgres://... tsx scripts/db-benchmark.ts
 *   tsx scripts/db-benchmark.ts --rows 50000 --json results.json
 *
 * The point is a like-for-like comparison, so both backends run the identical
 * statement sequence through Kysely rather than through backend-specific
 * fast paths.
 */

import fs from "fs";
import { sql } from "kysely";

import { kysely } from "../src/services/kysely.js";
import { initDb } from "../src/services/db.js";
import {
  resolveDbBackend,
  capabilitiesFor,
  sqlFlavorFor,
} from "../src/services/dbDialect.js";

interface BenchResult {
  name: string;
  operations: number;
  totalMs: number;
  opsPerSec: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

interface BenchReport {
  backend: string;
  flavor: string;
  rows: number;
  capabilities: Record<string, boolean>;
  results: BenchResult[];
  generatedAt: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function measure(
  name: string,
  operations: number,
  fn: (i: number) => Promise<void> | void,
): Promise<BenchResult> {
  const samples: number[] = [];
  const start = performance.now();
  for (let i = 0; i < operations; i++) {
    const t0 = performance.now();
    await fn(i);
    samples.push(performance.now() - t0);
  }
  const totalMs = performance.now() - start;
  samples.sort((a, b) => a - b);
  return {
    name,
    operations,
    totalMs,
    opsPerSec: operations / (totalMs / 1000),
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    p99Ms: percentile(samples, 99),
  };
}

function parseArgs(): { rows: number; json: string | null } {
  const args = process.argv.slice(2);
  const rowsIdx = args.indexOf("--rows");
  const jsonIdx = args.indexOf("--json");
  return {
    rows: rowsIdx >= 0 ? Number(args[rowsIdx + 1]) : 10_000,
    json: jsonIdx >= 0 ? args[jsonIdx + 1] : null,
  };
}

const BENCH_DAO_ID = 999_000;

async function main(): Promise<void> {
  const { rows, json } = parseArgs();
  const backend = resolveDbBackend();
  const flavor = sqlFlavorFor(backend);

  if (backend === "sqlite") {
    initDb();
  }

  console.info(`\nRelay DB benchmark — backend=${backend} flavor=${flavor} rows=${rows}\n`);

  // Seed a DAO the benchmark rows can reference (events.dao_id is a FK).
  await kysely
    .insertInto("daos")
    .values({
      id: BENCH_DAO_ID,
      name: "benchmark",
      creator: "GBENCHMARK",
      membership_open: 1 as never,
      members_can_propose: 0 as never,
      metadata_cid: null,
      member_count: 0,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();

  const results: BenchResult[] = [];

  // 1. Indexer ingest — the write path that has to keep up with the ledger.
  results.push(
    await measure("event_insert", rows, async (i) => {
      await kysely
        .insertInto("events")
        .values({
          dao_id: BENCH_DAO_ID,
          type: "vote_cast",
          data: JSON.stringify({ nullifier: `n${i}`, choice: i % 2 === 0 }),
          ledger: i,
          tx_hash: `bench-${i}`,
          timestamp: new Date().toISOString(),
          verified: 1 as never,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }),
  );

  // 2. The frontend's proposal-feed query.
  const reads = Math.min(rows, 2_000);
  results.push(
    await measure("event_page_scan", reads, async (i) => {
      await kysely
        .selectFrom("events")
        .selectAll()
        .where("dao_id", "=", BENCH_DAO_ID)
        .orderBy("ledger", "desc")
        .limit(50)
        .offset((i % 20) * 50)
        .execute();
    }),
  );

  // 3. Point lookup — the hot path behind GET /nullifier/:dao/:proposal/:n.
  results.push(
    await measure("event_point_lookup", reads, async (i) => {
      await kysely
        .selectFrom("events")
        .selectAll()
        .where("tx_hash", "=", `bench-${i % rows}`)
        .executeTakeFirst();
    }),
  );

  // 4. The analytics aggregate #4 needs. On SQLite this is a full scan every
  //    time; on Postgres it is the query a materialized view would cache.
  results.push(
    await measure("analytics_aggregate", 50, async () => {
      await kysely
        .selectFrom("events")
        .select([
          "type",
          (eb) => eb.fn.count<number>("id").as("count"),
        ])
        .where("dao_id", "=", BENCH_DAO_ID)
        .groupBy("type")
        .execute();
    }),
  );

  // 5. Concurrent writers — the multi-relay scenario. SQLite serialises these
  //    behind its single writer lock; Postgres does not.
  const concurrency = 16;
  results.push(
    await measure("concurrent_write_batch", 50, async (batch) => {
      await Promise.all(
        Array.from({ length: concurrency }, (_, k) =>
          kysely
            .insertInto("events")
            .values({
              dao_id: BENCH_DAO_ID,
              type: "member_added",
              data: null,
              ledger: rows + batch * concurrency + k,
              tx_hash: `bench-conc-${batch}-${k}`,
              timestamp: new Date().toISOString(),
              verified: 0 as never,
            })
            .onConflict((oc) => oc.doNothing())
            .execute(),
        ),
      );
    }),
  );

  const report: BenchReport = {
    backend,
    flavor,
    rows,
    capabilities: capabilitiesFor(backend) as unknown as Record<string, boolean>,
    results,
    generatedAt: new Date().toISOString(),
  };

  console.info(
    "  " +
      "operation".padEnd(24) +
      "ops".padStart(8) +
      "ops/s".padStart(12) +
      "p50".padStart(10) +
      "p95".padStart(10) +
      "p99".padStart(10),
  );
  console.info("  " + "-".repeat(74));
  for (const r of results) {
    console.info(
      "  " +
        r.name.padEnd(24) +
        String(r.operations).padStart(8) +
        r.opsPerSec.toFixed(0).padStart(12) +
        r.p50Ms.toFixed(3).padStart(10) +
        r.p95Ms.toFixed(3).padStart(10) +
        r.p99Ms.toFixed(3).padStart(10),
    );
  }
  console.info("");

  if (json) {
    fs.writeFileSync(json, JSON.stringify(report, null, 2));
    console.info(`Wrote ${json}`);
  }

  // Clean up the benchmark partition so repeated runs stay comparable.
  await sql`DELETE FROM events WHERE dao_id = ${BENCH_DAO_ID}`.execute(kysely);
  await sql`DELETE FROM daos WHERE id = ${BENCH_DAO_ID}`.execute(kysely);
  await kysely.destroy();
}

main().catch((err) => {
  console.error("benchmark failed:", err);
  process.exitCode = 1;
});
