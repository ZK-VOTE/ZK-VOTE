/**
 * Tests for issue #377 – Proposal search + filter API
 *
 * Covers:
 *  - daosQuerySchema: search + membershipType extensions
 *  - proposalsQuerySchema: status / search / pagination
 *  - In-memory DAO filtering logic
 *  - In-memory proposal filtering logic
 */

import test from "node:test";
import assert from "node:assert/strict";

// ─── Import schemas ───────────────────────────────────────────────────────────

const { daosQuerySchema, proposalsQuerySchema } = await import(
  "../src/validation/schemas.js"
);

// ─── daosQuerySchema – search / membershipType extensions ─────────────────────

test("daosQuerySchema: accepts valid search string", () => {
  const result = daosQuerySchema.safeParse({ search: "dao-name" });
  assert.ok(result.success, "Expected parse success");
  assert.equal(result.data.search, "dao-name");
});

test("daosQuerySchema: rejects search string longer than 100 chars", () => {
  const result = daosQuerySchema.safeParse({ search: "a".repeat(101) });
  assert.ok(!result.success, "Expected parse failure");
});

test("daosQuerySchema: accepts membershipType=open", () => {
  const result = daosQuerySchema.safeParse({ membershipType: "open" });
  assert.ok(result.success);
  assert.equal(result.data.membershipType, "open");
});

test("daosQuerySchema: accepts membershipType=closed", () => {
  const result = daosQuerySchema.safeParse({ membershipType: "closed" });
  assert.ok(result.success);
  assert.equal(result.data.membershipType, "closed");
});

test("daosQuerySchema: rejects unknown membershipType", () => {
  const result = daosQuerySchema.safeParse({ membershipType: "unknown" });
  assert.ok(!result.success, "Expected parse failure for unknown type");
});

test("daosQuerySchema: accepts combined search + membershipType + pagination", () => {
  const result = daosQuerySchema.safeParse({
    search: "test",
    membershipType: "open",
    limit: "10",
    offset: "0",
  });
  assert.ok(result.success);
  assert.equal(result.data.search, "test");
  assert.equal(result.data.membershipType, "open");
  assert.equal(result.data.limit, 10);
});

test("daosQuerySchema: defaults limit to 100 and offset to 0", () => {
  const result = daosQuerySchema.safeParse({});
  assert.ok(result.success);
  assert.equal(result.data.limit, 100);
  assert.equal(result.data.offset, 0);
});

test("daosQuerySchema: search is optional (parses without it)", () => {
  const result = daosQuerySchema.safeParse({});
  assert.ok(result.success);
  assert.equal(result.data.search, undefined);
});

// ─── proposalsQuerySchema ─────────────────────────────────────────────────────

test("proposalsQuerySchema: defaults status to 'all'", () => {
  const result = proposalsQuerySchema.safeParse({});
  assert.ok(result.success);
  assert.equal(result.data.status, "all");
});

test("proposalsQuerySchema: accepts status=active", () => {
  const result = proposalsQuerySchema.safeParse({ status: "active" });
  assert.ok(result.success);
  assert.equal(result.data.status, "active");
});

test("proposalsQuerySchema: accepts status=closed", () => {
  const result = proposalsQuerySchema.safeParse({ status: "closed" });
  assert.ok(result.success);
  assert.equal(result.data.status, "closed");
});

test("proposalsQuerySchema: rejects invalid status", () => {
  const result = proposalsQuerySchema.safeParse({ status: "pending" });
  assert.ok(!result.success, "Expected failure for invalid status");
});

test("proposalsQuerySchema: accepts search string", () => {
  const result = proposalsQuerySchema.safeParse({ search: "fund" });
  assert.ok(result.success);
  assert.equal(result.data.search, "fund");
});

test("proposalsQuerySchema: rejects search string longer than 100 chars", () => {
  const result = proposalsQuerySchema.safeParse({ search: "x".repeat(101) });
  assert.ok(!result.success);
});

test("proposalsQuerySchema: accepts pagination parameters", () => {
  const result = proposalsQuerySchema.safeParse({ limit: "20", offset: "40" });
  assert.ok(result.success);
  assert.equal(result.data.limit, 20);
  assert.equal(result.data.offset, 40);
});

test("proposalsQuerySchema: rejects limit > 500", () => {
  const result = proposalsQuerySchema.safeParse({ limit: "501" });
  assert.ok(!result.success);
});

// ─── DAO in-memory filtering logic ───────────────────────────────────────────

