/**
 * Pluggable relay DB backend (issue #305)
 *
 * Covers the seam itself — flavour resolution, the capability matrix, the
 * portable SQL fragments, migration parity between the two migration sets, and
 * the dual-write bridge — without needing a live Postgres.
 */

import { expect } from "chai";

import {
  sqlFlavorFor,
  isSqliteBackend,
  capabilitiesFor,
  portabilityFor,
  createDialect,
  SUPPORTED_BACKENDS,
  CAPABILITIES,
  PORTABILITY,
} from "../src/services/dbDialect.js";
import {
  checkMigrationParity,
  migrationsDirFor,
  migrateUpPg,
  migrateDownPg,
  type SqlExecutor,
} from "../src/services/migratePg.js";
import {
  initDualWrite,
  mirrorWrite,
  mirrorBatch,
  verify,
  backfill,
  getDualWriteStats,
  resetDualWriteStats,
  isDualWriteEnabled,
  BRIDGED_TABLES,
} from "../src/services/dualWrite.js";

/** Records every statement so assertions can look at the emitted SQL. */
function fakeExecutor(
  responses: Record<string, Array<Record<string, unknown>>> = {},
): SqlExecutor & { statements: Array<{ sql: string; values?: unknown[] }> } {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  return {
    statements,
    async query(sql: string, values?: unknown[]) {
      statements.push({ sql, values });
      for (const [needle, rows] of Object.entries(responses)) {
        if (sql.includes(needle)) return { rows };
      }
      return { rows: [] };
    },
  };
}

