/**
 * Governance analytics platform (#322)
 *
 * Acceptance coverage: the endpoints live under /api/v1, aggregation happens
 * in SQL rather than by reducing rows in the relay, parameters are validated,
 * and the CSV export stays correct under a stress-sized dataset.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zkvote-analytics-"));
const dbPath = path.join(tempDir, "analytics.db");

const TOKEN = "analytics-test-token";

process.env.RELAYER_TEST_MODE = "true";
process.env.RELAYER_SECRET_KEY =
  "SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF";
process.env.RELAYER_AUTH_TOKEN = TOKEN;
process.env.AUTH_MASTER_KEY = "analytics-master-key";
process.env.VOTING_CONTRACT_ID = "C".padEnd(56, "A");
process.env.TREE_CONTRACT_ID = "C".padEnd(56, "B");
process.env.COMMENTS_CONTRACT_ID = "C".padEnd(56, "D");
process.env.SOROBAN_RPC_URL = "http://localhost";
process.env.NETWORK_PASSPHRASE = "Test";
process.env.CORS_ORIGIN = "http://localhost";
process.env.IPFS_ENABLED = "false";

const { app } = await import("../src/index.ts");
const { initDb, addEvent, upsertDaos } = await import("../src/services/db.js");
const {
  getDaoOverview,
  getParticipationTimeseries,
  getPlatformOverview,
  getProposalTurnout,
  turnoutToCsv,
} = await import("../src/services/analytics.js");

initDb(dbPath);

// ============================================
// FIXTURE
// ============================================

/** Small, hand-checkable DAO: 3 proposals with known vote counts. */
const SMALL_DAO = 1;
/** Stress DAO: enough proposals and votes that a JS-side reduce would show. */
const STRESS_DAO = 2;
const STRESS_PROPOSALS = 300;
const VOTES_PER_PROPOSAL = 10;

upsertDaos([
  {
    id: SMALL_DAO,
    name: "Small DAO",
    creator: "GA".padEnd(56, "X"),
    membership_open: true,
    members_can_propose: true,
    metadata_cid: null,
    member_count: 20,
  },
  {
    id: STRESS_DAO,
    name: "Stress DAO",
    creator: "GB".padEnd(56, "X"),
    membership_open: true,
    members_can_propose: true,
    metadata_cid: null,
    member_count: 1000,
  },
]);

let ledger = 1;
function seed(daoId, type, data, timestamp) {
  ledger += 1;
  addEvent({
    daoId,
    type,
    data,
    ledger,
    txHash: `tx-${daoId}-${ledger}`,
    timestamp,
    verified: true,
  });
}

// Small DAO: proposal 1 gets 5 votes, proposal 2 gets 2, proposal 3 gets none.
const VOTE_COUNTS = { 1: 5, 2: 2, 3: 0 };
for (const proposalId of [1, 2, 3]) {
  seed(
    SMALL_DAO,
    "proposal_created",
    { proposalId, title: `Proposal ${proposalId}` },
    `2026-08-0${proposalId}T00:00:00.000Z`,
  );
  for (let v = 0; v < VOTE_COUNTS[proposalId]; v++) {
    seed(
      SMALL_DAO,
      "vote_cast",
      { proposalId, choice: v % 2 === 0 },
      `2026-08-0${proposalId}T0${v}:30:00.000Z`,
    );
  }
}
seed(SMALL_DAO, "proposal_closed", { proposalId: 1 }, "2026-08-05T00:00:00.000Z");
seed(SMALL_DAO, "member_added", { member: "GC".padEnd(56, "X") }, "2026-08-01T01:00:00.000Z");

// Stress DAO: 300 proposals x 10 votes = 3,300 events in one partition.
for (let proposalId = 1; proposalId <= STRESS_PROPOSALS; proposalId++) {
  seed(STRESS_DAO, "proposal_created", { proposalId }, "2026-07-01T00:00:00.000Z");
  for (let v = 0; v < VOTES_PER_PROPOSAL; v++) {
    seed(STRESS_DAO, "vote_cast", { proposalId }, "2026-07-01T00:00:00.000Z");
  }
}

// ============================================
// AGGREGATION CORRECTNESS
// ============================================

test("DAO overview counts proposals, votes and membership from SQL", async () => {
  const overview = await getDaoOverview(SMALL_DAO);

  assert.equal(overview.daoId, SMALL_DAO);
  assert.equal(overview.memberCount, 20);
  assert.equal(overview.proposalsCreated, 3);
  assert.equal(overview.proposalsClosed, 1);
  assert.equal(overview.votesCast, 7);
  assert.equal(overview.proposalsWithVotes, 2, "proposal 3 received no votes");
  assert.equal(overview.membersJoined, 1);
  assert.equal(overview.averageVotesPerProposal, 7 / 3);
  assert.equal(overview.proposalParticipationRate, 2 / 3);
  assert.equal(overview.firstEventAt, "2026-08-01T00:00:00.000Z");
});

