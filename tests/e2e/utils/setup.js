/**
 * Test setup and teardown utilities
 */

import { loadContracts, checkRelayer, getAddress, ADMIN_KEY } from '../config.js';
import { generateKey } from './stellar.js';

/**
 * Test context object - holds shared state across tests
 */
export class TestContext {
  constructor() {
    this.contracts = null;
    this.adminAddress = null;
    this.testKeyName = null;
    this.testAddress = null;
    this.daoId = null;
    this.proposalId = null;
    this.credentials = null; // ZK credentials
  }
}

/**
 * Setup test environment
 * @returns {TestContext}
 */
export async function setupTests(options = {}) {
  const ctx = new TestContext();

  console.log('\n=== Test Setup ===\n');

  // Load contracts
  try {
    ctx.contracts = loadContracts();
    console.log('✓ Loaded contract IDs');
    console.log(`  Registry: ${ctx.contracts.REGISTRY_ID.slice(0, 10)}...`);
    console.log(`  Voting:   ${ctx.contracts.VOTING_ID.slice(0, 10)}...`);
  } catch (e) {
    console.error('✗ Failed to load contracts:', e.message);
    throw e;
  }

  // Get admin address
  ctx.adminAddress = getAddress(ADMIN_KEY);
  if (!ctx.adminAddress) {
    throw new Error(`Admin key '${ADMIN_KEY}' not found. Run: stellar keys generate ${ADMIN_KEY}`);
  }
  console.log(`✓ Admin address: ${ctx.adminAddress.slice(0, 10)}...`);

  // Check relayer if needed
  if (options.requireRelayer) {
    const relayerOk = await checkRelayer();
    if (!relayerOk) {
      throw new Error('Relayer not running. Start with: cd backend && npm run relayer');
    }
    console.log('✓ Relayer is running');
  }

  // Generate test key if needed
  if (options.generateTestKey) {
    const keyName = `test-e2e-${Date.now()}`;
    ctx.testKeyName = keyName;
    ctx.testAddress = generateKey(keyName, true);
    console.log(`✓ Test key: ${keyName}`);
  }

  console.log('\n');
  return ctx;
}

/**
 * Cleanup test environment
 */
export async function teardownTests(ctx) {
  console.log('\n=== Test Teardown ===\n');

  // Could add cleanup logic here if needed
  // For now, we leave test DAOs/proposals for debugging

  console.log('✓ Cleanup complete\n');
}

/**
 * Simple test assertion helper
 */
export function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

/**
 * Assert equals with nice error message
 */
export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

/**
 * Assert that async function throws
 */
export async function assertThrows(fn, expectedError = null) {
  try {
    await fn();
    throw new Error('Expected function to throw, but it did not');
  } catch (e) {
    if (expectedError && !e.message.includes(expectedError)) {
      throw new Error(`Expected error containing "${expectedError}", got: ${e.message}`);
    }
    return e;
  }
}

export default {
  TestContext,
  setupTests,
  teardownTests,
  assert,
  assertEqual,
  assertThrows,
};
