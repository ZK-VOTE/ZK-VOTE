import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

const TEST_SECRET = 'SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF';

const seedCsrfToken = async () => {
  const { generateCsrfToken } = await import('../src/utils/csrf.ts');
  return generateCsrfToken({ ip: '::ffff:127.0.0.1', headers: {} });
};

const setupApp = async () => {
  process.env.RELAYER_SECRET_KEY = TEST_SECRET;
  process.env.VOTING_CONTRACT_ID = 'C'.padEnd(56, 'A');
  process.env.TREE_CONTRACT_ID = 'C'.padEnd(56, 'B');
  process.env.BRIDGE_CONTRACT_ID = 'C'.padEnd(56, 'D');
  process.env.COMMENTS_CONTRACT_ID = 'C'.padEnd(56, 'E');
  process.env.REWARDS_CONTRACT_ID = 'C'.padEnd(56, 'F');
  process.env.DAO_REGISTRY_CONTRACT_ID = 'C'.padEnd(56, 'G');
  process.env.MEMBERSHIP_SBT_CONTRACT_ID = 'C'.padEnd(56, 'H');
  process.env.CIRCUIT_REGISTRY_CONTRACT_ID = 'C'.padEnd(56, 'J');
  process.env.SOROBAN_RPC_URL = 'http://localhost';
  process.env.CORS_ORIGIN = 'http://localhost';
  process.env.NETWORK_PASSPHRASE = 'Test';
  process.env.RELAYER_TEST_MODE = 'true';
  const relayer = await import('../src/index.ts');
  return { app: relayer.app || relayer.default || relayer };
};

const post = async (app, url, body) => {
  const csrfToken = await seedCsrfToken();
  return request(app)
    .post(url)
    .set('Origin', 'http://localhost')
    .set('X-CSRF-Token', csrfToken)
    .send(body);
};

test('onboarding funnel rejects an unknown step', async () => {
  const { app } = await setupApp();
  const res = await post(app, '/onboarding/funnel', { step: 'not_a_real_step' });
  assert.equal(res.statusCode, 400);
});

test('onboarding funnel records a known step', async () => {
  const { app } = await setupApp();
  const res = await post(app, '/onboarding/funnel', {
    step: 'registration_started',
  });
  assert.equal(res.statusCode, 204);
});

test('onboarding funnel summary reports every step', async () => {
  const { app } = await setupApp();
  await post(app, '/onboarding/funnel', { step: 'registration_started' });

  const res = await request(app).get('/onboarding/funnel/summary');
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.steps));
  const started = res.body.steps.find(
    (s) => s.step === 'registration_started',
  );
  assert.ok(started.count >= 1);
});
