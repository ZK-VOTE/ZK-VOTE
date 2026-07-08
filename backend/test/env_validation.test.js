import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const relayerPath = join(__dirname, '..', 'src', 'relayer.js');

const baseEnv = {
  RELAYER_TEST_MODE: 'true',
  TREE_CONTRACT_ID: 'C'.padEnd(56, 'B'),
  SOROBAN_RPC_URL: 'http://localhost',
  NETWORK_PASSPHRASE: 'Test',
  RELAYER_SECRET_KEY: 'SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF',
};

function runRelayer(extraEnv) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [relayerPath], {
      env: { ...process.env, ...baseEnv, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: '/tmp', // avoid picking up repo .env files
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('exits when VOTING_CONTRACT_ID missing', async () => {
  const { code } = await runRelayer({ VOTING_CONTRACT_ID: '' });
  assert.equal(code, 1);
});

test('exits when contract id is invalid', async () => {
  const { code } = await runRelayer({ VOTING_CONTRACT_ID: 'bad', TREE_CONTRACT_ID: 'bad' });
  assert.equal(code, 1);
});
