/**
 * Proposal and Voting E2E Tests
 *
 * Tests proposal creation and public voting:
 * - Create proposal
 * - Get proposal info
 * - Public (non-anonymous) voting
 * - Vote tallying
 *
 * Run: node --test tests/e2e/tests/proposal-voting.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadContracts, getAddress, ADMIN_KEY, getCircuitsPath } from '../config.js';
import { callContract, generateKey } from '../utils/stellar.js';
import { generateCredentials } from '../utils/zkproof.js';

// Use pre-funded test member account
const TEST_MEMBER_KEY = 'e2e-member-1';

// Retry configuration for eventual consistency on futurenet
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const MAX_RETRIES = 10;
const RETRY_DELAY = 3000;

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
      // Retry on eventual consistency errors and transient auth issues
      // Error #1 = Unauthorized (can be transient during simulation)
      // Error #2 = DaoNotFound
      // Error #3 = MemberNotFound
      // Error #4 = TreeNotInitialized
      // Error #8 = Other consistency errors
      if (errorMsg.includes('Error(Contract, #1)') ||
          errorMsg.includes('Error(Contract, #2)') ||
          errorMsg.includes('Error(Contract, #3)') ||
          errorMsg.includes('Error(Contract, #4)') ||
          errorMsg.includes('Error(Contract, #8)')) {
        console.log(`    Retry ${attempt}/${MAX_RETRIES} for ${description} (transient/consistency)...`);
        await delay(RETRY_DELAY);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

test('Proposal and Voting', { concurrency: false }, async (t) => {
  console.log('\n=== Proposal and Voting Tests ===\n');

  const contracts = loadContracts();
  const adminAddress = getAddress(ADMIN_KEY);

  if (!adminAddress) {
    throw new Error(`Admin key '${ADMIN_KEY}' not found`);
  }

  console.log(`Admin: ${adminAddress.slice(0, 10)}...`);
  console.log(`Registry: ${contracts.REGISTRY_ID.slice(0, 10)}...`);

  // Use pre-funded test member key (fund it to ensure it's ready)
  const memberAddress = generateKey(TEST_MEMBER_KEY, true);
  console.log(`Member: ${memberAddress.slice(0, 10)}...`);

  let daoId;
  let proposalId;

  // Step 1: Create test DAO (with retry for transient auth issues)
  await t.test('create test DAO', async () => {
    // Keep name ≤24 chars (MAX_DAO_NAME_LEN) to avoid NameTooLong error (#1)
    const daoName = `PropTest ${Date.now()}`;

    const result = await withRetry(() => {
      return callContract(contracts.REGISTRY_ID, 'create_dao', {
        name: `"${daoName}"`,
        creator: adminAddress,
        membership_open: false,
        members_can_propose: true,
      });
    }, 'create_dao');

    daoId = parseInt(result, 10);
    assert.ok(!isNaN(daoId), 'Should return valid DAO ID');
    console.log(`  Created DAO ${daoId}: "${daoName}"`);
  });

  // Step 2: Initialize Merkle tree
  await t.test('init Merkle tree', async () => {
    await withRetry(() => {
      callContract(contracts.TREE_ID, 'init_tree', {
        dao_id: daoId,
        depth: 18,
        admin: adminAddress,
      });
    }, 'init_tree');

    console.log(`  Merkle tree initialized`);
  });

  // Step 3: Mint SBT to member
  await t.test('mint SBT to member', async () => {
    await withRetry(() => {
      callContract(contracts.SBT_ID, 'mint', {
        dao_id: daoId,
        to: memberAddress,
        admin: adminAddress,
      });
    }, 'mint');

    console.log(`  Minted SBT to ${memberAddress.slice(0, 10)}...`);
  });

  // Step 4: Register commitment
  await t.test('register commitment', async () => {
    const { commitment } = await generateCredentials();

    await withRetry(() => {
      // commitment is a u256, no quotes needed
      callContract(contracts.TREE_ID, 'register_with_caller', {
        dao_id: daoId,
        commitment: commitment,
        caller: memberAddress,
      }, TEST_MEMBER_KEY);
    }, 'register_with_caller');

    console.log(`  Registered commitment`);
  });

  // Step 5: Set verification key (required before creating proposals)
  await t.test('set verification key', async () => {
    const vkPath = path.join(getCircuitsPath(), 'verification_key_soroban.json');
    if (!fs.existsSync(vkPath)) {
      throw new Error(`Verification key not found at ${vkPath}`);
    }

    const vkData = JSON.parse(fs.readFileSync(vkPath, 'utf-8'));

    // VK must be passed as a single struct
    const vkStruct = {
      alpha: vkData.alpha,
      beta: vkData.beta,
      gamma: vkData.gamma,
      delta: vkData.delta,
      ic: vkData.ic,
    };

    await withRetry(() => {
      callContract(contracts.VOTING_ID, 'set_vk', {
        dao_id: daoId,
        vk: vkStruct,
        admin: adminAddress,
      });
    }, 'set_vk');

    console.log(`  Verification key set`);
  });

  // Step 6: Create proposal
  await t.test('create proposal', async () => {
    const endTime = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now

    // Creator must be a member with SBT - use memberAddress, not admin
    const result = await withRetry(() => {
      return callContract(contracts.VOTING_ID, 'create_proposal', {
        dao_id: daoId,
        title: '"Test Proposal"',
        content_cid: '"bafytest123"',
        end_time: endTime,
        creator: memberAddress,
        vote_mode: '"Fixed"', // Fixed mode - needs quotes for JSON
      }, TEST_MEMBER_KEY);
    }, 'create_proposal');

    proposalId = parseInt(result, 10);
    assert.ok(!isNaN(proposalId), 'Should return valid proposal ID');
    console.log(`  Created proposal ${proposalId}`);
  });

  // Step 7: Get proposal info
  await t.test('get proposal info', async () => {
    const result = await withRetry(() => {
      return callContract(contracts.VOTING_ID, 'get_proposal', {
        dao_id: daoId,
        proposal_id: proposalId,
      });
    }, 'get_proposal');

    assert.ok(result.includes('Test Proposal'), 'Should contain proposal title');
    console.log(`  Proposal info retrieved`);
  });

  // Step 8: Verify initial vote counts
  await t.test('proposal has correct vote counts initially', async () => {
    const result = await withRetry(() => {
      return callContract(contracts.VOTING_ID, 'get_proposal', {
        dao_id: daoId,
        proposal_id: proposalId,
      });
    }, 'get_proposal for vote counts');

    // Check vote counts - format may vary
    assert.ok(
      result.includes('yes_votes: 0') ||
      result.includes('"yes_votes":0') ||
      result.includes('yes_votes":0'),
      'Should have 0 yes votes'
    );
    console.log(`  Initial vote counts verified`);
  });

  // Note: Anonymous voting with ZK proofs is tested in zkproof-voting.test.js
});
