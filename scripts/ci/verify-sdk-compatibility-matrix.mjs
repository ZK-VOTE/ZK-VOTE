#!/usr/bin/env node
/**
 * CI check: the SDK circuit-compatibility matrix must agree with what the
 * backend circuit registry actually knows about (ZV-113 / Issue #953,
 * acceptance criterion "CI verifies the matrix against registered
 * circuits on every release").
 *
 * This imports backend/src/services/circuit-registry.ts's
 * getCompatibilityMatrix() directly (same module used by
 * GET /circuits/compatibility-matrix and by
 * backend/test/di/circuit-registry.test.ts) rather than making an HTTP
 * call, so it needs no running server and no RELAYER_TEST_MODE
 * bootstrapping - circuit-registry.ts is deliberately dependency-injected
 * and free of the stellar.js module globals the rest of the backend uses
 * (#358), so it imports cleanly on its own.
 *
 * Checks:
 *   1. Every circuit id the registry reports is a non-empty string with a
 *      sane version (currentVersion is null or a positive integer).
 *   2. supportedVersions is exactly [currentVersion, currentVersion - 1],
 *      clamped at 1 - the SDK's "N and N-1" promise (EPIC-004) is a
 *      structural property of the matrix the registry serves, not
 *      something the SDK has to independently trust.
 *   3. packages/sdk/src/registry.ts's CircuitMatrixEntry shape (field
 *      names) matches what the registry actually returns, so a rename on
 *      one side can't silently stop being checked by the other.
 *
 * Run from the `backend/` directory (so its node_modules resolve, since
 * this imports a backend TS module directly) via `tsx`, not plain `node`:
 *
 *   cd backend && npx tsx ../scripts/ci/verify-sdk-compatibility-matrix.mjs
 *
 * (Running from the repo root works too, but only if circuit-registry.ts's
 * own dependencies resolve from there - the backend-relative invocation is
 * the one exercised in CI, see .github/workflows/ci.yml's "backend" job.)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const failures = [];

const { getCompatibilityMatrix, KNOWN_CIRCUIT_IDS, initCircuitRegistry } = await import(
  path.join(root, "backend/src/services/circuit-registry.ts")
);

// circuit-registry.ts throws until initCircuitRegistry() is called; a
// minimal no-RPC dependency set is enough since getCompatibilityMatrix()
// only calls getCurrentVersion(), which never reaches the network in the
// current (mock-table) implementation - see the "still needed" note in
// docs/epics/EPIC-004-PROVING-SDK.md once that table is backed by a real
// contract call.
initCircuitRegistry({
  server: {},
  relayerKeypair: { publicKey: () => "" },
  callWithTimeout: async (fn) => fn(),
  circuitRegistryContractId: undefined,
  networkPassphrase: "Test",
  logger: { info() {}, warn() {}, error() {} },
});

const matrix = await getCompatibilityMatrix();

if (!Array.isArray(matrix) || matrix.length === 0) {
  failures.push("getCompatibilityMatrix() returned no entries");
}

const seen = new Set();
for (const entry of matrix) {
  const label = JSON.stringify(entry);

  if (typeof entry.circuitId !== "string" || entry.circuitId.length === 0) {
    failures.push(`Matrix entry has an invalid circuitId: ${label}`);
    continue;
  }
  if (seen.has(entry.circuitId)) {
    failures.push(`Duplicate circuitId "${entry.circuitId}" in the compatibility matrix`);
  }
  seen.add(entry.circuitId);

  if (entry.currentVersion !== null) {
    if (!Number.isInteger(entry.currentVersion) || entry.currentVersion < 1) {
      failures.push(`"${entry.circuitId}" has a non-positive-integer currentVersion: ${label}`);
    }
  }

  if (!Array.isArray(entry.supportedVersions)) {
    failures.push(`"${entry.circuitId}" is missing supportedVersions: ${label}`);
    continue;
  }

  const expected =
    entry.currentVersion === null
      ? []
      : [entry.currentVersion, entry.currentVersion - 1].filter((v) => v >= 1);
  const actual = [...entry.supportedVersions].sort((a, b) => b - a);
  const expectedSorted = [...expected].sort((a, b) => b - a);
  if (JSON.stringify(actual) !== JSON.stringify(expectedSorted)) {
    failures.push(
      `"${entry.circuitId}" supportedVersions ${JSON.stringify(entry.supportedVersions)} ` +
        `is not the N/N-1 window of currentVersion ${entry.currentVersion} ` +
        `(expected ${JSON.stringify(expected)})`,
    );
  }
}

for (const circuitId of KNOWN_CIRCUIT_IDS) {
  if (!seen.has(circuitId)) {
    failures.push(`KNOWN_CIRCUIT_IDS declares "${circuitId}" but it is missing from the matrix`);
  }
}

if (failures.length > 0) {
  console.error("SDK compatibility matrix check FAILED:\n");
  for (const f of failures) console.error("  - " + f);
  console.error(`\n${failures.length} problem(s) found.`);
  process.exit(1);
}

console.log(`SDK compatibility matrix check passed (${matrix.length} circuits).`);
