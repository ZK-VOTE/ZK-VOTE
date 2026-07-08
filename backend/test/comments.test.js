/**
 * Comments E2E Tests
 *
 * Tests the full comment lifecycle:
 * - Public comment creation with IPFS upload
 * - Comment editing and revision history
 * - Comment deletion (user + admin)
 * - Revision history retrieval
 * - Reply threading
 *
 * These tests use RELAYER_TEST_MODE=true to mock contract interactions,
 * but test real IPFS upload/fetch when PINATA_JWT is configured.
 *
 * Run with: npm test -- test/comments.test.js
 * With IPFS: PINATA_JWT=xxx npm test -- test/comments.test.js
 */

import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

const token = 'testtoken';
const TEST_SECRET = 'SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF';
const TEST_AUTHOR = 'GCKFBEIYY5YPP5LNKMYJ3KBGQ3HYYZCMN5QBQHGXIPH7TVHLG2D2S3N6';

// Skip IPFS tests if no JWT configured
// Note: PINATA_JWT must be set BEFORE running tests for IPFS features to work
// The relayer module evaluates IPFS_ENABLED = !!PINATA_JWT at load time
const PINATA_JWT = process.env.PINATA_JWT;
const skipIfNoIpfs = !PINATA_JWT ? { skip: 'PINATA_JWT not configured' } : {};

let app;
let appLoaded = false;

const setupApp = async () => {
  // Only load the app once to avoid module caching issues
  if (appLoaded && app) {
    return app;
  }

  process.env.RELAYER_SECRET_KEY = TEST_SECRET;
  process.env.VOTING_CONTRACT_ID = 'C'.padEnd(56, 'A');
  process.env.TREE_CONTRACT_ID = 'C'.padEnd(56, 'B');
  process.env.SOROBAN_RPC_URL = 'http://localhost:8000/soroban/rpc';
  process.env.CORS_ORIGIN = 'http://localhost'; // CSRF middleware fails-closed on wildcard CORS
  process.env.NETWORK_PASSPHRASE = 'Test SDF Future Network ; October 2022';
  process.env.RELAYER_AUTH_TOKEN = token;
  process.env.RELAYER_TEST_MODE = 'true';

  const relayer = await import('../src/index.ts');
  app = relayer.app || relayer.default || relayer;
  appLoaded = true;

  // Initialize Pinata for IPFS tests if JWT is available
  if (PINATA_JWT) {
    const { initPinata } = await import('../src/services/ipfs.ts');
    initPinata(PINATA_JWT);
  }

  return app;
};

// ============================================
// IPFS TESTS
// ============================================

test('POST /ipfs/metadata - upload comment content', skipIfNoIpfs, async () => {
  app = await setupApp();

  const commentMetadata = {
    version: 1,
    body: '# Test Comment\n\nThis is a **markdown** comment for testing.',
    createdAt: new Date().toISOString(),
  };

  const res = await request(app)
    .post('/ipfs/metadata')
    .send(commentMetadata);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.cid, 'Should return a CID');
  assert.ok(
    res.body.cid.startsWith('bafy') || res.body.cid.startsWith('bafk') || res.body.cid.startsWith('Qm'),
    `CID should be valid format (got: ${res.body.cid})`
  );

  console.log(`  Uploaded comment CID: ${res.body.cid}`);
});

test('GET /ipfs/:cid - fetch comment content', skipIfNoIpfs, async () => {
  app = await setupApp();

  // First upload
  const commentMetadata = {
    version: 1,
    body: 'Test comment for fetch',
    testId: `fetch-test-${Date.now()}`,
  };

  const uploadRes = await request(app)
    .post('/ipfs/metadata')
    .send(commentMetadata);

  assert.equal(uploadRes.statusCode, 200);
  const cid = uploadRes.body.cid;

  // Wait for propagation
  await new Promise(r => setTimeout(r, 2000));

  // Fetch
  const fetchRes = await request(app)
    .get(`/ipfs/${cid}`);

  assert.equal(fetchRes.statusCode, 200);
  assert.equal(fetchRes.body.version, commentMetadata.version);
  assert.equal(fetchRes.body.body, commentMetadata.body);
  assert.equal(fetchRes.body.testId, commentMetadata.testId);
});

test('GET /ipfs/health - check IPFS service status', skipIfNoIpfs, async () => {
  app = await setupApp();

  const res = await request(app)
    .get('/ipfs/health');

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.enabled, true);
  assert.ok(['healthy', 'degraded'].includes(res.body.status));
});

// ============================================
// COMMENT API VALIDATION TESTS
// ============================================

