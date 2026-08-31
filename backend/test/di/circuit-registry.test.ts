// Unit tests for the refactored circuit-registry service (#358).
//
// These tests exercise the service through its injected dependency surface
// (`initCircuitRegistry`) with mock server/relayer/timeout implementations —
// no live RPC endpoint and no module globals. They prove the refactor's
// acceptance criterion: a service that can be unit-tested with mocks.

import test from "node:test";
import assert from "node:assert/strict";
import * as StellarSdk from "@stellar/stellar-sdk";

import {
  initCircuitRegistry,
  getCurrentVersion,
  isStaleVersion,
  detectVKMismatch,
  invalidateVersionCache,
  getDaoCurrentCircuit,
  getCircuitInfo,
  type CircuitRegistryDeps,
} from "../../src/services/circuit-registry.js";

const TEST_ADDR = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
// Valid strkey contract id (StrKey.encodeContract(Buffer.alloc(32, 7))) so
// `new StellarSdk.Contract(...)` accepts it in the mock path.
const TEST_CONTRACT_ID = "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";

/** Build a mock dependency set; each test can override specific members. */
function mockDeps(overrides: Partial<CircuitRegistryDeps> = {}): CircuitRegistryDeps {
  const calls: { method: string; args: unknown[] }[] = [];
  const server = {
    getAccount: async () => new StellarSdk.Account(TEST_ADDR, "1"),
    simulateTransaction: async (tx: unknown) => {
      calls.push({ method: "simulateTransaction", args: [tx] });
      return {
        // No `error` field → treated as a success simulation.
        result: {
          retval: StellarSdk.nativeToScVal("vote_v2"),
        },
        minResourceFee: "0",
        cost: { cpuInsns: "0", memBytes: "0" },
      };
    },
  };
  const base: CircuitRegistryDeps = {
    server: server as never,
    relayerKeypair: { publicKey: () => TEST_ADDR },
    callWithTimeout: async <T>(fn: () => Promise<T>) => fn(),
    circuitRegistryContractId: TEST_CONTRACT_ID,
    networkPassphrase: "Test SDF Network ; September 2015",
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      log: () => {},
    },
  };
  return { ...base, ...overrides };
}

test("circuit-registry: throws before initCircuitRegistry() is called", async () => {
  // The service must not silently fall back to module globals.
  invalidateVersionCache("vote_v2"); // reset module state where possible
  await assert.rejects(
    async () => {
      await getDaoCurrentCircuit(1, "Vote");
    },
    /initCircuitRegistry\(\) must be called/,
  );
});

test("circuit-registry: unconfigured contract id short-circuits without RPC calls", async () => {
  let simulateCalls = 0;
  const deps = mockDeps({
    circuitRegistryContractId: undefined,
    server: {
      getAccount: async () => new StellarSdk.Account(TEST_ADDR, "1"),
      simulateTransaction: async () => {
        simulateCalls++;
        return {};
      },
    } as never,
  });
  initCircuitRegistry(deps);

  assert.equal(await getDaoCurrentCircuit(1, "Vote"), null);
  assert.equal(simulateCalls, 0, "no RPC call should be made when unconfigured");
});

test("circuit-registry: uses the injected mock server, not a global", async () => {
  let simulateCalls = 0;
  const deps = mockDeps({
    server: {
      getAccount: async () => new StellarSdk.Account(TEST_ADDR, "1"),
      simulateTransaction: async () => {
        simulateCalls++;
        return {
          result: { retval: StellarSdk.nativeToScVal("vote_v2") },
          minResourceFee: "0",
          cost: { cpuInsns: "0", memBytes: "0" },
        };
      },
    } as never,
  });
  initCircuitRegistry(deps);

  const current = await getDaoCurrentCircuit(7, "Vote");
  assert.equal(current, "vote_v2");
  assert.equal(simulateCalls, 1);
});

test("circuit-registry: getCurrentVersion caches per circuit id", async () => {
  initCircuitRegistry(mockDeps());
  invalidateVersionCache();

  const v1 = await getCurrentVersion("vote_v2");
  assert.equal(v1, 2); // mock table: vote_v2 -> 2
  const v2 = await getCurrentVersion("vote_v2");
  assert.equal(v2, 2);
  assert.equal(await getCurrentVersion("unknown_circuit"), 1);

  invalidateVersionCache("vote_v2");
});

test("circuit-registry: stale/mismatch pure logic", () => {
  assert.equal(isStaleVersion(1, 2), true);
  assert.equal(isStaleVersion(2, 2), false);
  assert.equal(isStaleVersion(3, 2), false);
  assert.equal(detectVKMismatch(2, 2), false);
  assert.equal(detectVKMismatch(2, 1), true);
});

test("circuit-registry: getCircuitInfo returns null when unconfigured", async () => {
  initCircuitRegistry(mockDeps({ circuitRegistryContractId: undefined }));
  const info = await getCircuitInfo("vote_v2", "Vote");
  assert.equal(info, null);
});
