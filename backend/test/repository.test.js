/**
 * Repository-layer tests. These use a fake Kysely query builder so they do not
 * require a database (or node_modules) to prove that every write is compiled
 * with bound parameters and mirrored through one seam.
 *
 * Run with: node --experimental-strip-types --test backend/test/repository.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  configureRepository,
  getRepository,
  isRepositoryCutoverEnabled,
} from "../src/services/repository.ts";

function fakeBuilder() {
  const makeQuery = (sql, parameters) => ({
    values(values) {
      parameters.push(...Object.values(values));
      return this;
    },
    onConflict() {
      return this;
    },
    set(values) {
      parameters.push(...Object.values(values));
      return this;
    },
    where(col, op, value) {
      parameters.push(value);
      return this;
    },
    compile() {
      return { sql, parameters: [...parameters] };
    },
  });
  return {
    insertInto(table) {
      return makeQuery(`insert into ${table}`, []);
    },
    updateTable(table) {
      return makeQuery(`update ${table}`, []);
    },
  };
}

function setup({ strict = false, mirrorResult = true } = {}) {
  const executed = [];
  const mirrored = [];
  configureRepository({
    db: fakeBuilder(),
    executor: {
      run(sql, params) {
        executed.push({ sql, params: [...params] });
        return { changes: 1 };
      },
      transaction(fn) {
        return fn();
      },
    },
    mirror(sql, params) {
      mirrored.push({ sql, params: [...params] });
      return mirrorResult;
    },
    strict,
    cutover: "repository",
  });
  return { repo: getRepository(), executed, mirrored };
}

test("cutover flag is read from repository configuration", () => {
  setup();
  assert.equal(isRepositoryCutoverEnabled(), true);
});

test("vote receipt writes use the query builder with bound parameters", () => {
  const { repo, executed, mirrored } = setup();
  repo.storeVoteReceipt("nullifier-1", "tx-1", 7, 42, "confirmed", 1234);

  assert.equal(executed.length, 2);
  assert.match(executed[0].sql, /insert into daos/);
  assert.match(executed[1].sql, /insert into vote_receipts/);
  assert.ok(executed[1].params.includes("nullifier-1"));
  assert.ok(executed[1].params.includes("tx-1"));
  // No value is interpolated into SQL text.
  assert.equal(executed[1].sql.includes("nullifier-1"), false);
  assert.deepEqual(mirrored.map((m) => m.sql), executed.map((e) => e.sql));
});

test("vote submission insert returns whether a row was inserted", () => {
  const { repo, executed } = setup();
  assert.equal(repo.insertVoteSubmission("n-2", 99), true);
  assert.match(executed[0].sql, /insert into vote_submissions/);
  assert.deepEqual(executed[0].params, ["n-2", "pending", null, 99, 99]);
});

test("treasury session and tenant payment writes go through the same seam", () => {
  const { repo, executed, mirrored } = setup();
  repo.openTreasurySession({
    id: "session-1",
    proposalId: "p-1",
    digest: "digest",
    action: { kind: "transfer" },
    signers: ["G..."],
    required: 2,
    expiresAt: 1000,
    actor: null,
    now: 500,
  });
  repo.recordTenantPaymentJob({ tenant_id: "tenant-1", status: "queued" });

  assert.equal(mirrored.length, executed.length);
  assert.match(executed[0].sql, /insert into treasury_signing_sessions/);
  assert.match(executed[1].sql, /insert into payment_jobs/);
  assert.ok(executed[0].params.includes(JSON.stringify({ kind: "transfer" })));
  assert.ok(executed[1].params.includes("tenant-1"));
});

test("strict mode fails the primary write when the mirror fails", () => {
  const { repo } = setup({ strict: true, mirrorResult: false });
  assert.throws(
    () => repo.insertVoteSubmission("n-3", 1),
    /Dual-write mirror failed in strict mode/,
  );
});

test("a disabled mirror is a lossless no-op on the primary", () => {
  const { repo, executed } = setup({ mirrorResult: false });
  assert.equal(repo.insertVoteSubmission("n-4", 1), true);
  assert.equal(executed.length, 1);
});
