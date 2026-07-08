import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

const token = 'testtoken';
const TEST_SECRET = 'SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF';
const GENERIC_ENV = { RELAYER_GENERIC_ERRORS: 'true' };

const setupApp = async () => {
  process.env.RELAYER_SECRET_KEY = TEST_SECRET;
  process.env.VOTING_CONTRACT_ID = 'C'.padEnd(56, 'A');
  process.env.TREE_CONTRACT_ID = 'C'.padEnd(56, 'B');
  process.env.SOROBAN_RPC_URL = 'http://localhost';
  process.env.CORS_ORIGIN = 'http://localhost'; // CSRF middleware fails-closed on wildcard CORS
  process.env.NETWORK_PASSPHRASE = 'Test';
  process.env.RELAYER_AUTH_TOKEN = token;
  process.env.HEALTH_EXPOSE_DETAILS = 'true';
  process.env.RELAYER_TEST_MODE = 'true';

  const relayer = await import('../src/index.ts');
  return relayer.app || relayer.default || relayer;
};

test('health hides details without auth when token set', async () => {
  const app = await setupApp();
  const res = await request(app).get('/health');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.relayer, undefined);
});

test('health shows details with auth', async () => {
  const app = await setupApp();
  const res = await request(app).get('/health').set('Authorization', `Bearer ${token}`);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.relayer);
  assert.ok(res.body.votingContract);
});

test('ready reports ready without details when unauthenticated', async () => {
  const app = await setupApp();
  const res = await request(app).get('/ready');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ready');
  assert.equal(res.body.relayer, undefined);
});

test('ready shows details with auth', async () => {
  const app = await setupApp();
  const res = await request(app).get('/ready').set('Authorization', `Bearer ${token}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ready');
  assert.ok(res.body.relayer);
  assert.ok(res.body.votingContract);
});

test('vote requires auth when token set', async () => {
  const app = await setupApp();
  const res = await request(app).post('/vote').send({});
  assert.equal(res.statusCode, 401);
});

test('config is publicly accessible (no auth required)', async () => {
  const app = await setupApp();
  const res = await request(app).get('/config');
  // /config is intentionally public - it exposes contract IDs for reads
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.votingContract.startsWith('C'), true);
});

test('config returns contract ids with auth', async () => {
  const app = await setupApp();
  const res = await request(app).get('/config').set('Authorization', `Bearer ${token}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.votingContract.startsWith('C'), true);
  assert.equal(res.body.treeContract.startsWith('C'), true);
  assert.equal(typeof res.body.networkPassphrase, 'string');
  assert.equal(res.body.vkVersion, undefined);
});

test('vote rejects malformed proof hex', async () => {
  const app = await setupApp();
  const res = await request(app)
    .post('/vote')
    .set('Authorization', `Bearer ${token}`)
    .send({
      daoId: 1,
      proposalId: 1,
      choice: true,
      nullifier: '0x01',
      root: '0x01',
      proof: { a: '0xz', b: '0x1', c: '0x1' },
    });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error);
});

test('vote rejects U256 values above BN254 modulus', async () => {
  const app = await setupApp();
  // modulus + 1 (without 0x prefix, as Zod schema expects)
  const tooBig = (BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617') + 1n).toString(16);
  const res = await request(app)
    .post('/vote')
    .set('Authorization', `Bearer ${token}`)
    .send({
      daoId: 1,
      proposalId: 1,
      choice: true,
      nullifier: tooBig,
      root: '01'.repeat(32), // 64 hex chars
      proof: { a: '11'.repeat(64), b: '22'.repeat(128), c: '33'.repeat(64) },
    });
  assert.equal(res.statusCode, 400);
  // Zod returns 'Validation failed' with details mentioning 'BN254 field modulus'
  assert.ok(
    res.body.error === 'Validation failed' ||
    res.body.error.toLowerCase().includes('modulus'),
    `Expected validation error, got: ${res.body.error}`
  );
  if (res.body.details) {
    const nullifierError = res.body.details.find((d) => d.field === 'nullifier');
    assert.ok(nullifierError, 'Should have nullifier validation error');
  }
});

test('vote rejects all-zero proof components', async () => {
  const app = await setupApp();
  const zeroA = '0x' + '00'.repeat(64);
  const zeroB = '0x' + '00'.repeat(128);
  const res = await request(app)
    .post('/vote')
    .set('Authorization', `Bearer ${token}`)
    .send({
      daoId: 1,
      proposalId: 1,
      choice: true,
      nullifier: '0x01',
      root: '0x01',
      proof: { a: zeroA, b: zeroB, c: zeroA },
    });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error);
});

test('generic errors hide message when RELAYER_GENERIC_ERRORS=true', async () => {
  const app = await setupApp();
  Object.entries(GENERIC_ENV).forEach(([k, v]) => (process.env[k] = v));
  const res = await request(app)
    .post('/vote')
    .set('Authorization', `Bearer ${token}`)
    .send({
      daoId: 1,
      proposalId: 1,
      choice: true,
      nullifier: '0xz', // malformed
      root: '0x01',
      proof: { a: '0x' + '11'.repeat(64), b: '0x' + '22'.repeat(128), c: '0x' + '33'.repeat(64) },
    });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error);
  assert.equal(res.body.message, undefined);
});
