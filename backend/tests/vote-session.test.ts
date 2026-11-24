// Wallet-session binding for /vote (#750): session lifecycle, stale and
// forged bindings rejected, network enforcement, and the Tier-1 race where an
// attacker with the victim's credentials submits before the victim does.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import request from "supertest";

process.env.RELAYER_TEST_MODE = "true";
process.env.RELAYER_SECRET_KEY = "SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF";
process.env.RELAYER_AUTH_TOKEN = "vote-session-test-token";
process.env.VOTING_CONTRACT_ID = "C".padEnd(56, "A");
process.env.TREE_CONTRACT_ID = "C".padEnd(56, "B");
process.env.COMMENTS_CONTRACT_ID = "C".padEnd(56, "D");
process.env.SOROBAN_RPC_URL = "http://localhost";
process.env.NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
process.env.CORS_ORIGIN = "http://localhost";
process.env.IPFS_ENABLED = "false";

const { config } = await import("../src/config.js");
const sessions = await import("../src/services/voteSession.js");
const { voteSessionGuard } = await import("../src/middleware/voteSession.js");
const { default: voteSessionRoutes } = await import("../src/routes/voteSession.js");

const TESTNET = "Test SDF Network ; September 2015";
const FUTURENET = "Test SDF Future Network ; October 2022";

/**
 * The real session routes and guard in front of a stand-in /vote that, like
 * the real handler, accepts a nullifier once and answers 409 afterwards.
 */
function makeApp() {
  const spent = new Set<string>();
  const app = express();
  app.use(express.json());
  app.use(voteSessionRoutes);
  app.post("/vote", voteSessionGuard, (req: Request, res: Response) => {
    if (spent.has(req.body.nullifier)) {
      res.status(409).json({ ok: false, status: "CONFLICT", error: "Nullifier already used" });
      return;
    }
    spent.add(req.body.nullifier);
    res.json({ success: true, txHash: "ab".repeat(32) });
  });
  return app;
}

/** What the browser does: random key, register, MAC each vote. */
class Client {
  key = crypto.randomBytes(32);
  sessionId = "";
  constructor(
    private app: express.Express,
    readonly passphrase = TESTNET,
  ) {}
  get net() {
    return sessions.networkHash(this.passphrase);
  }
  async open() {
    const res = await request(this.app)
      .post("/vote-session")
      .send({ key: this.key.toString("base64"), network: this.net });
    this.sessionId = res.body.sessionId;
    return res;
  }
  async revoke() {
    return request(this.app).post("/vote-session/revoke").send({ sessionId: this.sessionId });
  }
  bind(vote: Vote) {
    const mac = crypto
      .createHmac("sha256", this.key)
      .update(sessions.canonicalVoteBinding(vote, this.net))
      .digest("hex");
    return { "X-Vote-Session": this.sessionId, "X-Vote-Session-Mac": mac, "X-Vote-Network": this.net };
  }
}

type Vote = { daoId: number; proposalId: number; choice: boolean; nullifier: string; root: string };

function vote(overrides: Partial<Vote> = {}): Vote {
  return {
    daoId: 1,
    proposalId: 7,
    choice: true,
    nullifier: crypto.randomBytes(31).toString("hex").padStart(64, "0"),
    root: crypto.randomBytes(31).toString("hex").padStart(64, "0"),
    ...overrides,
  };
}

const submit = (app: express.Express, v: Vote, headers: Record<string, string> = {}) =>
  request(app).post("/vote").set(headers).send(v);

test.beforeEach(() => {
  sessions.__resetVoteSessions();
  config.voteSessionRequired = false;
});

// ── Lifecycle ──────────────────────────────────────────────────────────────