test("turnout is per proposal and divided against the member count", async () => {
  const page = await getProposalTurnout(SMALL_DAO, { limit: 10 });

  assert.equal(page.total, 3);
  assert.deepEqual(
    page.items.map((item) => item.proposalId),
    [3, 2, 1],
    "newest proposal first",
  );

  const first = page.items.find((item) => item.proposalId === 1);
  assert.equal(first.votesCast, 5);
  assert.equal(first.eligibleVoters, 20);
  assert.equal(first.turnoutRatio, 0.25);
  assert.equal(first.closedAt, "2026-08-05T00:00:00.000Z");
  assert.equal(first.firstVoteAt, "2026-08-01T00:30:00.000Z");

  const unvoted = page.items.find((item) => item.proposalId === 3);
  assert.equal(unvoted.votesCast, 0);
  assert.equal(unvoted.turnoutRatio, 0);
  assert.equal(unvoted.closedAt, null);
  assert.equal(unvoted.firstVoteAt, null);
});

test("turnout can be narrowed to a single proposal", async () => {
  const page = await getProposalTurnout(SMALL_DAO, { proposalId: 2 });

  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].proposalId, 2);
  assert.equal(page.items[0].votesCast, 2);
  assert.equal(page.total, 1, "total reflects the filter, not the whole DAO");
});

test("participation buckets by day inside SQLite", async () => {
  const buckets = await getParticipationTimeseries(SMALL_DAO, {
    interval: "day",
  });

  const byDay = Object.fromEntries(buckets.map((b) => [b.bucket, b]));
  assert.equal(byDay["2026-08-01"].votesCast, 5);
  assert.equal(byDay["2026-08-01"].proposalsCreated, 1);
  assert.equal(byDay["2026-08-01"].activeProposals, 1);
  assert.equal(byDay["2026-08-01"].membersJoined, 1);
  assert.equal(byDay["2026-08-02"].votesCast, 2);
  assert.equal(byDay["2026-08-03"].votesCast, 0);
});

test("participation respects the from/to window", async () => {
  const buckets = await getParticipationTimeseries(SMALL_DAO, {
    interval: "day",
    from: "2026-08-02T00:00:00.000Z",
    to: "2026-08-03T00:00:00.000Z",
  });

  assert.deepEqual(
    buckets.map((b) => b.bucket),
    ["2026-08-02"],
  );
});

test("platform overview aggregates across every partition", async () => {
  const overview = await getPlatformOverview();

  assert.ok(overview.daoCount >= 2);
  assert.equal(
    overview.proposalsCreated,
    3 + STRESS_PROPOSALS,
    "proposals are summed across DAO partitions",
  );
  assert.equal(overview.votesCast, 7 + STRESS_PROPOSALS * VOTES_PER_PROPOSAL);
});

// ============================================
// SQL, NOT IN-MEMORY REDUCE
// ============================================

test("a page of turnout stays small no matter how many proposals exist", async () => {
  const page = await getProposalTurnout(STRESS_DAO, { limit: 5 });

  // A JS-side reduce would have to materialise all 300 proposals (and their
  // 3,000 votes) to answer this; SQL returns exactly the page plus a count.
  assert.equal(page.items.length, 5);
  assert.equal(page.total, STRESS_PROPOSALS);
  assert.equal(page.limit, 5);
  assert.equal(page.items[0].proposalId, STRESS_PROPOSALS);
  assert.equal(page.items[0].votesCast, VOTES_PER_PROPOSAL);
  assert.equal(page.items[0].turnoutRatio, VOTES_PER_PROPOSAL / 1000);
});

test("overview over the stress partition is one row, not 3,300", async () => {
  const overview = await getDaoOverview(STRESS_DAO);

  assert.equal(overview.proposalsCreated, STRESS_PROPOSALS);
  assert.equal(overview.votesCast, STRESS_PROPOSALS * VOTES_PER_PROPOSAL);
  assert.equal(overview.proposalsWithVotes, STRESS_PROPOSALS);
  assert.equal(overview.totalEvents, STRESS_PROPOSALS * (VOTES_PER_PROPOSAL + 1));
});

// ============================================
// CSV EXPORT (STRESS REGRESSION)
// ============================================

test("stress CSV export is well formed and complete", async () => {
  const page = await getProposalTurnout(STRESS_DAO, { limit: 200 });
  const csv = turnoutToCsv(page.items);
  const lines = csv.trimEnd().split("\n");

  assert.equal(
    lines[0],
    "dao_id,proposal_id,created_at,closed_at,votes_cast,eligible_voters,turnout_ratio",
  );
  assert.equal(lines.length, 201, "header plus one row per proposal in the page");

  const firstRow = lines[1].split(",");
  assert.equal(firstRow[0], String(STRESS_DAO));
  assert.equal(firstRow[1], String(STRESS_PROPOSALS));
  assert.equal(firstRow[4], String(VOTES_PER_PROPOSAL));
  assert.equal(firstRow[5], "1000");
  assert.equal(firstRow[6], "0.010000");

  // Every row has the same arity — no unescaped delimiter shifted a column.
  for (const line of lines) {
    assert.equal(line.split(",").length, 7, `ragged CSV row: ${line}`);
  }
  assert.equal(csv.at(-1), "\n", "file ends with a newline");
});

