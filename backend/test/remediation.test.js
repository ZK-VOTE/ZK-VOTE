import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
const token = 'testtoken';

process.env.RELAYER_TEST_MODE = 'true';
process.env.RELAYER_SECRET_KEY = 'SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF';
process.env.VOTING_CONTRACT_ID = 'C'.padEnd(56, 'A');
process.env.TREE_CONTRACT_ID = 'C'.padEnd(56, 'B');
process.env.COMMENTS_CONTRACT_ID = 'C'.padEnd(56, 'D');
process.env.SOROBAN_RPC_URL = 'http://localhost';
process.env.CORS_ORIGIN = 'http://localhost';
process.env.NETWORK_PASSPHRASE = 'Test';
process.env.RELAYER_AUTH_TOKEN = token;

const {
  classifyError,
  remediateError,
  getRemediationHistory,
  getMTTRStats,
  clearRemediationHistory,
  setBackupRpcUrls,
  getCurrentRpcUrl,
  getCurrentPollingInterval,
} = await import('../src/services/remediation.ts');

const setupApp = async () => {
  const relayer = await import('../src/index.ts');
  return relayer.app || relayer.default || relayer;
};

test('classifyError correctly classifies all documented failure modes', () => {
  expectClassification(classifyError({ status: 429 }), 'RPC_RATE_LIMITED');
  expectClassification(classifyError(new Error('tx_bad_seq')), 'SEQUENCE_MISMATCH');
  expectClassification(classifyError({ code: 'SQLITE_BUSY' }), 'SQLITE_LOCKED');
  expectClassification(classifyError({ code: 'SQLITE_CORRUPT' }), 'SQLITE_CORRUPT');
  expectClassification(classifyError(new Error('Pinata upload timeout')), 'PINATA_DOWN');
  expectClassification(classifyError(new Error('Out of memory')), 'MEMORY_EXHAUSTION');
  expectClassification(classifyError(new Error('Service crashed')), 'BACKGROUND_SERVICE_CRASH');
  expectClassification(classifyError(new Error('RPC Connection failed')), 'RPC_CONNECTIVITY');
});

function expectClassification(actual, expected) {
  assert.equal(actual, expected);
}

test('remediateError executes automated remediation and updates MTTR stats', async () => {
  clearRemediationHistory();
  setBackupRpcUrls(['https://rpc1.stellar.org', 'https://rpc2.stellar.org']);

  const initialRpc = getCurrentRpcUrl();
  const rec1 = await remediateError('RPC_CONNECTIVITY', new Error('Timeout'));
  assert.equal(rec1.success, true);
  assert.notEqual(getCurrentRpcUrl(), initialRpc);

  const initialPoll = getCurrentPollingInterval();
  const rec2 = await remediateError('RPC_RATE_LIMITED', new Error('429 Rate limited'));
  assert.equal(rec2.success, true);
  assert.ok(getCurrentPollingInterval() > initialPoll);

  const history = getRemediationHistory();
  assert.ok(history.length >= 2);

  const stats = getMTTRStats();
  const rpcStat = stats.find((s) => s.errorType === 'RPC_CONNECTIVITY');
  assert.ok(rpcStat);
  assert.equal(rpcStat.successfulRecoveries, 1);
});

test('GET /remediation/history endpoint returns history and MTTR stats', async () => {
  const app = await setupApp();
  const res = await request(app).get('/remediation/history');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ok');
  assert.ok(Array.isArray(res.body.history));
  assert.ok(Array.isArray(res.body.stats));
});
