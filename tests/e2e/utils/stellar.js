/**
 * Stellar/Soroban utilities for e2e tests
 */

import { execSync } from 'node:child_process';
import { RPC_URL, NETWORK_PASSPHRASE, ADMIN_KEY } from '../config.js';

// Build network flags - use explicit rpc-url and network-passphrase
// (--network futurenet has a bug in stellar CLI 23.x where it doesn't read passphrase from config)
const NETWORK_FLAGS = `--rpc-url "${RPC_URL}" --network-passphrase "${NETWORK_PASSPHRASE}"`;

// Retry configuration for transient failures
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// Helper to sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Check if error is retryable (transient network/sequence issues)
function isRetryableError(errorMsg) {
  const retryablePatterns = [
    'TxBadSeq',
    'tx_bad_seq',
    'TIMEOUT',
    'timeout',
    'ECONNRESET',
    'ECONNREFUSED',
    'socket hang up',
    'network error',
    '502 Bad Gateway',
    '503 Service Unavailable',
    '504 Gateway Timeout',
  ];
  return retryablePatterns.some(pattern => errorMsg.includes(pattern));
}

/**
 * Call a contract method via Stellar CLI with retry logic
 */
export function callContract(contractId, method, args = {}, source = ADMIN_KEY) {
  const argsList = Object.entries(args)
    .map(([key, value]) => {
      if (typeof value === 'object' && value !== null) {
        return `--${key} '${JSON.stringify(value)}'`;
      }
      if (typeof value === 'boolean') {
        return `--${key} ${value}`;
      }
      // For string values, handle quoting properly for shell
      const strVal = String(value);
      // If value is a JSON string (e.g., "Fixed" for enums), wrap in single quotes for shell
      if (strVal.startsWith('"') && strVal.endsWith('"')) {
        return `--${key} '${strVal}'`;
      }
      return `--${key} ${strVal}`;
    })
    .join(' ');

  // Use explicit rpc-url and network-passphrase flags
  const cmd = `stellar contract invoke \
    --id "${contractId}" \
    --source ${source} \
    ${NETWORK_FLAGS} \
    -- \
    ${method} \
    ${argsList} 2>&1`;

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = execSync(cmd, { encoding: 'utf-8', timeout: 120000 });
      // Filter out info messages, keep only the result
      const lines = result.split('\n').filter(line => !line.startsWith('ℹ️') && line.trim());
      return lines[lines.length - 1] || '';
    } catch (error) {
      const output = error.stdout || error.stderr || error.message;
      lastError = new Error(`Contract call failed: ${method}\n${output}`);

      if (attempt < MAX_RETRIES && isRetryableError(output)) {
        console.log(`    Retry ${attempt}/${MAX_RETRIES} for ${method} (transient error)...`);
        // Synchronous wait using Atomics for retry delay
        const start = Date.now();
        while (Date.now() - start < RETRY_DELAY_MS) {
          // Busy wait - not ideal but works for synchronous code
        }
        continue;
      }
      throw lastError;
    }
  }
  throw lastError;
}

/**
 * Query contract (read-only, no signing)
 */
export function queryContract(contractId, method, args = {}) {
  const argsList = Object.entries(args)
    .map(([key, value]) => {
      if (typeof value === 'object' && value !== null) {
        return `--${key} '${JSON.stringify(value)}'`;
      }
      // For string values, handle quoting properly for shell
      const strVal = String(value);
      // If value is a JSON string (e.g., "Fixed" for enums), wrap in single quotes for shell
      if (strVal.startsWith('"') && strVal.endsWith('"')) {
        return `--${key} '${strVal}'`;
      }
      return `--${key} ${strVal}`;
    })
    .join(' ');

  // Use explicit rpc-url and network-passphrase flags
  const cmd = `stellar contract invoke \
    --id "${contractId}" \
    --source ${ADMIN_KEY} \
    ${NETWORK_FLAGS} \
    --is-view \
    -- \
    ${method} \
    ${argsList} 2>&1`;

  try {
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
    const lines = result.split('\n').filter(line => !line.startsWith('ℹ️') && line.trim());
    return lines[lines.length - 1] || '';
  } catch (error) {
    const output = error.stdout || error.stderr || error.message;
    throw new Error(`Contract query failed: ${method}\n${output}`);
  }
}

/**
 * Generate a new keypair and optionally fund it
 * Gracefully handles already-existing and already-funded accounts
 */
export function generateKey(keyName, fund = true) {
  let keyExists = false;
  try {
    // Check if key exists
    execSync(`stellar keys address ${keyName}`, { encoding: 'utf-8', stdio: 'pipe' });
    keyExists = true;
  } catch {
    // Generate new key (stellar CLI no longer has --no-fund, it doesn't fund by default)
    execSync(`stellar keys generate ${keyName}`, { encoding: 'utf-8' });
    console.log(`  Generated key ${keyName}`);
  }

  if (fund) {
    try {
      // Use explicit rpc-url and network-passphrase
      execSync(`stellar keys fund ${keyName} ${NETWORK_FLAGS}`, { encoding: 'utf-8', timeout: 30000, stdio: 'pipe' });
      console.log(`  Funded ${keyName}`);
    } catch (e) {
      const msg = e.message || e.stdout || e.stderr || '';
      // Check if already funded - this is fine, not an error
      if (msg.includes('already funded') || msg.includes('createAccountAlreadyExist') || msg.includes('account already exists')) {
        // Silent - account is already funded, which is fine
      } else {
        console.log(`  Warning: Could not fund ${keyName}: ${msg.slice(0, 80)}`);
      }
    }
  }

  return execSync(`stellar keys address ${keyName}`, { encoding: 'utf-8' }).trim();
}

/**
 * Get address for a key
 */
export function getAddress(keyName) {
  try {
    return execSync(`stellar keys address ${keyName}`, { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

export default {
  callContract,
  queryContract,
  generateKey,
  getAddress,
};
