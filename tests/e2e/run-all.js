#!/usr/bin/env node
/**
 * ZKVote E2E Test Runner
 *
 * Master test runner that executes all e2e test suites.
 *
 * Usage:
 *   node run-all.js                    # Run all tests
 *   node run-all.js --filter=zkproof   # Run only zkproof tests
 *   node run-all.js --filter=comment   # Run only comment tests
 *   node run-all.js --list             # List available tests
 *
 * Prerequisites:
 *   - Contracts deployed to futurenet
 *   - Relayer running (for some tests)
 *   - Circuit artifacts in frontend/public/circuits/
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test suite definitions
const TESTS = [
  {
    name: 'dao-lifecycle',
    file: './tests/dao-lifecycle.test.js',
    description: 'DAO creation, membership, and basic operations',
    requiresRelayer: false,
  },
  {
    name: 'proposal-voting',
    file: './tests/proposal-voting.test.js',
    description: 'Proposal creation and public voting',
    requiresRelayer: false,
  },
  {
    name: 'zkproof-voting',
    file: './tests/zkproof-voting.test.js',
    description: 'Anonymous voting with real Groth16 proofs',
    requiresRelayer: true,
  },
  {
    name: 'member-revocation',
    file: './tests/member-revocation.test.js',
    description: 'Revoked member cannot vote on snapshot proposals',
    requiresRelayer: true,
  },
  {
    name: 'comment-system',
    file: './tests/comment-system.test.js',
    description: 'Comment creation, editing, and deletion',
    requiresRelayer: true,
  },
];

// Parse command line args
const args = process.argv.slice(2);
const filterArg = args.find(a => a.startsWith('--filter='));
const filter = filterArg ? filterArg.split('=')[1] : null;
const listOnly = args.includes('--list');
const verbose = args.includes('--verbose') || args.includes('-v');

/**
 * Run a single test file
 */
async function runTest(test) {
  const testPath = path.join(__dirname, test.file);

  if (!fs.existsSync(testPath)) {
    return {
      name: test.name,
      success: false,
      skipped: true,
      error: `Test file not found: ${test.file}`,
      duration: 0,
    };
  }

  return new Promise((resolve) => {
    const startTime = Date.now();
    const child = spawn('node', ['--test', testPath], {
      cwd: __dirname,
      stdio: verbose ? 'inherit' : 'pipe',
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    let stdout = '';
    let stderr = '';

    if (!verbose) {
      child.stdout?.on('data', (data) => { stdout += data; });
      child.stderr?.on('data', (data) => { stderr += data; });
    }

    child.on('close', (code) => {
      const duration = Date.now() - startTime;
      resolve({
        name: test.name,
        success: code === 0,
        skipped: false,
        error: code !== 0 ? (stderr || stdout || `Exit code ${code}`) : null,
        duration,
        output: verbose ? null : stdout,
      });
    });

    child.on('error', (err) => {
      resolve({
        name: test.name,
        success: false,
        skipped: false,
        error: err.message,
        duration: Date.now() - startTime,
      });
    });
  });
}

/**
 * Main entry point
 */
async function main() {
  console.log('\n╔═══════════════════════════════════════════╗');
  console.log('║       ZKVote E2E Test Runner              ║');
  console.log('╚═══════════════════════════════════════════╝\n');

  // List mode
  if (listOnly) {
    console.log('Available test suites:\n');
    for (const test of TESTS) {
      const exists = fs.existsSync(path.join(__dirname, test.file));
      const status = exists ? '✓' : '○';
      console.log(`  ${status} ${test.name.padEnd(20)} ${test.description}`);
      if (test.requiresRelayer) {
        console.log(`    ${''.padEnd(20)} (requires relayer)`);
      }
    }
    console.log('\n  ✓ = implemented, ○ = not yet implemented\n');
    return;
  }

  // Filter tests
  let testsToRun = TESTS;
  if (filter) {
    testsToRun = TESTS.filter(t => t.name.includes(filter));
    if (testsToRun.length === 0) {
      console.error(`No tests matching filter: ${filter}`);
      console.log('Available tests:', TESTS.map(t => t.name).join(', '));
      process.exit(1);
    }
    console.log(`Running ${testsToRun.length} test(s) matching "${filter}"\n`);
  } else {
    console.log(`Running ${testsToRun.length} test suite(s)\n`);
  }

  // Run tests
  const results = [];
  for (const test of testsToRun) {
    process.stdout.write(`  ○ ${test.name}...`);

    const result = await runTest(test);
    results.push(result);

    // Clear the line and print result
    process.stdout.write('\r');
    if (result.skipped) {
      console.log(`  ○ ${test.name} (skipped - ${result.error})`);
    } else if (result.success) {
      console.log(`  ✓ ${test.name} (${result.duration}ms)`);
    } else {
      console.log(`  ✗ ${test.name} (${result.duration}ms)`);
      if (!verbose && result.error) {
        // Show first few lines of error
        const errorLines = result.error.split('\n').slice(0, 5);
        errorLines.forEach(line => console.log(`      ${line}`));
        if (result.error.split('\n').length > 5) {
          console.log('      ...(run with --verbose for full output)');
        }
      }
    }
  }

  // Summary
  console.log('\n' + '─'.repeat(45));

  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success && !r.skipped).length;
  const skipped = results.filter(r => r.skipped).length;
  const totalTime = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`Total time: ${(totalTime / 1000).toFixed(1)}s\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
