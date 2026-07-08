/**
 * IPFS/Pinata Integration Tests
 *
 * These tests verify the full upload and retrieval cycle with Pinata.
 * Requires PINATA_JWT environment variable to be set.
 *
 * Run with: npm test -- test/ipfs.test.js
 */

import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { initPinata, pinJSON, pinFile, fetchContent, isValidCid, isHealthy } from '../src/services/ipfs.ts';

// Skip tests if no JWT configured
const PINATA_JWT = process.env.PINATA_JWT;
const skipIfNoJwt = !PINATA_JWT ? { skip: 'PINATA_JWT not configured' } : {};

test('isValidCid validates CIDv0 format', () => {
  // Valid CIDv0 (Qm...)
  assert.equal(isValidCid('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'), true);

  // Invalid - too short
  assert.equal(isValidCid('QmYwAPJzv5CZsnA625s3Xf2nemtYg'), false);

  // Invalid - wrong prefix
  assert.equal(isValidCid('XmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'), false);
});

test('isValidCid validates CIDv1 format', () => {
  // Valid CIDv1 (bafy... or bafk...)
  assert.equal(isValidCid('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'), true);
  assert.equal(isValidCid('bafkreigys4ks7ro3etlgwwyub7bdh72o5ag7rag66lazjoemayhq7gesvu'), true);

  // Invalid - too short
  assert.equal(isValidCid('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3'), false);

  // Invalid - null/undefined
  assert.equal(isValidCid(null), false);
  assert.equal(isValidCid(undefined), false);
  assert.equal(isValidCid(''), false);
});

test('initPinata throws without JWT', () => {
  assert.throws(() => initPinata(null), /PINATA_JWT is required/);
  assert.throws(() => initPinata(''), /PINATA_JWT is required/);
});

test('initPinata succeeds with valid JWT', skipIfNoJwt, () => {
  // Should not throw
  initPinata(PINATA_JWT);
});

test('isHealthy returns true when properly configured', skipIfNoJwt, async () => {
  initPinata(PINATA_JWT);
  const healthy = await isHealthy();
  assert.equal(healthy, true);
});

test('pinJSON uploads and returns valid CID', skipIfNoJwt, async () => {
  initPinata(PINATA_JWT);

  const testData = {
    version: 1,
    body: 'Test proposal content',
    timestamp: Date.now(),
  };

  const result = await pinJSON(testData, 'zkvote-test-metadata');

  assert.ok(result.cid, 'Should return a CID');
  assert.equal(isValidCid(result.cid), true, 'CID should be valid format');
  console.log(`  Uploaded JSON CID: ${result.cid}`);
});

test('pinFile uploads image and returns valid CID', skipIfNoJwt, async () => {
  initPinata(PINATA_JWT);

  // Create a small test image (1x1 red PNG)
  const pngBuffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
    0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xaa, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);

  const result = await pinFile(pngBuffer, 'test-image.png', 'image/png');

  assert.ok(result.cid, 'Should return a CID');
  assert.equal(isValidCid(result.cid), true, 'CID should be valid format');
  console.log(`  Uploaded image CID: ${result.cid}`);
});

test('full upload and fetch cycle for JSON', skipIfNoJwt, async () => {
  initPinata(PINATA_JWT);

  // Upload
  const testData = {
    version: 1,
    body: '# Test Proposal\n\nThis is a **test** with markdown.',
    videoUrl: 'https://youtube.com/watch?v=test',
    testId: `test-${Date.now()}`,
  };

  const uploadResult = await pinJSON(testData, 'zkvote-roundtrip-test');
  assert.ok(uploadResult.cid, 'Upload should return CID');
  console.log(`  Uploaded CID: ${uploadResult.cid}`);

  // Longer delay to allow propagation and avoid rate limiting
  await new Promise((r) => setTimeout(r, 5000));

  // Fetch with retry for rate limiting
  let fetchResult;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fetchResult = await fetchContent(uploadResult.cid);
      break;
    } catch (err) {
      lastError = err;
      if (err.message.includes('429')) {
        console.log(`  Rate limited, waiting ${(attempt + 1) * 3}s...`);
        await new Promise((r) => setTimeout(r, (attempt + 1) * 3000));
      } else {
        throw err;
      }
    }
  }

  if (!fetchResult) {
    // If still rate limited after retries, skip assertion but don't fail
    console.log(`  Skipping fetch assertion due to rate limiting: ${lastError?.message}`);
    return;
  }

  assert.ok(fetchResult.data, 'Fetch should return data');
  assert.equal(fetchResult.data.version, testData.version);
  assert.equal(fetchResult.data.body, testData.body);
  assert.equal(fetchResult.data.videoUrl, testData.videoUrl);
  assert.equal(fetchResult.data.testId, testData.testId);

  console.log(`  Fetch successful, content matches`);
});

test('fetchContent throws for invalid CID', skipIfNoJwt, async () => {
  initPinata(PINATA_JWT);

  await assert.rejects(
    () => fetchContent('invalid-cid'),
    /Invalid CID format/
  );
});

test('fetchContent handles non-existent CID gracefully', skipIfNoJwt, async () => {
  initPinata(PINATA_JWT);

  // Valid format but doesn't exist
  const fakeCid = 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  await assert.rejects(
    () => fetchContent(fakeCid),
    /Failed to fetch from IPFS|aborted/i
  );
});