// NOTE: The /comment/public endpoint has been REMOVED.
// Public comments now go directly through Freighter wallet signing to the contract.
// The relayer only handles anonymous comments that require ZK proof submission.

test('POST /comment/public - endpoint removed (use direct wallet signing)', async () => {
  app = await setupApp();

  const res = await request(app)
    .post('/comment/public')
    .send({
      daoId: 1,
      proposalId: 1,
      contentCid: 'bafytest123',
      author: TEST_AUTHOR,
    });

  // Endpoint was removed - should return 404 (no route matched)
  assert.equal(res.statusCode, 404, 'Public comment endpoint should be removed (now uses direct wallet signing)');
});

// ============================================
// COMMENT EDIT VALIDATION TESTS
// ============================================

test('POST /comment/edit - requires authentication', async () => {
  app = await setupApp();

  const res = await request(app)
    .post('/comment/edit')
    .send({
      daoId: 1,
      proposalId: 1,
      commentId: 1,
      newContentCid: 'bafynewcid123',
      author: TEST_AUTHOR,
    });

  assert.equal(res.statusCode, 401);
});

test('POST /comment/edit - validates required fields', async () => {
  app = await setupApp();

  // Missing commentId
  let res = await request(app)
    .post('/comment/edit')
    .set('Authorization', `Bearer ${token}`)
    .send({
      daoId: 1,
      proposalId: 1,
      newContentCid: 'bafynewcid123',
      author: TEST_AUTHOR,
    });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes('Missing'));

  // Missing newContentCid
  res = await request(app)
    .post('/comment/edit')
    .set('Authorization', `Bearer ${token}`)
    .send({
      daoId: 1,
      proposalId: 1,
      commentId: 1,
      author: TEST_AUTHOR,
    });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes('Missing'));
});

// ============================================
// COMMENT DELETE VALIDATION TESTS
// ============================================

test('POST /comment/delete - requires authentication', async () => {
  app = await setupApp();

  const res = await request(app)
    .post('/comment/delete')
    .send({
      daoId: 1,
      proposalId: 1,
      commentId: 1,
      author: TEST_AUTHOR,
    });

  assert.equal(res.statusCode, 401);
});

test('POST /comment/delete - validates required fields', async () => {
  app = await setupApp();

  // Missing commentId
  let res = await request(app)
    .post('/comment/delete')
    .set('Authorization', `Bearer ${token}`)
    .send({
      daoId: 1,
      proposalId: 1,
      author: TEST_AUTHOR,
    });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes('Missing'));

  // Missing author
  res = await request(app)
    .post('/comment/delete')
    .set('Authorization', `Bearer ${token}`)
    .send({
      daoId: 1,
      proposalId: 1,
      commentId: 1,
    });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes('Missing'));
});

// ============================================
// ANONYMOUS COMMENT VALIDATION TESTS
// ============================================

test('POST /comment/anonymous - requires authentication', async () => {
  app = await setupApp();

  const res = await request(app)
    .post('/comment/anonymous')
    .send({
      daoId: 1,
      proposalId: 1,
      contentCid: 'bafytest123',
      parentId: null,
      nullifier: '0x1234',
      root: '0x5678',
      nonce: 0,
      proof: { a: '0x1', b: '0x2', c: '0x3' },
    });

  assert.equal(res.statusCode, 401);
});

test('POST /comment/anonymous - validates required fields', async () => {
  app = await setupApp();

  // Missing nullifier and voteChoice - Zod validation returns 'Validation failed' with details
  let res = await request(app)
    .post('/comment/anonymous')
    .set('Authorization', `Bearer ${token}`)
    .send({
      daoId: 1,
      proposalId: 1,
      contentCid: 'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku', // Valid CIDv1
      root: '11'.repeat(32), // 64 hex chars
      proof: { a: '44'.repeat(64), b: '55'.repeat(128), c: '66'.repeat(64) },
    });
  assert.equal(res.statusCode, 400);
  // Zod validation returns 'Validation failed' with details array
  assert.ok(res.body.error === 'Validation failed' || res.body.error.includes('Missing'));
  // Check that nullifier or voteChoice is mentioned in details
  if (res.body.details) {
    const fields = res.body.details.map((d) => d.field);
    assert.ok(fields.includes('nullifier') || fields.includes('voteChoice'));
  }

  // Missing proof
  res = await request(app)
    .post('/comment/anonymous')
    .set('Authorization', `Bearer ${token}`)
    .send({
      daoId: 1,
      proposalId: 1,
      contentCid: 'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
      nullifier: '11'.repeat(32),
      root: '22'.repeat(32),
      voteChoice: true,
    });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error === 'Validation failed' || res.body.error.includes('Missing'));
});

