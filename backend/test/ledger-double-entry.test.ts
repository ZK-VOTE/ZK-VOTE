/**
 * Double-entry ledger tests (#refactor registry-settlement-voting-composition).
 * Proof hashes must be non-empty/deterministic, every group must balance, and
 * tampering with any canonical field must be detectable.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBalancedPostingGroup,
  buildTransferGroup,
  computeBalanceProofHash,
  createInMemoryLedgerStore,
  createSqliteLedgerStore,
  minorToStellarAmount,
  stellarAmountToMinor,
  validatePostingGroup,
  validatePostings,
  type LedgerLeg,
  type SqliteDbPort,
  type SqliteStatementPort,
} from "../src/services/ledger.js";

/**
 * Structural SQLite port used instead of better-sqlite3 so these tests run
 * without the native addon. It implements exactly the statements the ledger
 * store issues (DDL no-ops + posting insert/select).
 */
function fakeSqliteDb(): SqliteDbPort {
  const rows = new Map<string, Record<string, unknown>>();
  const byGroup = (groupId: unknown) =>
    [...rows.values()]
      .filter((row) => row.posting_group_id === groupId)
      .sort((a, b) => Number(a.sequence) - Number(b.sequence));
  const statement = (sql: string): SqliteStatementPort => ({
    get: (...params: unknown[]) => {
      if (sql.includes("WHERE posting_group_id = ?")) return byGroup(params[0])[0];
      return undefined;
    },
    all: (...params: unknown[]) => {
      if (sql.includes("WHERE posting_group_id = ?")) return byGroup(params[0]);
      return [...rows.values()].sort(
        (a, b) =>
          String(a.posting_group_id).localeCompare(String(b.posting_group_id)) ||
          Number(a.sequence) - Number(b.sequence),
      );
    },
    run: (...params: unknown[]) => {
      if (sql.includes("INSERT OR REPLACE INTO ledger_postings")) {
        rows.set(String(params[0]), {
          posting_id: params[0],
          posting_group_id: params[1],
          account: params[2],
          asset: params[3],
          amount_minor: params[4],
          direction: params[5],
          sequence: params[6],
          balance_proof_hash: params[7],
          created_at: params[8],
        });
      }
      return {};
    },
  });
  return { prepare: statement };
}

const legs = (source: string, dest: string, amount = 1_000): LedgerLeg[] => [
  { account: source, asset: "USDC", amountMinor: amount, direction: "DEBIT" },
  { account: dest, asset: "USDC", amountMinor: amount, direction: "CREDIT" },
];

test("ledger: every posting has a deterministic non-empty balance proof", () => {
  const first = buildBalancedPostingGroup({ postingGroupId: "g-1", legs: legs("a", "b") });
  const second = buildBalancedPostingGroup({ postingGroupId: "g-1", legs: [...legs("a", "b")].reverse() });
  assert.equal(first.postings.length, 2);
  assert.deepEqual(
    first.postings.map((p) => p.balanceProofHash),
    second.postings.map((p) => p.balanceProofHash),
    "caller leg order must not change hashes",
  );
  for (const posting of first.postings) {
    assert.match(posting.balanceProofHash, /^[0-9a-f]{64}$/);
    assert.equal(posting.balanceProofHash, computeBalanceProofHash(posting));
    assert.equal(posting.postingGroupId, "g-1");
  }
  assert.deepEqual(
    first.postings.map((p) => p.sequence),
    [0, 1],
  );
  assert.equal(validatePostingGroup(first).ok, true);
});

