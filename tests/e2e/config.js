/**
 * ZKVote E2E Test Configuration
 *
 * Shared configuration for all e2e tests.
 * Reads contract IDs from frontend config.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// Network configuration - default to futurenet
// Note: Don't include :443 in URL - causes authentication issues with Stellar CLI
export const RPC_URL = process.env.RPC_URL || 'https://rpc-futurenet.stellar.org';
export const RELAYER_URL = process.env.RELAYER_URL || 'http://localhost:3001';
export const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || 'Test SDF Future Network ; October 2022';
export const ADMIN_KEY = process.env.ADMIN_KEY || 'mykey';
export const PROJECT_ROOT_PATH = PROJECT_ROOT;

/**
 * Load contract IDs from frontend config
 */
export function loadContracts() {
  const configPath = path.join(PROJECT_ROOT, 'frontend/src/config/contracts.ts');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Contract config not found at ${configPath}. Deploy contracts first.`);
  }

  const content = fs.readFileSync(configPath, 'utf-8');

  const extract = (key) => {
    const match = content.match(new RegExp(`${key}:\\s*["']([^"']+)["']`));
    if (!match) throw new Error(`Could not find ${key} in contracts.ts`);
    return match[1];
  };

  return {
    REGISTRY_ID: extract('REGISTRY_ID'),
    SBT_ID: extract('SBT_ID'),
    TREE_ID: extract('TREE_ID'),
    VOTING_ID: extract('VOTING_ID'),
    COMMENTS_ID: extract('COMMENTS_ID'),
  };
}

/**
 * Get Stellar address for a key name
 */
export function getAddress(keyName) {
  try {
    const result = execSync(`stellar keys address ${keyName}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Check if relayer is running
 */
export async function checkRelayer() {
  try {
    const response = await fetch(`${RELAYER_URL}/health`, {
      method: 'GET',
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * Get circuit artifacts path
 */
export function getCircuitsPath() {
  return path.join(PROJECT_ROOT, 'frontend/public/circuits');
}

export default {
  RPC_URL,
  RELAYER_URL,
  NETWORK_PASSPHRASE,
  ADMIN_KEY,
  PROJECT_ROOT_PATH,
  loadContracts,
  getAddress,
  checkRelayer,
  getCircuitsPath,
};
