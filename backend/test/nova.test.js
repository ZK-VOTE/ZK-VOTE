/**
 * Nova IVC Aggregation API Route Tests
 *
 * Uses mocked execAsync (via _setExecForTest) to avoid spawning the cargo CLI.
 * Tests: POST /api/v1/nova/aggregate (200, 400), POST /api/v1/nova/verify (200, 400),
 * and direct verifyProof round-trip.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import request from 'supertest';

// ============================================================
// Stub proof payload — returned by the aggregate mock CLI
// ============================================================
const stubPayload = {
  initial_state: {
    step_count: 0,
    root: '0x0000000000000000000000000000000000000000000000000000000000000000',
    yes_votes: 0,
    no_votes: 0,
    acc_nullifier_hash:
      '0x0000000000000000000000000000000000000000000000000000000000000000',
  },
  final_state: {
    step_count: 2,
    root: '0x0000000000000000000000000000000000000000000000000000000000000000',
    yes_votes: 1,
    no_votes: 1,
    acc_nullifier_hash: '0xdeadbeef',
  },
  num_votes: 2,
  proof_bytes:
    '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
  timestamp: 1700000000,
};

// ============================================================
// Environment setup (must happen before importing the app)
// ============================================================
process.env.RELAYER_SECRET_KEY =
  'SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF';
process.env.VOTING_CONTRACT_ID = 'C'.padEnd(56, 'A');
process.env.TREE_CONTRACT_ID = 'C'.padEnd(56, 'B');
process.env.SOROBAN_RPC_URL = 'http://localhost';
process.env.CORS_ORIGIN = 'http://localhost';
process.env.NETWORK_PASSPHRASE = 'Test';
process.env.RELAYER_AUTH_TOKEN = 'nova-test-token';
process.env.RELAYER_TEST_MODE = 'true';

// ============================================================
// Import app and service singleton
// ============================================================
const { app } = await import('../src/index.ts');
const { novaAggregatorService } = await import(
  '../src/services/nova-aggregator.ts'
);

// ============================================================
// Mock exec helpers
// ============================================================

/**
 * Aggregate mode mock: parses the --out "<path>" argument from the command
 * string, writes the stub payload JSON there, then resolves.
 * The path may contain backslashes (Windows) or forward slashes (Unix).
 */
const mockAggregateExec = async (cmd, _opts) => {
  // Match --out "some/path" or --out "some\path"
  const outMatch = cmd.match(/--out\s+"([^"]+)"/);
  if (outMatch) {
    fs.writeFileSync(outMatch[1], JSON.stringify(stubPayload), 'utf8');
  }
  return { stdout: '[NovaAggregator] mock done', stderr: '' };
};

/**
 * Verify mode mock: resolves with {"verified":true} on stdout (exit code 0).
 */
const mockVerifyExec = async (_cmd, _opts) => {
  return { stdout: '{"verified":true}', stderr: '' };
};

// ============================================================
// Tests
// ============================================================

test('POST /api/v1/nova/aggregate returns 200 with proof_bytes for valid payload', async () => {
  novaAggregatorService._setExecForTest(mockAggregateExec);

  const witnesses = [
    {
      secret: 's1',
      salt: 'salt1',
      path_elements: [],
      path_indices: [],
      vote_choice: 1,
      nullifier: 'n1',
      dao_id: 1,
      proposal_id: 1,
    },
    {
      secret: 's2',
      salt: 'salt2',
      path_elements: [],
      path_indices: [],
      vote_choice: 0,
      nullifier: 'n2',
      dao_id: 1,
      proposal_id: 1,
    },
  ];

  const res = await request(app)
    .post('/api/v1/nova/aggregate')
    .send({ daoId: 1, proposalId: 1, witnesses });

  assert.equal(res.statusCode, 200, `Expected 200 but got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.success, true);
  assert.ok(res.body.data, 'response body should have data field');
  assert.ok(res.body.data.proof_bytes, 'proof_bytes should be present');
  assert.ok(
    res.body.data.proof_bytes.startsWith('0x'),
    `proof_bytes should start with 0x, got: ${res.body.data.proof_bytes}`,
  );
});

test('POST /api/v1/nova/aggregate returns 400 when witnesses is missing', async () => {
  novaAggregatorService._setExecForTest(mockAggregateExec);

  const res = await request(app)
    .post('/api/v1/nova/aggregate')
    .send({ daoId: 1, proposalId: 1 });

  assert.equal(res.statusCode, 400, `Expected 400 but got ${res.statusCode}`);
  assert.ok(res.body.error, 'error message should be present');
});

test('verifyProof round-trip: mocked valid CLI response returns verified=true', async () => {
  novaAggregatorService._setExecForTest(mockVerifyExec);

  const result = await novaAggregatorService.verifyProof(stubPayload);

  assert.equal(result.verified, true);
});

test('POST /api/v1/nova/verify returns 200 with verified=true for valid proof', async () => {
  novaAggregatorService._setExecForTest(mockVerifyExec);

  const res = await request(app)
    .post('/api/v1/nova/verify')
    .send(stubPayload);

  assert.equal(res.statusCode, 200, `Expected 200 but got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.success, true);
  assert.equal(res.body.verified, true);
});

test('POST /api/v1/nova/verify returns 400 when proof_bytes is missing', async () => {
  const res = await request(app)
    .post('/api/v1/nova/verify')
    .send({ initial_state: {}, final_state: {} });

  assert.equal(res.statusCode, 400, `Expected 400 but got ${res.statusCode}`);
  assert.ok(res.body.error, 'error message should be present');
});