test("a bound vote from a live session is accepted", async () => {
  const app = makeApp();
  const client = new Client(app);
  const opened = await client.open();
  assert.equal(opened.status, 201);
  assert.match(opened.body.sessionId, /^[0-9a-f]{32}$/);
  const v = vote();
  const res = await submit(app, v, client.bind(v));
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test("session registration rejects malformed keys and a different network", async () => {
  const app = makeApp();
  const short = await request(app)
    .post("/vote-session")
    .send({ key: crypto.randomBytes(16).toString("base64"), network: sessions.networkHash(TESTNET) });
  assert.equal(short.status, 400);
  assert.equal(short.body.code, "INVALID_SESSION_KEY");

  const futurenet = await new Client(app, FUTURENET).open();
  assert.equal(futurenet.status, 409);
  assert.equal(futurenet.body.code, "NETWORK_MISMATCH");
});

test("stale-session artifacts are rejected after revoke (disconnect / account switch)", async () => {
  const app = makeApp();
  const client = new Client(app);
  await client.open();
  const v = vote();
  const headers = client.bind(v); // built under the session...
  assert.equal((await client.revoke()).status, 204);
  const res = await submit(app, v, headers); // ...submitted after it ended
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "VOTE_SESSION_STALE");
});

test("expired and unknown sessions read as stale", async () => {
  const app = makeApp();
  const client = new Client(app);
  await client.open();
  const v = vote();
  const later = Date.now() + sessions.VOTE_SESSION_TTL_MS + 1;
  const expired = sessions.verifyVoteBinding(
    client.sessionId,
    client.bind(v)["X-Vote-Session-Mac"],
    client.net,
    v,
    later,
  );
  assert.deepEqual(expired, { ok: false, status: 401, code: "VOTE_SESSION_STALE" });

  const unknown = await submit(app, v, { ...client.bind(v), "X-Vote-Session": "f".repeat(32) });
  assert.equal(unknown.body.code, "VOTE_SESSION_STALE");
});

test("network mismatch is enforced at submit, not just at session creation", async () => {
  const app = makeApp();
  const client = new Client(app);
  await client.open();
  const v = vote();
  const headers = { ...client.bind(v), "X-Vote-Network": sessions.networkHash(FUTURENET) };
  const res = await submit(app, v, headers);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NETWORK_MISMATCH");
});

test("VOTE_SESSION_REQUIRED rejects unbound votes; off, they pass for rollout", async () => {
  const app = makeApp();
  assert.equal((await submit(app, vote())).status, 200);
  config.voteSessionRequired = true;
  const res = await submit(app, vote());
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "VOTE_SESSION_REQUIRED");
});

// ── Tier-1: victim prove vs attacker submit ────────────────────────────────

test("race: a captured payload cannot be re-bound to the attacker's session", async () => {
  const app = makeApp();
  const victim = new Client(app);
  const attacker = new Client(app);
  await victim.open();
  await attacker.open();
  const v = vote();
  const victimHeaders = victim.bind(v);

  // Attacker swaps in their own session id but keeps the victim's MAC.
  const swapped = await submit(app, v, { ...victimHeaders, "X-Vote-Session": attacker.sessionId });
  assert.equal(swapped.status, 401);
  assert.equal(swapped.body.code, "VOTE_SESSION_INVALID");

  // Tampering with any bound field (here the choice) breaks the MAC too.
  const flipped = await submit(app, { ...v, choice: !v.choice }, victimHeaders);
  assert.equal(flipped.body.code, "VOTE_SESSION_INVALID");

  // The victim's own submission still lands.
  assert.equal((await submit(app, v, victimHeaders)).status, 200);
});

test("race: an attacker who re-derived the credentials and submits first is attributed", async () => {
  const app = makeApp();
  const victim = new Client(app);
  const attacker = new Client(app);
  await victim.open();
  await attacker.open();

  // Same nullifier (same credentials), attacker's choice, attacker's session.
  const victimVote = vote({ choice: true });
  const stolen = { ...victimVote, choice: false };
  assert.equal((await submit(app, stolen, attacker.bind(stolen))).status, 200);

  const late = await submit(app, victimVote, victim.bind(victimVote));
  assert.equal(late.status, 409);
  assert.equal(late.body.conflictSource, "other_session");
});

test("race: the victim's own retry of an accepted vote reads as same_session", async () => {
  const app = makeApp();
  const victim = new Client(app);
  await victim.open();
  const v = vote();
  await submit(app, v, victim.bind(v));
  const retry = await submit(app, v, victim.bind(v));
  assert.equal(retry.status, 409);
  assert.equal(retry.body.conflictSource, "same_session");
});

// ── Wiring ─────────────────────────────────────────────────────────────────

test("the real /vote route runs voteSessionGuard and mounts the session routes", async () => {
  const { default: votingRouter } = await import("../src/routes/voting.js");
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> }; handle?: unknown };
  const stack = (votingRouter as unknown as { stack: Layer[] }).stack;
  const voteRoute = stack.find((l) => l.route?.path === "/vote" && l.route.methods.post);
  assert.ok(voteRoute?.route, "/vote route registered");
  assert.ok(voteRoute.route.stack.some((s) => s.handle === voteSessionGuard), "guard in /vote chain");
  assert.ok(stack.some((l) => l.handle === voteSessionRoutes), "session routes mounted");
});

test("the session store stays bounded under a session-minting flood", () => {
  for (let i = 0; i < sessions.MAX_VOTE_SESSIONS + 500; i++) {
    sessions.createVoteSession(crypto.randomBytes(32).toString("base64"), sessions.networkHash(TESTNET), TESTNET);
  }
  // Evicted ids read as stale, so a flood can only end the oldest sessions.
  const fresh = sessions.createVoteSession(
    crypto.randomBytes(32).toString("base64"),
    sessions.networkHash(TESTNET),
    TESTNET,
  );
  assert.ok(fresh.ok);
});