describe("DB backend abstraction (#305)", () => {
  describe("flavour resolution", () => {
    it("maps sqlite to the sqlite flavour", () => {
      expect(sqlFlavorFor("sqlite")).to.equal("sqlite");
      expect(isSqliteBackend("sqlite")).to.equal(true);
    });

    it("maps postgres to the postgres flavour", () => {
      expect(sqlFlavorFor("postgres")).to.equal("postgres");
      expect(isSqliteBackend("postgres")).to.equal(false);
    });

    it("reuses the postgres migration set for spanner", () => {
      // Spanner's GoogleSQL is close enough for the file layout; only the
      // connection is unimplemented.
      expect(sqlFlavorFor("spanner")).to.equal("postgres");
    });

    it("lists only the backends with a working path", () => {
      expect([...SUPPORTED_BACKENDS]).to.deep.equal(["sqlite", "postgres"]);
    });
  });

  describe("capability matrix", () => {
    it("records that sqlite has no materialized views (the #4 blocker)", () => {
      expect(capabilitiesFor("sqlite").materializedViews).to.equal(false);
      expect(capabilitiesFor("postgres").materializedViews).to.equal(true);
    });

    it("records that only postgres supports concurrent writers", () => {
      expect(capabilitiesFor("sqlite").concurrentWriters).to.equal(false);
      expect(capabilitiesFor("postgres").concurrentWriters).to.equal(true);
    });

    it("declares the same keys for every backend", () => {
      const keys = Object.keys(CAPABILITIES.sqlite).sort();
      for (const backend of Object.keys(CAPABILITIES)) {
        expect(
          Object.keys(CAPABILITIES[backend as keyof typeof CAPABILITIES]).sort(),
        ).to.deep.equal(keys);
      }
    });
  });

  describe("portable SQL fragments", () => {
    it("emits the right placeholder style per flavour", () => {
      expect(portabilityFor("sqlite").placeholder(1)).to.equal("?");
      expect(portabilityFor("sqlite").placeholder(3)).to.equal("?");
      expect(portabilityFor("postgres").placeholder(1)).to.equal("$1");
      expect(portabilityFor("postgres").placeholder(3)).to.equal("$3");
    });

    it("emits the right auto-increment PK per flavour", () => {
      expect(portabilityFor("sqlite").autoIncrementPk).to.contain("AUTOINCREMENT");
      expect(portabilityFor("postgres").autoIncrementPk).to.contain("BIGSERIAL");
    });

    it("emits boolean literals the engine actually accepts", () => {
      expect(portabilityFor("sqlite").trueLiteral).to.equal("1");
      expect(portabilityFor("postgres").trueLiteral).to.equal("TRUE");
    });

    it("escapes embedded quotes when quoting identifiers", () => {
      expect(portabilityFor("postgres").quoteIdent('we"ird')).to.equal(
        '"we""ird"',
      );
    });

    it("declares the same profile keys for every flavour", () => {
      expect(Object.keys(PORTABILITY.sqlite).sort()).to.deep.equal(
        Object.keys(PORTABILITY.postgres).sort(),
      );
    });
  });

  describe("dialect factory", () => {
    it("builds a sqlite dialect from a handle thunk", () => {
      const dialect = createDialect({
        backend: "sqlite",
        sqliteDatabase: () => ({}) as never,
      });
      expect(dialect).to.have.property("createDriver");
    });

    it("refuses a sqlite dialect with no handle", () => {
      expect(() => createDialect({ backend: "sqlite" })).to.throw(
        /requires a `sqliteDatabase` thunk/,
      );
    });

    it("refuses postgres without a connection string", () => {
      expect(() =>
        createDialect({ backend: "postgres", connectionString: "" }),
      ).to.throw(/DATABASE_URL/);
    });

    it("fails loudly on spanner rather than falling back to sqlite", () => {
      expect(() => createDialect({ backend: "spanner" })).to.throw(
        /not implemented yet/,
      );
    });
  });

  describe("migration parity", () => {
    it("points each flavour at its own migration directory", () => {
      expect(migrationsDirFor("sqlite")).to.not.contain("postgres");
      expect(migrationsDirFor("postgres")).to.contain("postgres");
    });

    it("has a same-ID, same-name counterpart for every migration", () => {
      const report = checkMigrationParity();
      expect(report.missingInPostgres).to.deep.equal([]);
      expect(report.missingInSqlite).to.deep.equal([]);
      expect(report.nameMismatches).to.deep.equal([]);
    });

    it("ships a rollback on both sides of every migration", () => {
      const report = checkMigrationParity();
      expect(report.missingDown).to.deep.equal([]);
      for (const entry of report.entries) {
        expect(entry.bothHaveDown, `migration ${entry.id}`).to.equal(true);
      }
    });

    it("reports overall parity", () => {
      expect(checkMigrationParity().inParity).to.equal(true);
    });
  });

  describe("postgres migration runner", () => {
    it("takes and releases the advisory lock around a run", async () => {
      const exec = fakeExecutor({ pg_try_advisory_lock: [{ locked: true }] });
      await migrateUpPg(exec);
      const sqls = exec.statements.map((s) => s.sql).join("\n");
      expect(sqls).to.contain("pg_try_advisory_lock");
      expect(sqls).to.contain("pg_advisory_unlock");
    });

    it("refuses to run when the lock is held", async () => {
      const exec = fakeExecutor({ pg_try_advisory_lock: [{ locked: false }] });
      let threw = false;
      try {
        await migrateUpPg(exec);
      } catch (err) {
        threw = true;
        expect((err as Error).message).to.contain("advisory lock");
      }
      expect(threw).to.equal(true);
    });

    it("wraps each migration in a transaction and records it", async () => {
      const exec = fakeExecutor({ pg_try_advisory_lock: [{ locked: true }] });
      const results = await migrateUpPg(exec);
      expect(results.length).to.be.greaterThan(0);
      expect(results.every((r) => r.success)).to.equal(true);
      const sqls = exec.statements.map((s) => s.sql);
      expect(sqls).to.include("BEGIN");
      expect(sqls).to.include("COMMIT");
      expect(sqls.join("\n")).to.contain("INSERT INTO _migrations");
    });

    it("rolls back the transaction when a migration throws", async () => {
      const statements: string[] = [];
      const exec: SqlExecutor = {
        async query(sql: string) {
          statements.push(sql);
          if (sql.includes("pg_try_advisory_lock"))
            return { rows: [{ locked: true }] };
          if (sql.includes("CREATE TABLE IF NOT EXISTS partition_registry")) {
            throw new Error("boom");
          }
          return { rows: [] };
        },
      };
      const results = await migrateUpPg(exec);
      expect(results[0].success).to.equal(false);
      expect(results[0].error).to.contain("boom");
      expect(statements).to.include("ROLLBACK");
    });

    it("does not re-apply a migration already recorded", async () => {
      const exec = fakeExecutor({
        pg_try_advisory_lock: [{ locked: true }],
        "SELECT id, applied_at": [
          { id: "001", applied_at: "x", checksum: "wrong", duration_ms: 1 },
        ],
      });
      const results = await migrateUpPg(exec);
      expect(results.some((r) => r.id === "001")).to.equal(false);
    });

    it("dry-run touches no lock and executes no DDL", async () => {
      const exec = fakeExecutor();
      const results = await migrateUpPg(exec, { dryRun: true });
      expect(results.length).to.be.greaterThan(0);
      const sqls = exec.statements.map((s) => s.sql).join("\n");
      expect(sqls).to.not.contain("pg_try_advisory_lock");
      expect(sqls).to.not.contain("BEGIN");
    });

    it("rolls back only down to the target", async () => {
      const exec = fakeExecutor({
        pg_try_advisory_lock: [{ locked: true }],
        "SELECT id, applied_at": [
          { id: "001", applied_at: "x", checksum: null, duration_ms: 1 },
          { id: "002", applied_at: "x", checksum: null, duration_ms: 1 },
          { id: "003", applied_at: "x", checksum: null, duration_ms: 1 },
        ],
      });
      const results = await migrateDownPg(exec, { target: "001" });
      expect(results.map((r) => r.id)).to.deep.equal(["002", "003"]);
    });
  });

  describe("dual-write bridge", () => {
    afterEach(() => {
      initDualWrite(null);
      resetDualWriteStats();
    });

    it("is off and no-ops until an executor is attached", async () => {
      initDualWrite(null);
      expect(isDualWriteEnabled()).to.equal(false);
      expect(await mirrorWrite("INSERT INTO events DEFAULT VALUES")).to.equal(
        false,
      );
      expect(getDualWriteStats().skipped).to.equal(1);
    });

    it("mirrors a write to the shadow backend", async () => {
      const exec = fakeExecutor();
      initDualWrite(exec);
      const ok = await mirrorWrite("INSERT INTO daos (id) VALUES ($1)", [7]);
      expect(ok).to.equal(true);
      expect(exec.statements[0].values).to.deep.equal([7]);
      expect(getDualWriteStats().mirrored).to.equal(1);
    });

    it("counts a shadow failure without raising (non-strict)", async () => {
      initDualWrite({
        async query() {
          throw new Error("shadow down");
        },
      });
      const ok = await mirrorWrite("INSERT INTO daos DEFAULT VALUES");
      expect(ok).to.equal(false);
      const s = getDualWriteStats();
      expect(s.failed).to.equal(1);
      expect(s.lastError).to.contain("shadow down");
    });

    it("wraps a batch in a shadow transaction", async () => {
      const exec = fakeExecutor();
      initDualWrite(exec);
      await mirrorBatch([
        { sql: "INSERT INTO daos (id) VALUES ($1)", params: [1] },
        { sql: "INSERT INTO partition_registry (dao_id) VALUES ($1)", params: [1] },
      ]);
      const sqls = exec.statements.map((s) => s.sql);
      expect(sqls[0]).to.equal("BEGIN");
      expect(sqls[sqls.length - 1]).to.equal("COMMIT");
    });

    it("rolls the shadow batch back when one statement fails", async () => {
      const statements: string[] = [];
      initDualWrite({
        async query(sql: string) {
          statements.push(sql);
          if (sql.includes("partition_registry")) throw new Error("nope");
          return { rows: [] };
        },
      });
      await mirrorBatch([
        { sql: "INSERT INTO daos (id) VALUES ($1)", params: [1] },
        { sql: "INSERT INTO partition_registry (dao_id) VALUES ($1)", params: [1] },
      ]);
      expect(statements).to.include("ROLLBACK");
    });

    it("reports a row-count divergence between primary and shadow", async () => {
      initDualWrite(fakeExecutor({ "COUNT(*)": [{ count: 4 }] }));
      const divergences = await verify(["events"], () => 7);
      expect(divergences).to.deep.equal([
        { table: "events", primaryCount: 7, shadowCount: 4, delta: 3 },
      ]);
    });

    it("reports nothing when the backends agree", async () => {
      initDualWrite(fakeExecutor({ "COUNT(*)": [{ count: 7 }] }));
      expect(await verify(["events"], () => 7)).to.deep.equal([]);
    });

    it("backfills missing rows idempotently", async () => {
      const exec = fakeExecutor();
      initDualWrite(exec);
      const inserted = await backfill(
        "daos",
        [{ id: 1, name: "a" }, { id: 2, name: "b" }],
        ["id"],
      );
      expect(inserted).to.equal(2);
      expect(exec.statements[0].sql).to.contain("ON CONFLICT");
      expect(exec.statements[0].sql).to.contain("DO NOTHING");
    });

    it("refuses to interpolate an unsafe table name", async () => {
      initDualWrite(fakeExecutor());
      let threw = false;
      try {
        await verify(['events"; DROP TABLE daos; --'], () => 0);
      } catch (err) {
        threw = true;
        expect((err as Error).message).to.contain("unsafe identifier");
      }
      expect(threw).to.equal(true);
    });

    it("bridges every table the relay writes to", () => {
      expect([...BRIDGED_TABLES]).to.include.members([
        "daos",
        "events",
        "metadata",
        "vote_receipts",
      ]);
    });
  });
});