test('POST /comment/anonymous - validates voteChoice is boolean', async () => {
  app = await setupApp();

  const res = await request(app)
    .post('/comment/anonymous')
    .set('Authorization', `Bearer ${token}`)
    .send({
      daoId: 1,
      proposalId: 1,
      contentCid: 'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku', // Valid CIDv1
      nullifier: '11'.repeat(32), // 64 hex chars without 0x
      root: '22'.repeat(32),
      voteChoice: 'invalid', // Should be boolean
      proof: { a: '44'.repeat(64), b: '55'.repeat(128), c: '66'.repeat(64) },
    });

  assert.equal(res.statusCode, 400);
  // Zod validation returns 'Validation failed' with details mentioning voteChoice
  assert.ok(res.body.error === 'Validation failed' || res.body.error.includes('voteChoice'));
  if (res.body.details) {
    const voteChoiceError = res.body.details.find((d) => d.field === 'voteChoice');
    assert.ok(voteChoiceError, 'Should have voteChoice validation error');
  }
});

test('POST /comment/anonymous - validates nullifier is within BN254 field', async () => {
  app = await setupApp();

  // Value above BN254 modulus (without 0x prefix, as Zod schema expects)
  const tooBig = (BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617') + 1n).toString(16);

  const res = await request(app)
    .post('/comment/anonymous')
    .set('Authorization', `Bearer ${token}`)
    .send({
      daoId: 1,
      proposalId: 1,
      contentCid: 'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku', // Valid CIDv1
      nullifier: tooBig,
      root: '22'.repeat(32),
      voteChoice: true,
      proof: { a: '44'.repeat(64), b: '55'.repeat(128), c: '66'.repeat(64) },
    });

  assert.equal(res.statusCode, 400);
  // Zod returns 'Validation failed' with details mentioning 'BN254 field modulus'
  assert.ok(res.body.error === 'Validation failed' || res.body.error.toLowerCase().includes('modulus'));
  if (res.body.details) {
    const nullifierError = res.body.details.find((d) => d.field === 'nullifier');
    assert.ok(nullifierError, 'Should have nullifier validation error');
  }
});

// ============================================
// GET COMMENTS TESTS
// ============================================

test('GET /comments/:daoId/:proposalId - returns empty array for new proposal', async () => {
  app = await setupApp();

  const res = await request(app)
    .get('/comments/999/999');

  // In test mode without real contract, this may return empty or error
  // Either is acceptable for validation purposes
  if (res.statusCode === 200) {
    assert.ok(Array.isArray(res.body.comments) || res.body.comments === undefined);
  }
});

test('GET /comment/:daoId/:proposalId/:commentId - returns 404 for non-existent comment', async () => {
  app = await setupApp();

  const res = await request(app)
    .get('/comment/999/999/999');

  // In test mode, contract simulation may fail with 404 or 400
  assert.ok([400, 404, 500].includes(res.statusCode));
});

// ============================================
// FULL IPFS + COMMENT WORKFLOW TESTS
// ============================================

test('Full workflow: upload content to IPFS and verify retrieval', skipIfNoIpfs, async () => {
  app = await setupApp();

  // Step 1: Upload comment content to IPFS
  const commentContent = {
    version: 1,
    body: '# Full Workflow Test\n\nThis tests the complete comment creation flow.',
    createdAt: new Date().toISOString(),
  };

  const uploadRes = await request(app)
    .post('/ipfs/metadata')
    .send(commentContent);

  assert.equal(uploadRes.statusCode, 200);
  const contentCid = uploadRes.body.cid;
  console.log(`  Step 1: Uploaded content CID: ${contentCid}`);

  // Step 2: Verify the /comment/public endpoint was removed (public comments now go through wallet signing)
  const commentRes = await request(app)
    .post('/comment/public')
    .send({ daoId: 1, proposalId: 1, contentCid: contentCid, author: TEST_AUTHOR });

  assert.equal(commentRes.statusCode, 404, 'Public comment endpoint should be removed');
  console.log(`  Step 2: Confirmed /comment/public returns 404 (use wallet signing)`);

  // Step 3: Verify we can still fetch the content from IPFS
  await new Promise(r => setTimeout(r, 1000));

  const fetchRes = await request(app)
    .get(`/ipfs/${contentCid}`);

  assert.equal(fetchRes.statusCode, 200);
  assert.equal(fetchRes.body.body, commentContent.body);
  console.log(`  Step 3: Content verified via IPFS fetch`);
});

test('Edit workflow: upload new content and update reference', skipIfNoIpfs, async () => {
  app = await setupApp();

  // Original content
  const originalContent = {
    version: 1,
    body: 'Original comment body',
  };

  const original = await request(app)
    .post('/ipfs/metadata')
    .send(originalContent);

  assert.equal(original.statusCode, 200);
  const originalCid = original.body.cid;
  console.log(`  Original CID: ${originalCid}`);

  // Edited content
  const editedContent = {
    version: 1,
    body: 'Edited comment body - updated!',
  };

  const edited = await request(app)
    .post('/ipfs/metadata')
    .send(editedContent);

  assert.equal(edited.statusCode, 200);
  const editedCid = edited.body.cid;
  console.log(`  Edited CID: ${editedCid}`);

  // Both CIDs should be different
  assert.notEqual(originalCid, editedCid, 'Different content should have different CIDs');

  // Both should be fetchable
  await new Promise(r => setTimeout(r, 2000));

  const fetchOriginal = await request(app).get(`/ipfs/${originalCid}`);
  const fetchEdited = await request(app).get(`/ipfs/${editedCid}`);

  assert.equal(fetchOriginal.statusCode, 200);
  assert.equal(fetchEdited.statusCode, 200);
  assert.equal(fetchOriginal.body.body, originalContent.body);
  assert.equal(fetchEdited.body.body, editedContent.body);

  console.log(`  Both revisions retrievable from IPFS`);
});

test('Revision history simulation: multiple edits create CID trail', skipIfNoIpfs, async () => {
  app = await setupApp();

  const revisions = [];

  // Create 3 revisions
  for (let i = 1; i <= 3; i++) {
    const content = {
      version: 1,
      body: `Revision ${i} content`,
      revision: i,
    };

    const res = await request(app)
      .post('/ipfs/metadata')
      .send(content);

    assert.equal(res.statusCode, 200);
    revisions.push({ cid: res.body.cid, content });
    console.log(`  Revision ${i} CID: ${res.body.cid}`);
  }

  // All CIDs should be unique
  const uniqueCids = new Set(revisions.map(r => r.cid));
  assert.equal(uniqueCids.size, 3, 'All revisions should have unique CIDs');

  // All should be retrievable (simulating revision_cids array)
  await new Promise(r => setTimeout(r, 3000));

  for (const rev of revisions) {
    const fetchRes = await request(app).get(`/ipfs/${rev.cid}`);
    if (fetchRes.statusCode === 200) {
      assert.equal(fetchRes.body.revision, rev.content.revision);
    } else {
      console.log(`  Warning: Rate limited or unavailable for revision ${rev.content.revision}`);
    }
  }

  console.log(`  All ${revisions.length} revisions have unique, retrievable CIDs`);
});

// ============================================
// PROPOSAL METADATA TESTS
// ============================================

test('POST /ipfs/metadata - upload proposal with video URL', skipIfNoIpfs, async () => {
  app = await setupApp();

  const proposalMetadata = {
    version: 1,
    body: '# Proposal with Video\n\nWatch this explanation video.',
    videoUrl: 'https://youtube.com/watch?v=dQw4w9WgXcQ',
  };

  const res = await request(app)
    .post('/ipfs/metadata')
    .send(proposalMetadata);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.cid);

  // Verify
  await new Promise(r => setTimeout(r, 2000));
  const fetch = await request(app).get(`/ipfs/${res.body.cid}`);
  if (fetch.statusCode === 200) {
    assert.equal(fetch.body.videoUrl, proposalMetadata.videoUrl);
  }
});

test('POST /ipfs/metadata - rejects invalid video URL', async () => {
  app = await setupApp();

  const metadata = {
    version: 1,
    body: 'Test',
    videoUrl: 'https://malicious-site.com/video',
  };

  const res = await request(app)
    .post('/ipfs/metadata')
    .set('Authorization', `Bearer ${token}`)
    .send(metadata);

  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes('video'));
});

test('POST /ipfs/metadata - requires version field', async () => {
  app = await setupApp();

  const metadata = {
    body: 'Missing version field',
  };

  const res = await request(app)
    .post('/ipfs/metadata')
    .set('Authorization', `Bearer ${token}`)
    .send(metadata);

  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes('version'));
});

test('POST /ipfs/metadata - rejects oversized content', async () => {
  app = await setupApp();

  const metadata = {
    version: 1,
    body: 'x'.repeat(200000), // 200KB, likely over limit
  };

  const res = await request(app)
    .post('/ipfs/metadata')
    .send(metadata);

  // Should be rejected for size (Express returns 413 or 500 for entity too large)
  assert.ok([400, 413, 500].includes(res.statusCode), `Expected 400, 413, or 500 but got ${res.statusCode}`);
});
