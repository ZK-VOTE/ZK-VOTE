/**
 * DAO Lifecycle E2E Tests
 *
 * Tests the full DAO lifecycle:
 * - DAO creation
 * - Membership management (mint, revoke SBTs)
 * - Commitment registration
 * - Admin operations
 *
 * Run: node --test tests/e2e/tests/dao-lifecycle.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadContracts, getAddress, ADMIN_KEY } from '../config.js';
import { callContract, generateKey } from '../utils/stellar.js';
import { generateCredentials } from '../utils/zkproof.js';

// Use pre-funded test member account to avoid friendbot issues
const TEST_MEMBER_KEY = 'e2e-member-1';

// Retry configuration for eventual consistency
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const MAX_RETRIES = 5;
const RETRY_DELAY = 2000; // 2 seconds between retries

/**
 * Retry a function until it succeeds or max retries exceeded
 */
async function withRetry(fn, description) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      const errorMsg = error.message || '';
      // Only retry on DaoNotFound (#2) or similar eventual consistency errors
      if (errorMsg.includes('Error(Contract, #2)') ||
          errorMsg.includes('Error(Contract, #3)') ||
          errorMsg.includes('Error(Contract, #8)')) {
        console.log(`    Retry ${attempt}/${MAX_RETRIES} for ${description} (eventual consistency)...`);
        await delay(RETRY_DELAY);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

test('DAO Lifecycle', async (t) => {
  console.log('\n=== DAO Lifecycle Tests ===\n');

  const contracts = loadContracts();
  const adminAddress = getAddress(ADMIN_KEY);

  if (!adminAddress) {
    throw new Error(`Admin key '${ADMIN_KEY}' not found`);
  }

  console.log(`Admin: ${adminAddress.slice(0, 10)}...`);
  console.log(`Registry: ${contracts.REGISTRY_ID.slice(0, 10)}...\n`);

  // Use pre-funded test member key (created by setup-accounts.js)
  const testMemberKey = TEST_MEMBER_KEY;
  const testMemberAddress = generateKey(testMemberKey, true);

  let testDaoId;

  // Step 1: Create DAO
  await t.test('create DAO', async () => {
    const daoName = `Test DAO ${Date.now()}`;

    const result = callContract(contracts.REGISTRY_ID, 'create_dao', {
      name: `"${daoName}"`,
      creator: adminAddress,
      membership_open: false,
      members_can_propose: true,
    });

    testDaoId = parseInt(result, 10);
    assert.ok(!isNaN(testDaoId), 'Should return valid DAO ID');
    console.log(`  Created DAO ${testDaoId}: "${daoName}"`);
  });

  // Step 2: Get DAO info (with retry for eventual consistency)
  await t.test('get DAO info', async () => {
    const result = await withRetry(() => {
      return callContract(contracts.REGISTRY_ID, 'get_dao', {
        dao_id: testDaoId,
      });
    }, 'get_dao');

    assert.ok(result.includes(adminAddress.slice(0, 10)), 'Should contain admin address');
    console.log(`  DAO info retrieved`);
  });

  // Step 3: Init Merkle tree (with retry for cross-contract consistency)
  await t.test('init Merkle tree', async () => {
    await withRetry(() => {
      callContract(contracts.TREE_ID, 'init_tree', {
        dao_id: testDaoId,
        depth: 18,
        admin: adminAddress,
      });
    }, 'init_tree');

    console.log(`  Merkle tree initialized`);
  });

  // Step 4: Mint SBT to member (with retry for cross-contract consistency)
  await t.test('mint SBT to member', async () => {
    await withRetry(() => {
      callContract(contracts.SBT_ID, 'mint', {
        dao_id: testDaoId,
        to: testMemberAddress,
        admin: adminAddress,
      });
    }, 'mint');

    console.log(`  Minted SBT to ${testMemberAddress.slice(0, 10)}...`);
  });

  // Step 5: Check member has SBT (with polling for eventual consistency)
  await t.test('check member has SBT', async () => {
    let result;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      result = callContract(contracts.SBT_ID, 'has', {
        dao_id: testDaoId,
        of: testMemberAddress,
      });
      if (result.trim() === 'true') break;
      console.log(`    Retry ${attempt}/${MAX_RETRIES} for has() check...`);
      await delay(RETRY_DELAY);
    }

    assert.strictEqual(result.trim(), 'true', 'Member should have SBT');
    console.log(`  Member has SBT: true`);
  });

  // Step 6: Register commitment (with retry)
  await t.test('register commitment', async () => {
    const { commitment } = await generateCredentials();

    await withRetry(() => {
      // commitment is a u256, no quotes needed
      callContract(contracts.TREE_ID, 'register_with_caller', {
        dao_id: testDaoId,
        commitment: commitment,
        caller: testMemberAddress,
      }, testMemberKey);
    }, 'register_with_caller');

    console.log(`  Registered commitment`);
  });

  // Step 7: Get Merkle root
  await t.test('get Merkle root', async () => {
    const result = callContract(contracts.TREE_ID, 'get_root', {
      dao_id: testDaoId,
    });

    assert.ok(result.length > 0, 'Should return root');
    console.log(`  Root: ${result.slice(0, 20)}...`);
  });

  // Step 8: Revoke membership (with retry for cross-contract consistency)
  await t.test('revoke membership', async () => {
    await withRetry(() => {
      callContract(contracts.SBT_ID, 'revoke', {
        dao_id: testDaoId,
        member: testMemberAddress,
        admin: adminAddress,
      });
    }, 'revoke');

    console.log(`  Revoked membership`);
  });

  // Step 9: Member no longer has SBT (with polling for eventual consistency)
  await t.test('member no longer has SBT', async () => {
    let result;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      result = callContract(contracts.SBT_ID, 'has', {
        dao_id: testDaoId,
        of: testMemberAddress,
      });
      if (result.trim() === 'false') break;
      console.log(`    Retry ${attempt}/${MAX_RETRIES} for has() check...`);
      await delay(RETRY_DELAY);
    }

    assert.strictEqual(result.trim(), 'false', 'Member should not have SBT');
    console.log(`  Member has SBT: false`);
  });
});
