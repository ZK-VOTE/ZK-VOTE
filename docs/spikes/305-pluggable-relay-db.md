# Spike #305 — Replace the SQLite relay DB with a pluggable Postgres/Spanner backend

**Status:** spike complete, Postgres path working, Spanner deferred
**Issue:** #305 · **Blocks:** #4 (analytics/materialized views), multi-relay deployment

---

## 1. Why this is blocking

The relay's storage layer is not merely *implemented* on SQLite, it is *shaped*
by it:

| Coupling point | Where | Consequence |
| --- | --- | --- |
| `better-sqlite3` handle is the connection | `services/db.ts` | Every query is synchronous; no pool, no replica. |
| Kysely borrows that handle directly | `services/kysely.ts` | The dialect was a hardcoded `SqliteDialect`. |
| Migrations are SQLite DDL | `src/migrations/*.sql` | `AUTOINCREMENT`, `strftime`, integer booleans. |
| Migration runner is synchronous | `services/migrate.ts` | Cannot drive an async driver. |
| Per-DAO table partitioning | `services/db.ts` | Works around the absence of real partitioning. |
| Single-writer lock | SQLite itself | Two relay processes cannot share a database. |

Two roadmap items sit behind this:

- **#4 analytics** wants materialized views. SQLite has none — every dashboard
  query is a full scan of `events`, which is exactly what the benchmark below
  measures.
- **Multi-relay** wants more than one process writing. SQLite's single-writer
  lock makes that impossible regardless of how the code is written.

## 2. What was built

A dialect seam, not a rewrite. The SQLite path is unchanged at runtime — same
handle, same pragmas, same WAL resilience — and Postgres is a second, complete
path behind the same interfaces.

```
config.ts  DB_BACKEND=sqlite|postgres|spanner, DATABASE_URL, pool + dual-write knobs
    │
    ├─ services/dbDialect.ts   backend → SQL flavour, capability matrix,
    │                          portable SQL fragments, Kysely dialect factory
    │
    ├─ services/kysely.ts      dialect comes from the factory, not a constant
    │
    ├─ services/migrate.ts     SQLite runner (unchanged) + CLI dispatch + `parity`
    ├─ services/migratePg.ts   async Postgres runner, advisory lock, parity check
    ├─ src/migrations/postgres/  the parity migration set
    │
    ├─ services/dualWrite.ts   shadow-write bridge, verification, backfill
    └─ scripts/db-benchmark.ts identical workload against either backend
```

### 2.1 Dialect abstraction

`createDialect()` is synchronous so no existing call site had to become async.
The Postgres pool is created lazily via `PostgresDialect`'s `() => Promise<Pool>`
form, and `pg` is imported through a non-literal specifier — so a SQLite
deployment neither installs nor loads it, and `tsc --noEmit` passes without it.

`CAPABILITIES` is a table rather than a set of `=== "sqlite"` checks, so a
feature that needs materialized views asks for `capabilitiesFor().materializedViews`
and adding a third engine is one row.

### 2.2 Migration runner for both

`loadMigrations()` (file discovery, ID parsing, checksums) is shared. What
differs:

| | SQLite | Postgres |
| --- | --- | --- |
| Directory | `src/migrations/` | `src/migrations/postgres/` |
| Execution | synchronous `better-sqlite3` | async `SqlExecutor` |
| Atomicity | `database.transaction()` | `BEGIN`/`COMMIT`, transactional DDL |
| Lock | `metadata` row + 60s timeout, stealable | `pg_try_advisory_lock`, auto-released on disconnect |

`npm run migrate:*` dispatches on `DB_BACKEND`. `tsx src/services/migrate.ts parity`
reports drift between the two sets and exits non-zero, so parity is a CI check
rather than a promise.

**Parity rule:** for every migration ID, both flavours define a same-named
migration and both ship a `down`. The SQL bodies necessarily differ; the
structure must not.

Translation decisions, all mechanical:

