/**
 * Focused integration tests for POST /pay/vote and GET /pay/metrics.
 *
 * These import the /pay router directly instead of src/index.ts: the full app
 * pulls in unrelated modules (backupCrypto) whose baseline imports are broken
 * in this checkout. Everything exercised here is the real route + services,
 * running in RELAYER_TEST_MODE (envelope built and hashed, no RPC submission).
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

const token = 'sponsored-vote-test-token-0123456789';

let app;
let StellarSdk;
let econ;
let relayerKeypair;
let config;

before(async () => {
  process.env.RELAYER_TEST_MODE = 'true';
  process.env.RELAYER_SECRET_KEY =
    'SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF';
  process.env.NETWORK_PASSPHRASE = 'Test Network';
  process.env.SOROBAN_RPC_URL = 'http://localhost';
  process.env.CORS_ORIGIN = 'http://localhost';
  process.env.RELAYER_AUTH_TOKEN = token;
  StellarSdk = await import('@stellar/stellar-sdk');
  process.env.VOTING_CONTRACT_ID = StellarSdk.StrKey.encodeContract(
    Buffer.alloc(32, 7),
  );

  const express = (await import('express')).default;
  const { default: payRoutes } = await import('../src/routes/pay.ts');
  econ = await import('../src/services/relayer-fee-economics.ts');
  ({ relayerKeypair } = await import('../src/services/stellar.ts'));
  ({ config } = await import('../src/config.ts'));

  app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(payRoutes);
});

async function signedVote(overrides = {}) {
  const signer = StellarSdk.Keypair.random();
  const fields = {
    version: econ.VOTE_AUTH_VERSION,
    domain: econ.VOTE_AUTH_DOMAIN,
    chainId: config.networkPassphrase,
    daoId: 42,
    proposalId: 9,
    voter: signer.publicKey(),
    commitment: 'ab'.repeat(32),
    nullifier: 'cd'.repeat(32),
    choice: 1,
    relayer: relayerKeypair.publicKey(),
    expiry: Math.floor(Date.now() / 1000) + 120,
    nonce: `nonce-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    signerPublicKey: signer.publicKey(),
    ...overrides,
  };
  return econ.signVoteAuthorization(fields, signer.secret());
}

test('POST /pay/vote accepts a valid authorization and returns quota headers', async () => {
  const auth = await signedVote();
  const res = await request(app).post('/pay/vote').send(auth);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.ok(res.body.txHash);
  assert.equal(typeof res.body.feeStroops, 'number');
  assert.equal(res.body.dryRun, true);
  for (const header of [
    'x-sponsorship-limit',
    'x-sponsorship-remaining',
    'x-sponsorship-reset',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
  ]) {
    assert.ok(res.headers[header], `missing ${header}`);
  }
});

test('POST /pay/vote rejects a replayed nonce', async () => {
  const auth = await signedVote();
  const first = await request(app).post('/pay/vote').send(auth);
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));
  const replay = await request(app).post('/pay/vote').send(auth);
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.body.code, 'NONCE_REPLAY');
});

test('POST /pay/vote rejects an expired authorization', async () => {
  const auth = await signedVote({ expiry: Math.floor(Date.now() / 1000) - 120 });
  const res = await request(app).post('/pay/vote').send(auth);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'EXPIRED_AUTHORIZATION');
});

test('POST /pay/vote rejects a tampered signature', async () => {
  const auth = await signedVote();
  const tampered = { ...auth, choice: auth.choice === 1 ? 0 : 1 };
  const res = await request(app).post('/pay/vote').send(tampered);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'INVALID_SIGNATURE');
});

test('POST /pay/vote reports budget exhaustion with a typed code', async () => {
  const previous = process.env.SPONSORSHIP_DAILY_LIMIT_STROOPS;
  process.env.SPONSORSHIP_DAILY_LIMIT_STROOPS = '100000';
  try {
    const auth = await signedVote();
    const res = await request(app).post('/pay/vote').send(auth);
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.code, 'BUDGET_EXHAUSTED');
    assert.ok(res.headers['retry-after']);
  } finally {
    if (previous === undefined) delete process.env.SPONSORSHIP_DAILY_LIMIT_STROOPS;
    else process.env.SPONSORSHIP_DAILY_LIMIT_STROOPS = previous;
  }
});

test('POST /pay/vote degrades gracefully when the reserve is low', async () => {
  econ.setRelayerReserveXlm(1);
  try {
    const auth = await signedVote();
    const res = await request(app).post('/pay/vote').send(auth);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'RELAYER_RESERVE_LOW');
    assert.equal(res.body.retryable, true);
    assert.ok(res.headers['retry-after']);
  } finally {
    econ.setRelayerReserveXlm(25);
  }
});

test('GET /pay/metrics exposes sponsored fee and rejection counters', async () => {
  const res = await request(app)
    .get('/pay/metrics')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(typeof res.body.sponsoredFeeSpendStroops, 'number');
  assert.ok(res.body.authorizationRejections.NONCE_REPLAY >= 1);
  assert.ok(res.body.feeEstimateStroopsHistogram.count >= 1);
});

test('GET /pay/metrics requires the relayer token', async () => {
  const res = await request(app).get('/pay/metrics');
  assert.equal(res.statusCode, 401);
});
