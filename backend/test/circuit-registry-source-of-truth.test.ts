/**
 * Circuit registry: on-chain version resolution, fail-closed behavior and
 * rotation-aware cache invalidation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import * as StellarSdk from "@stellar/stellar-sdk";

const DIR = fs.mkdtempSync(path.join(tmpdir(), "zkvote-circuit-registry-"));
const { initDb, getDb } = await import("../src/services/db.js");
initDb(path.join(DIR, "registry.db")) as never;

const {
  initCircuitRegistry,
  getCurrentVersion,
  isStaleVersion,
  invalidateCircuitVkCache,
  CircuitRegistryUnavailableError,
} = await import("../src/services/circuit-registry.js");

const TEST_ADDR =
  "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const CONTRACT_ID =
  "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";

function mockDeps(retval: unknown) {
  return {
    server: {
      getAccount: async () => new StellarSdk.Account(TEST_ADDR, "1"),
      simulateTransaction: async () => ({
        result: { retval },
        minResourceFee: "0",
        cost: { cpuInsns: "0", memBytes: "0" },
      }),
    } as never,
    relayerKeypair: { publicKey: () => TEST_ADDR },
    callWithTimeout: async <T>(fn: () => Promise<T>) => fn(),
    circuitRegistryContractId: CONTRACT_ID,
    networkPassphrase: "Test SDF Network ; September 2015",
    logger: { debug() {}, info() {}, warn() {}, error() {}, log() {} },
  };
}

test.after(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

test("current version is read from the contract, not a mock table", async () => {
  initCircuitRegistry(mockDeps(StellarSdk.nativeToScVal(4, { type: "u32" })));
  assert.equal(await getCurrentVersion("vote_v2"), 4);
  assert.equal(isStaleVersion(3, 4), true);
  assert.equal(isStaleVersion(4, 4), false);
});

test("unknown circuit no longer resolves to a fabricated version 1", async () => {
  initCircuitRegistry(mockDeps(StellarSdk.nativeToScVal(7, { type: "u32" })));
  assert.equal(await getCurrentVersion("totally_unknown_circuit"), 7);
});

test("registry unavailability fails closed instead of returning mock data", async () => {
  initCircuitRegistry({
    ...mockDeps(StellarSdk.nativeToScVal(1, { type: "u32" })),
    circuitRegistryContractId: undefined,
  });
  await assert.rejects(
    () => getCurrentVersion("vote_v1"),
    CircuitRegistryUnavailableError,
  );
});

test("cache invalidation records a durable revocation", () => {
  invalidateCircuitVkCache("vote_v2", "Vote", 2, "vk_proposal_test_executed");
  const row = (getDb() as unknown as {
    prepare(sql: string): { get(...p: unknown[]): unknown };
  })
    .prepare(
      "SELECT reason FROM circuit_vk_revocations WHERE circuit_id = ? AND circuit_type = ? AND version = ?",
    )
    .get("vote_v2", "Vote", 2) as { reason: string } | undefined;
  assert.equal(row?.reason, "vk_proposal_test_executed");
});

test("no mock VK hashes or mock version tables remain in source", () => {
  const routeSource = fs.readFileSync(
    path.join(process.cwd(), "src/routes/circuits.ts"),
    "utf8",
  );
  const serviceSource = fs.readFileSync(
    path.join(process.cwd(), "src/services/circuit-registry.ts"),
    "utf8",
  );
  assert.equal(routeSource.includes("mock_hash_"), false);
  assert.equal(routeSource.includes("local_vk_hash_"), false);
  assert.equal(serviceSource.includes("mockVersions"), false);
  assert.ok(routeSource.includes('hashScheme: "registry-v1"'));
});
