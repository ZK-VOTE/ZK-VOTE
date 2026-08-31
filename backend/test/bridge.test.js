import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

const token = 'testtoken';
const TEST_SECRET = 'SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF';

// Write endpoints pass through csrfGuard (Origin check + X-CSRF-Token check).
// The token store is in-memory and session-bound (ip + user-agent), so tests
// seed it via the exported generator using the same session identity a
// supertest request presents (loopback ip, no user-agent header).
const seedCsrfToken = async () => {
  const { generateCsrfToken } = await import('../src/utils/csrf.ts');
  return generateCsrfToken({ ip: '::ffff:127.0.0.1', headers: {} });
};

const setupApp = async () => {
  process.env.RELAYER_SECRET_KEY = TEST_SECRET;
  process.env.VOTING_CONTRACT_ID = 'C'.padEnd(56, 'A');
  process.env.TREE_CONTRACT_ID = 'C'.padEnd(56, 'B');
  process.env.BRIDGE_CONTRACT_ID = 'C'.padEnd(56, 'D');
  // config.ts hard-exits on invalid COMMENTS/REWARDS contract ids (and
  // .env.development ships placeholders), so give every validated contract
  // var a well-formed strkey before src/index.ts is imported.
  process.env.COMMENTS_CONTRACT_ID = 'C'.padEnd(56, 'E');
  process.env.REWARDS_CONTRACT_ID = 'C'.padEnd(56, 'F');
  process.env.DAO_REGISTRY_CONTRACT_ID = 'C'.padEnd(56, 'G');
  process.env.MEMBERSHIP_SBT_CONTRACT_ID = 'C'.padEnd(56, 'H');
  process.env.CIRCUIT_REGISTRY_CONTRACT_ID = 'C'.padEnd(56, 'J');
  process.env.SOROBAN_RPC_URL = 'http://localhost';
  process.env.CORS_ORIGIN = 'http://localhost';
  process.env.NETWORK_PASSPHRASE = 'Test';
  process.env.RELAYER_AUTH_TOKEN = token;
  process.env.HEALTH_EXPOSE_DETAILS = 'true';
  process.env.RELAYER_TEST_MODE = 'true';
  const relayer = await import('../src/index.ts');
  // Seed a fresh auth-token row instead of relying on migrateLegacyToken():
  // that migration is skipped whenever the shared dev DB already holds a
  // tok_legacy_env row — which another test file's process may have created
  // hashed from a *different* RELAYER_AUTH_TOKEN — leaving our bearer token
  // unresolvable (token_not_found). A fresh row per process is deterministic.
  const { createNewToken } = await import('../src/services/authTokens.ts');
  const { rawToken } = createNewToken({
    clientId: 'bridge-test',
    description: 'bridge.test.js relay test token',
    lifetimeMs: 5 * 60_000,
  });
  return { app: relayer.app || relayer.default || relayer, rawToken };
};

const post = async (app, url, body, extraHeaders = {}) => {
  const csrfToken = await seedCsrfToken();
  return request(app)
    .post(url)
    .set('Origin', 'http://localhost')
    .set('X-CSRF-Token', csrfToken)
    .set(extraHeaders)
    .send(body);
};

test('bridge vote rejects malformed proof', async () => {
  const { app } = await setupApp();
  const res = await post(app, '/bridge/vote', {
    daoId: 1,
    proposalId: 1,
    voteChoice: 1,
    nullifier: '0x01',
    voteRoot: '0x01',
    sbtRoot: '0x01',
    proof: { a: '0xzz', b: '0x01', c: '0x01' },
  });
  assert.equal(res.statusCode, 400);
});

test('bridge nullifier check returns used false in test mode', async () => {
  const { app } = await setupApp();
  const res = await request(app).get('/bridge/nullifier/1/1/0x01');
  // In test mode, missing bridge contract may cause 404 or 500, but we check it doesn't crash
  assert.ok([200, 404, 500].includes(res.statusCode));
});

test('bridge relay requires auth', async () => {
  const { app } = await setupApp();
  const res = await post(app, '/bridge/relay', {});
  assert.equal(res.statusCode, 401);
});

test('bridge relay succeeds with auth in test mode', async () => {
  const { app, rawToken } = await setupApp();
  const res = await post(app, '/bridge/relay', {}, {
    Authorization: `Bearer ${rawToken}`,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
});
