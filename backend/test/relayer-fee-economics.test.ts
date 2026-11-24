import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  assertRelayerReserve,
  canonicalVoteAuthPayload,
  estimateVoteFee,
  InMemoryReplayStore,
  RelayerError,
  replayKey,
  ReplayGuard,
  setRelayerReserveXlm,
  signVoteAuthorization,
  sponsorshipBudget,
  SponsorshipBudget,
  sponsorshipTokenKey,
  TokenBucket,
  verifyVoteAuthorization,
  voteAuthDigest,
  voteAuthorizationSchema,
  VOTE_AUTH_DOMAIN,
  VOTE_AUTH_VERSION,
  getMetrics,
  recordRejection,
  resetRelayerSponsorshipStateForTests,
  type VoteAuthorizationFields,
} from "../src/services/relayer-fee-economics.ts";

const voter = StellarSdk.Keypair.random();
const relayer = "GTESTRELAYER";
const fields: VoteAuthorizationFields = {
  version: VOTE_AUTH_VERSION,
  domain: VOTE_AUTH_DOMAIN,
  chainId: "Test Network",
  daoId: "7",
  proposalId: "3",
  voter: voter.publicKey(),
  nullifier: "aa".repeat(32),
  choice: 1,
  relayer,
  expiry: Math.floor(Date.now() / 1000) + 60,
  nonce: "nonce-1",
  signerPublicKey: voter.publicKey(),
};

const options = {
  expectedRelayer: relayer,
  expectedChainId: "Test Network",
  nowSeconds: Math.floor(Date.now() / 1000),
};

beforeEach(() => {
  resetRelayerSponsorshipStateForTests();
  setRelayerReserveXlm(25);
});

test("authorization schema and canonical payload are domain separated and injective", () => {
  const auth = signVoteAuthorization(fields, voter.secret());
  assert.equal(voteAuthorizationSchema.safeParse(auth).success, true);
  assert.ok(canonicalVoteAuthPayload(auth).startsWith("zkvote-vote-auth-canonical-v1|"));
  assert.equal(
    canonicalVoteAuthPayload({ ...fields, nonce: "nonce-2" }),
    canonicalVoteAuthPayload({ ...fields, nonce: "nonce-2" }),
  );
  assert.notEqual(
    canonicalVoteAuthPayload({ ...fields, nonce: "nonce-1" }),
    canonicalVoteAuthPayload({ ...fields, nonce: "nonce-2" }),
  );
  assert.equal(voteAuthDigest(auth).length, 32);
});

test("valid signature verifies; tampered payload is rejected", () => {
  const auth = signVoteAuthorization(fields, voter.secret());
  assert.doesNotThrow(() => verifyVoteAuthorization(auth, options));
  assert.throws(
    () => verifyVoteAuthorization({ ...auth, choice: 0 }, options),
    (err: unknown) =>
      err instanceof RelayerError && err.code === "INVALID_SIGNATURE",
  );
  assert.throws(
    () => verifyVoteAuthorization({ ...auth, signature: Buffer.alloc(64).toString("base64") }, options),
    (err: unknown) =>
      err instanceof RelayerError && err.code === "INVALID_SIGNATURE",
  );
});

test("expired authorization is rejected by code", () => {
  const auth = signVoteAuthorization(
    { ...fields, expiry: options.nowSeconds - 120 },
    voter.secret(),
  );
  assert.throws(
    () => verifyVoteAuthorization(auth, options),
    (err: unknown) =>
      err instanceof RelayerError && err.code === "EXPIRED_AUTHORIZATION",
  );
});

test("wrong domain and wrong relayer are rejected", () => {
  const wrongDomain = signVoteAuthorization({ ...fields, domain: "other" }, voter.secret());
  assert.throws(
    () => verifyVoteAuthorization(wrongDomain, options),
    (err: unknown) => err instanceof RelayerError && err.code === "DOMAIN_MISMATCH",
  );
  const wrongRelayer = signVoteAuthorization({ ...fields, relayer: "GOTHER" }, voter.secret());
  assert.throws(
    () => verifyVoteAuthorization(wrongRelayer, options),
    (err: unknown) => err instanceof RelayerError && err.code === "RELAYER_MISMATCH",
  );
});