| SQLite | Postgres | Note |
| --- | --- | --- |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGSERIAL PRIMARY KEY` | |
| `INTEGER ... CHECK(x IN (0,1))` | `BOOLEAN` | Kysely surfaces both as JS booleans. |
| `strftime('%Y-%m-%dT%H:%M:%fZ','now')` | `to_char(now() AT TIME ZONE 'UTC', ...)` | Byte-identical ISO-8601 output; columns stay `TEXT` so row shapes match. |
| recreate-table to add a constraint | `ALTER TABLE ... ADD CONSTRAINT` | Same end state; SQLite simply cannot `ALTER`. |

### 2.3 Dual-write bridge

Cutover is a rehearsal, not a leap:

1. `off` — SQLite only (default, zero cost).
2. `shadow` — SQLite primary, writes mirrored to Postgres. Failures are counted
   and logged, not raised, unless `DB_DUAL_WRITE_STRICT=true` (what you set for
   the final rehearsal). Reads still come from SQLite.
3. `primary-swap` — `DB_BACKEND=postgres` with the bridge pointed back at
   SQLite, keeping the old store warm for rollback.

The seam is at the *statement* level, because the relay writes through both raw
`better-sqlite3` prepares and Kysely, and only a statement-level seam catches
both. `verify()` compares row counts per table on a schedule; `backfill()`
reconciles with `ON CONFLICT DO NOTHING`, so it is re-runnable and safe
alongside live mirroring.

### 2.4 Benchmark

`scripts/db-benchmark.ts` runs the same five workloads through Kysely on either
backend and reports ops/s plus p50/p95/p99:

| Workload | What it stands for |
| --- | --- |
| `event_insert` | indexer ingest, the write path that must keep up with the ledger |
| `event_page_scan` | the proposal feed the frontend polls |
| `event_point_lookup` | `GET /nullifier/:dao/:proposal/:n` |
| `analytics_aggregate` | the #4 dashboard query — full scan on SQLite, a materialized view on Postgres |
| `concurrent_write_batch` | 16 concurrent writers — the multi-relay scenario |

Run it as:

```bash
DB_BACKEND=sqlite tsx scripts/db-benchmark.ts --rows 50000 --json sqlite.json
DB_BACKEND=postgres DATABASE_URL=postgres://… tsx scripts/db-benchmark.ts --rows 50000 --json pg.json
```

**Expected shape of the result** (to be filled in from a run on the target
hardware — the harness is what this spike delivers, not a number measured on a
laptop):

- `event_insert`: SQLite wins on a single writer. It is an in-process write with
  no network hop; Postgres pays a round trip per statement. This is the one
  place the migration *costs* something, and batching ingest recovers it.
- `event_point_lookup`: comparable; both are index lookups, Postgres pays the
  round trip.
- `analytics_aggregate`: SQLite is O(rows) every call. Postgres is too *until*
  the query is backed by a materialized view, at which point it is O(1). That
  gap is the entire justification for #4.
- `concurrent_write_batch`: SQLite serialises on its writer lock, so throughput
  is flat in the concurrency; Postgres scales with it. This is the multi-relay
  justification.

## 3. Spanner assessment — deferred, not rejected

Spanner is recognised by config and modelled in the capability matrix, and
selecting it fails fast with a clear message rather than silently degrading.
It is not wired, for reasons that are structural rather than effort-based:

| Concern | Detail |
| --- | --- |
| No materialized views | Which is the main thing #305 is meant to unblock. The Spanner equivalent is a change stream feeding a rollup table — a different design, not a dialect swap. |
| Non-transactional DDL | Schema updates are asynchronous, so the "migration in a transaction" invariant both current runners rely on does not hold. |
| No Kysely dialect | Would need writing and maintaining. |
| Cost floor | A regional instance is far above what a relay at current scale justifies. |

**Recommendation:** ship Postgres. Revisit Spanner only if a deployment needs
multi-region writes, at which point the change-stream rollup design should be
its own spike.

## 4. Cutover and rollback

**Forward:**

1. Provision Postgres; `DB_BACKEND=postgres DATABASE_URL=… npm run migrate:up`.
2. Verify parity: `tsx src/services/migrate.ts parity` (exits non-zero on drift).
3. `DB_DUAL_WRITE=true DB_DUAL_WRITE_URL=…` with SQLite still primary. Run for
   at least one full indexer catch-up cycle.
4. `backfill()` the historical rows, then `verify()` until deltas are zero.
5. Flip `DB_DUAL_WRITE_STRICT=true`. Any mirror failure now fails the request —
   run until it is quiet.
6. Flip `DB_BACKEND=postgres`, leaving the bridge on (`primary-swap`).

**Rollback** — available at every step, which is the point of the ordering:

- Before step 6: set `DB_DUAL_WRITE=false`. Postgres is discarded; SQLite never
  stopped being authoritative.
- After step 6: set `DB_BACKEND=sqlite`. The bridge kept SQLite current, so the
  rollback costs a restart, not a restore.
- If the bridge itself is the problem: `DB_DUAL_WRITE=false` disables mirroring
  without touching the primary.

`migrate:down --all` on Postgres drops the schema cleanly, since every migration
in the parity set ships a working `down`.

## 5. Acceptance criteria

| Criterion | Where |
| --- | --- |
| Spike | this document |
| Working Postgres path | `dbDialect.ts`, `kysely.ts`, `migratePg.ts`, `migrations/postgres/` |
| Migration parity | `checkMigrationParity()` + the `parity` CLI command + `test/db-backend.test.ts` |
| Benchmark | `scripts/db-benchmark.ts` |
| Rollback | §4 above; `migrate:down`, dual-write bridge, `DB_BACKEND` flip |

## 6. Follow-up work this unblocks

- **#4:** materialized views for the analytics dashboard, refreshed on the
  indexer's ledger cursor.
- **Multi-relay:** with concurrent writers available, the per-DAO partition
  tables in `db.ts` can collapse into one declaratively partitioned `events`
  table.
- **Read replicas:** `db-replica.test.js` already anticipates a replica; a
  Postgres pool makes it real.