const allDaos = [
  { id: 1, name: "ZK Governance", membership_open: true },
  { id: 2, name: "Private Research DAO", membership_open: false },
  { id: 3, name: "Open Community", membership_open: true },
  { id: 4, name: "zkDAO Labs", membership_open: false },
];

function applyDaoFilters(daos, { search, membershipType } = {}) {
  let result = daos;
  if (search) {
    const lower = search.toLowerCase();
    result = result.filter((d) => d.name.toLowerCase().includes(lower));
  }
  if (membershipType === "open") {
    result = result.filter((d) => d.membership_open);
  } else if (membershipType === "closed") {
    result = result.filter((d) => !d.membership_open);
  }
  return result;
}

test("DAO filter: returns all DAOs with no filters", () => {
  assert.equal(applyDaoFilters(allDaos).length, 4);
});

test("DAO filter: filters by name substring case-insensitively", () => {
  const result = applyDaoFilters(allDaos, { search: "zk" });
  assert.equal(result.length, 2);
  assert.ok(result.every((d) => d.name.toLowerCase().includes("zk")));
});

test("DAO filter: returns empty array when search matches nothing", () => {
  assert.equal(
    applyDaoFilters(allDaos, { search: "nomatch_xyz" }).length,
    0,
  );
});

test("DAO filter: membershipType=open returns only open DAOs", () => {
  const result = applyDaoFilters(allDaos, { membershipType: "open" });
  assert.ok(result.every((d) => d.membership_open));
  assert.equal(result.length, 2);
});

test("DAO filter: membershipType=closed returns only closed DAOs", () => {
  const result = applyDaoFilters(allDaos, { membershipType: "closed" });
  assert.ok(result.every((d) => !d.membership_open));
  assert.equal(result.length, 2);
});

test("DAO filter: combines search and membershipType=closed", () => {
  const result = applyDaoFilters(allDaos, {
    search: "dao",
    membershipType: "closed",
  });
  assert.ok(result.every((d) => !d.membership_open));
  assert.ok(result.every((d) => d.name.toLowerCase().includes("dao")));
});

// ─── Proposal in-memory filtering logic ──────────────────────────────────────

const nowSec = Math.floor(Date.now() / 1000);

const proposals = [
  { proposalId: 1, title: "Fund development",  endTime: nowSec + 86400, closed: false },
  { proposalId: 2, title: "Revoke membership",  endTime: nowSec - 1,    closed: true  },
  { proposalId: 3, title: "Elect new admins",   endTime: nowSec + 3600, closed: false },
  { proposalId: 4, title: "Fund marketing",     endTime: nowSec - 3600, closed: true  },
];

function filterProposals(ps, { status = "all", search } = {}) {
  let result = ps;
  if (status === "active") result = result.filter((p) => !p.closed);
  else if (status === "closed") result = result.filter((p) => p.closed);
  if (search) {
    const lower = search.toLowerCase();
    result = result.filter((p) => p.title.toLowerCase().includes(lower));
  }
  return result;
}

test("Proposal filter: returns all with status=all", () => {
  assert.equal(filterProposals(proposals, { status: "all" }).length, 4);
});

test("Proposal filter: status=active returns only open proposals", () => {
  const result = filterProposals(proposals, { status: "active" });
  assert.ok(result.every((p) => !p.closed));
  assert.equal(result.length, 2);
});

test("Proposal filter: status=closed returns only closed proposals", () => {
  const result = filterProposals(proposals, { status: "closed" });
  assert.ok(result.every((p) => p.closed));
  assert.equal(result.length, 2);
});

test("Proposal filter: search on title (case-insensitive)", () => {
  const result = filterProposals(proposals, { status: "all", search: "fund" });
  assert.equal(result.length, 2);
  assert.ok(result.every((p) => p.title.toLowerCase().includes("fund")));
});

test("Proposal filter: combines status=active and search", () => {
  const result = filterProposals(proposals, { status: "active", search: "elect" });
  assert.equal(result.length, 1);
  assert.equal(result[0].proposalId, 3);
});

test("Proposal filter: returns empty when no match", () => {
  assert.equal(
    filterProposals(proposals, { search: "xyznotfound" }).length,
    0,
  );
});

test("Proposal filter: pagination slice is correct", () => {
  const all = filterProposals(proposals, { status: "all" });
  const page1 = all.slice(0, 2);
  const page2 = all.slice(2, 4);
  assert.equal(page1.length, 2);
  assert.equal(page2.length, 2);
  assert.notDeepEqual(page1, page2);
});