test("ledger: tampering with amount/account/direction breaks balance validation", () => {
  const original = buildBalancedPostingGroup({ postingGroupId: "g-2", legs: legs("a", "b", 500) });
  const tamperedAmount = structuredClone(original);
  tamperedAmount.postings[0]!.amountMinor = 600;
  assert.equal(validatePostingGroup(tamperedAmount).ok, false);
  assert.ok(validatePostingGroup(tamperedAmount).errors.some((e) => /imbalance|mismatch/.test(e)));

  const tamperedHash = structuredClone(original);
  tamperedHash.postings[1]!.balanceProofHash = "";
  assert.equal(validatePostingGroup(tamperedHash).ok, false);
  assert.ok(validatePostingGroup(tamperedHash).errors.some((e) => /empty proof hash/.test(e)));

  const tamperedDirection = structuredClone(original);
  tamperedDirection.postings[1]!.direction = "DEBIT";
  assert.equal(validatePostingGroup(tamperedDirection).ok, false);

  assert.equal(validatePostings([original]).ok, true);
  assert.equal(validatePostings([original, tamperedAmount]).ok, false);
});

test("ledger: unbalanced and zero-amount groups are rejected at build time", () => {
  assert.throws(
    () =>
      buildBalancedPostingGroup({
        postingGroupId: "bad",
        legs: [
          { account: "a", asset: "USDC", amountMinor: 100, direction: "DEBIT" },
          { account: "b", asset: "USDC", amountMinor: 99, direction: "CREDIT" },
        ],
      }),
    /unbalanced/,
  );
  assert.throws(
    () => buildBalancedPostingGroup({ postingGroupId: "zero", legs: legs("a", "b", 0) }),
    /positive safe integers/,
  );
  assert.throws(
    () =>
      buildBalancedPostingGroup({
        postingGroupId: "mixed",
        legs: [
          { account: "a", asset: "USDC", amountMinor: 1, direction: "DEBIT" },
          { account: "b", asset: "EURC", amountMinor: 1, direction: "CREDIT" },
        ],
      }),
    /exactly one asset/,
  );
});

test("ledger: transfer with fee legs debits gross and credits net + fees exactly", () => {
  const group = buildTransferGroup({
    postingGroupId: "transfer-1",
    sourceAccount: "anchor:USDC:clearing",
    destinationAccount: "settlement:tx-1",
    asset: "USDC",
    amountMinor: 10_000,
    feeLegs: [
      { account: "fee:network", amountMinor: 100 },
      { account: "fee:anchor", amountMinor: 200 },
    ],
  });
  assert.equal(validatePostingGroup(group).ok, true);
  assert.deepEqual(
    group.postings.map((p) => [p.direction, p.amountMinor]),
    [
      ["DEBIT", 10_000],
      ["CREDIT", 200], // fee:anchor (credit legs are ordered by account)
      ["CREDIT", 100], // fee:network
      ["CREDIT", 9_700], // settlement:tx-1
    ],
  );
  assert.throws(
    () =>
      buildTransferGroup({
        sourceAccount: "a",
        destinationAccount: "b",
        asset: "USDC",
        amountMinor: 100,
        feeLegs: [{ account: "fee", amountMinor: 101 }],
      }),
    /exceed gross/,
  );
});

test("ledger: in-memory and SQLite stores persist balanced groups", async () => {
  const group = buildBalancedPostingGroup({ postingGroupId: "store-1", legs: legs("a", "b") });
  const memory = createInMemoryLedgerStore();
  memory.saveGroup(group);
  assert.equal((await memory.getGroup("store-1"))?.postings.length, 2);
  assert.equal((await memory.listGroups()).length, 1);

  const sqlite = createSqliteLedgerStore(fakeSqliteDb());
  sqlite.saveGroup(group);
  const loaded = await sqlite.getGroup("store-1");
  assert.equal(validatePostingGroup(loaded!).ok, true);
  assert.equal((await sqlite.listGroups()).length, 1);
});

test("ledger: Stellar amount conversion is string based and exact", () => {
  assert.equal(stellarAmountToMinor("10.0000000"), 100_000_000);
  assert.equal(stellarAmountToMinor("0.0000001"), 1);
  assert.equal(stellarAmountToMinor("1.23"), 12_300_000);
  assert.equal(minorToStellarAmount(100_000_000), "10.0000000");
  assert.equal(minorToStellarAmount(1), "0.0000001");
  assert.throws(() => stellarAmountToMinor("0.00000001"), /too many decimals/);
  assert.throws(() => stellarAmountToMinor("NaN"), /invalid Stellar amount/);
});
