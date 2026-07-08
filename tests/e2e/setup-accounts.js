#!/usr/bin/env node
/**
 * Setup script for pre-funded e2e test accounts
 *
 * Creates and funds persistent test accounts that can be reused across test runs.
 * Gracefully handles already-funded accounts.
 *
 * Run: node tests/e2e/setup-accounts.js
 */

import { execSync } from 'node:child_process';
import { RPC_URL, NETWORK_PASSPHRASE, ADMIN_KEY } from './config.js';

const NETWORK_FLAGS = `--rpc-url "${RPC_URL}" --network-passphrase "${NETWORK_PASSPHRASE}"`;

// Pre-defined test accounts that persist across runs
export const TEST_ACCOUNTS = {
  // Main admin account (uses existing ADMIN_KEY from config)
  admin: ADMIN_KEY,
  // Test member accounts for e2e tests
  member1: 'e2e-member-1',
  member2: 'e2e-member-2',
  member3: 'e2e-member-3',
};

/**
 * Check if a key exists
 */
function keyExists(keyName) {
  try {
    execSync(`stellar keys address ${keyName}`, { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get address for a key
 */
function getAddress(keyName) {
  try {
    return execSync(`stellar keys address ${keyName}`, { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Generate a new key (if not exists)
 */
function generateKey(keyName) {
  if (keyExists(keyName)) {
    console.log(`  ✓ Key ${keyName} already exists`);
    return getAddress(keyName);
  }

  execSync(`stellar keys generate ${keyName}`, { encoding: 'utf-8' });
  console.log(`  ✓ Generated key ${keyName}`);
  return getAddress(keyName);
}

/**
 * Fund a key via friendbot (handles already-funded gracefully)
 */
function fundKey(keyName) {
  try {
    execSync(`stellar keys fund ${keyName} ${NETWORK_FLAGS}`, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: 'pipe'
    });
    console.log(`  ✓ Funded ${keyName}`);
    return true;
  } catch (e) {
    const msg = e.message || e.stdout || e.stderr || '';
    if (msg.includes('already funded') || msg.includes('createAccountAlreadyExist') || msg.includes('account already exists')) {
      console.log(`  ✓ ${keyName} already funded`);
      return true;
    }
    console.log(`  ⚠ Could not fund ${keyName}: ${msg.slice(0, 100)}`);
    return false;
  }
}

/**
 * Setup all test accounts
 */
async function setupAccounts() {
  console.log('\n=== Setting up E2E Test Accounts ===\n');
  console.log(`Network: ${RPC_URL}`);
  console.log(`Passphrase: ${NETWORK_PASSPHRASE.slice(0, 20)}...`);
  console.log();

  const results = {};

  for (const [name, keyName] of Object.entries(TEST_ACCOUNTS)) {
    console.log(`Setting up ${name} (${keyName}):`);
    const address = generateKey(keyName);
    if (address) {
      fundKey(keyName);
      results[name] = { keyName, address };
      console.log(`    Address: ${address.slice(0, 10)}...${address.slice(-10)}`);
    }
    console.log();
  }

  console.log('=== Account Setup Complete ===\n');
  console.log('Accounts ready for testing:');
  for (const [name, info] of Object.entries(results)) {
    console.log(`  ${name}: ${info.keyName} -> ${info.address.slice(0, 15)}...`);
  }
  console.log();

  return results;
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  setupAccounts().catch(e => {
    console.error('Setup failed:', e);
    process.exit(1);
  });
}

export { setupAccounts, keyExists, getAddress, generateKey, fundKey };