test("CSV escapes delimiters and neutralises spreadsheet formulas", () => {
  const csv = turnoutToCsv([
    {
      daoId: 1,
      proposalId: 4,
      createdAt: 'a,b"c',
      closedAt: "=SUM(A1:A9)",
      votesCast: 2,
      eligibleVoters: 10,
      turnoutRatio: 0.2,
    },
  ]);

  const row = csv.trimEnd().split("\n")[1];
  assert.ok(row.includes('"a,b""c"'), "quotes and commas are escaped");
  assert.ok(row.includes("'=SUM(A1:A9)"), "a leading = is neutralised");
});

// ============================================
// HTTP SURFACE: ROUTING, VALIDATION, AUTHZ
// ============================================

test("endpoints are served under /api/v1", async () => {
  const res = await request(app).get(
    `/api/v1/analytics/daos/${SMALL_DAO}/overview`,
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.daoId, SMALL_DAO);
  assert.equal(res.body.votesCast, 7);
});

test("turnout endpoint returns a paginated envelope", async () => {
  const res = await request(app)
    .get(`/api/v1/analytics/daos/${SMALL_DAO}/turnout`)
    .query({ limit: 2 });

  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 2);
  assert.equal(res.body.total, 3);
  assert.equal(res.body.offset, 0);
});

test("participation endpoint echoes the interval it used", async () => {
  const res = await request(app)
    .get(`/api/v1/analytics/daos/${SMALL_DAO}/participation`)
    .query({ interval: "month" });

  assert.equal(res.status, 200);
  assert.equal(res.body.interval, "month");
  assert.deepEqual(
    res.body.buckets.map((b) => b.bucket),
    ["2026-08"],
  );
});

test("invalid parameters are rejected with 400", async () => {
  const cases = [
    [`/api/v1/analytics/daos/not-a-number/overview`, {}],
    [`/api/v1/analytics/daos/-1/overview`, {}],
    [`/api/v1/analytics/daos/${SMALL_DAO}/participation`, { interval: "fortnight" }],
    [
      `/api/v1/analytics/daos/${SMALL_DAO}/participation`,
      { from: "2026-08-05T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" },
    ],
    [`/api/v1/analytics/daos/${SMALL_DAO}/turnout`, { limit: 0 }],
    [`/api/v1/analytics/daos/${SMALL_DAO}/turnout`, { limit: 5000 }],
    [`/api/v1/analytics/daos/${SMALL_DAO}/turnout`, { offset: -1 }],
  ];

  for (const [url, query] of cases) {
    const res = await request(app).get(url).query(query);
    assert.equal(res.status, 400, `${url} ${JSON.stringify(query)} should be rejected`);
  }
});

test("a DAO ID that cannot name a partition never reaches SQL", async () => {
  // Guards the one place a value is interpolated into a table name.
  const res = await request(app).get(
    "/api/v1/analytics/daos/1%3B%20DROP%20TABLE%20daos/overview",
  );
  assert.equal(res.status, 400);
});

test("operator surfaces require a token", async () => {
  const platform = await request(app).get("/api/v1/analytics/platform/overview");
  assert.equal(platform.status, 401);

  const csv = await request(app).get(
    `/api/v1/analytics/daos/${SMALL_DAO}/turnout.csv`,
  );
  assert.equal(csv.status, 401);
});

test("operator surfaces succeed with a token", async () => {
  const platform = await request(app)
    .get("/api/v1/analytics/platform/overview")
    .set("Authorization", `Bearer ${TOKEN}`);

  assert.equal(platform.status, 200);
  assert.ok(platform.body.daoCount >= 2);

  const csv = await request(app)
    .get(`/api/v1/analytics/daos/${SMALL_DAO}/turnout.csv`)
    .set("Authorization", `Bearer ${TOKEN}`);

  assert.equal(csv.status, 200);
  assert.match(csv.headers["content-type"], /text\/csv/);
  assert.match(csv.headers["content-disposition"], /turnout-dao-1\.csv/);
  assert.match(csv.text, /^dao_id,proposal_id,/);
});

test("an unknown DAO reports zeros rather than failing", async () => {
  const res = await request(app).get("/api/v1/analytics/daos/9999/overview");

  assert.equal(res.status, 200);
  assert.equal(res.body.proposalsCreated, 0);
  assert.equal(res.body.votesCast, 0);
  assert.equal(res.body.averageVotesPerProposal, null);
});
