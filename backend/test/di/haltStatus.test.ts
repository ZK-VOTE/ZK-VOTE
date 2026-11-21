// Unit tests for the tiered-halt status service (ZV-114 / #954).
//
// Same DI pattern as test/di/circuit-registry.test.ts (#358): mock
// server/relayer/timeout, no live RPC endpoint, no module globals.

import test from "node:test";
import assert from "node:assert/strict";
import * as StellarSdk from "@stellar/stellar-sdk";

import {
  initHaltStatus,
  isTierHalted,
  getAllTierStatus,
  HALT_TIER_VOTE_SUBMISSION,
  HALT_TIER_TALLY_FINALIZATION,
  HALT_TIER_TREASURY_EXECUTION,
  HALT_TIERS,
  type HaltStatusDeps,
} from "../../src/services/haltStatus.js";

const TEST_ADDR = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const TEST_CONTRACT_ID = "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";

/** Build a mock dependency set that returns `haltedValue` for every call. */
function mockDeps(
  overrides: Partial<HaltStatusDeps> = {},
  haltedValue: boolean = false,
): HaltStatusDeps {
  const server = {
    getAccount: async () => new StellarSdk.Account(TEST_ADDR, "1"),
    simulateTransaction: async () => ({
      result: { retval: StellarSdk.nativeToScVal(haltedValue, { type: "bool" }) },
      minResourceFee: "0",
      cost: { cpuInsns: "0", memBytes: "0" },
    }),
  };
  const base: HaltStatusDeps = {
    server: server as never,
    relayerKeypair: { publicKey: () => TEST_ADDR },
    callWithTimeout: async <T>(fn: () => Promise<T>) => fn(),
    votingContractId: TEST_CONTRACT_ID,
    networkPassphrase: "Test SDF Network ; September 2015",
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      log: () => {},
    } as never,
  };
  return { ...base, ...overrides };
}

test("haltStatus: returns null when the voting contract id is not configured", async () => {
  initHaltStatus(mockDeps({ votingContractId: undefined }));
  const result = await isTierHalted(HALT_TIER_VOTE_SUBMISSION);
  assert.equal(result, null);
});

test("haltStatus: isTierHalted reports false when the contract says not halted", async () => {
  initHaltStatus(mockDeps({}, false));
  assert.equal(await isTierHalted(HALT_TIER_VOTE_SUBMISSION), false);
});

test("haltStatus: isTierHalted reports true when the contract says halted", async () => {
  initHaltStatus(mockDeps({}, true));
  assert.equal(await isTierHalted(HALT_TIER_TALLY_FINALIZATION), true);
});

test("haltStatus: returns null on a simulation error rather than throwing", async () => {
  initHaltStatus(
    mockDeps({
      server: {
        getAccount: async () => new StellarSdk.Account(TEST_ADDR, "1"),
        simulateTransaction: async () => ({ error: "boom" }),
      } as never,
    }),
  );
  assert.equal(await isTierHalted(HALT_TIER_TREASURY_EXECUTION), null);
});

test("haltStatus: getAllTierStatus covers every known tier", async () => {
  initHaltStatus(mockDeps({}, true));
  const statuses = await getAllTierStatus();
  assert.equal(statuses.length, HALT_TIERS.length);
  for (const { tier, name } of HALT_TIERS) {
    const entry = statuses.find((s) => s.tier === tier);
    assert.ok(entry, `${name} must be in the status list`);
    assert.equal(entry?.halted, true);
  }
});