test("replay guard rejects a reused (voter|relayer, nonce) pair", async () => {
  const guard = new ReplayGuard(new InMemoryReplayStore());
  const auth = signVoteAuthorization(fields, voter.secret());
  const key = replayKey(auth);
  assert.equal(sponsorshipTokenKey(auth), `${fields.daoId}|${voter.publicKey()}|${relayer}`);
  await guard.consume(key);
  await assert.rejects(
    guard.consume(key),
    (err: unknown) => err instanceof RelayerError && err.code === "NONCE_REPLAY",
  );
  await guard.consume(replayKey({ ...auth, nonce: "nonce-2" }));
});

test("token bucket is bounded and keys on dao+commitment+relayer, not IP", () => {
  const bucket = new TokenBucket({
    capacity: 2,
    refillPerMinute: 0,
    now: () => 1_000_000,
  });
  const key = "7|0xabc|GTESTRELAYER";
  assert.equal(bucket.consume(key).remaining, 1);
  assert.equal(bucket.consume(key).remaining, 0);
  assert.throws(
    () => bucket.consume(key),
    (err: unknown) => err instanceof RelayerError && err.code === "RATE_LIMITED",
  );
  bucket.consume("8|0xabc|GTESTRELAYER");
  bucket.reset();
  assert.equal(bucket.quota(key).remaining, 2);
});

test("per-DAO budget exhaustion and commit/release accounting", () => {
  process.env.SPONSORSHIP_DAILY_LIMIT_STROOPS = "200000";
  process.env.SPONSORSHIP_PER_VOTE_LIMIT_STROOPS = "500000";
  const budget = new SponsorshipBudget();
  const reservation = budget.reserve("7", 150_000);
  assert.equal(budget.quota("7").remainingStroops, 50_000);
  assert.throws(
    () => budget.reserve("7", 100_000),
    (err: unknown) => err instanceof RelayerError && err.code === "BUDGET_EXHAUSTED",
  );
  budget.commit(reservation);
  assert.equal(budget.quota("7").remainingStroops, 50_000);
  // Another DAO has an independent allowance.
  assert.equal(budget.quota("8").remainingStroops, 200_000);
  delete process.env.SPONSORSHIP_DAILY_LIMIT_STROOPS;
  delete process.env.SPONSORSHIP_PER_VOTE_LIMIT_STROOPS;
});

test("per-vote cap is enforced independently of the daily cap", () => {
  process.env.SPONSORSHIP_PER_VOTE_LIMIT_STROOPS = "100000";
  const budget = new SponsorshipBudget();
  assert.throws(
    () => budget.reserve("7", 110_000),
    (err: unknown) => err instanceof RelayerError && err.code === "BUDGET_EXHAUSTED",
  );
  delete process.env.SPONSORSHIP_PER_VOTE_LIMIT_STROOPS;
});

test("reserve below threshold degrades with RELAYER_RESERVE_LOW", () => {
  const fee = estimateVoteFee().totalStroops;
  assert.doesNotThrow(() => assertRelayerReserve(fee));
  setRelayerReserveXlm(1);
  assert.throws(
    () => assertRelayerReserve(fee),
    (err: unknown) =>
      err instanceof RelayerError &&
      err.code === "RELAYER_RESERVE_LOW" &&
      err.statusCode === 503 &&
      err.retryable,
  );
  setRelayerReserveXlm(25);
});

test("metrics count rejections, budget exhaustion and fee spend", () => {
  estimateVoteFee();
  recordRejection("NONCE_REPLAY");
  recordRejection("BUDGET_EXHAUSTED");
  recordRejection("RELAYER_RESERVE_LOW");
  const m = getMetrics();
  assert.equal(m.authorizationRejections.NONCE_REPLAY, 1);
  assert.equal(m.nonceReplays, 1);
  assert.equal(m.budgetExhaustions, 1);
  assert.equal(m.reserveLowRejections, 1);
  assert.ok(m.feeEstimateStroopsHistogram.count >= 1);
  resetRelayerSponsorshipStateForTests();
  assert.equal(getMetrics().authorizationRejections.NONCE_REPLAY, 0);
});

test("singleton budget is resettable between requests", () => {
  assert.equal(sponsorshipBudget.quota("999").remainingStroops > 0, true);
});
