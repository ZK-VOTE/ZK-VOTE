// Regression tests for "circuit registry as single source of truth".
//
// These exercise the service through its injected dependency surface with a
// stub RPC server that returns real ScVal maps — no live network, no npm
// install, Node's built-in test runner only.

import test from "node:test";
import assert from "node:assert/strict";
import * as StellarSdk from "@stellar/stellar-sdk";

import {
  initCircuitRegistry,
  getCurrentVersion,
  resolveVk,
  getVK,
  computeCanonicalVkHash,
  invalidateVkCache,
  invalidateVersionCache,
  CircuitRegistryUnavailableError,
  StaleVkError,
  type CircuitRegistryDeps,
} from "../src/services/circuit-registry.js";
import { computeVkHash, stableStringify } from "../../packages/sdk/src/keys.js";

const TEST_ADDR = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const TEST_CONTRACT_ID = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 7));

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  log: () => {},
};

function sym(value: string) {
  return StellarSdk.nativeToScVal(value, { type: "symbol" });
}
function str(value: string) {
  return StellarSdk.nativeToScVal(value, { type: "string" });
}
function u32(value: number) {
  return StellarSdk.nativeToScVal(value, { type: "u32" });
}
function u64(value: number) {
  return StellarSdk.nativeToScVal(value, { type: "u64" });
}
function bytes(hex: string) {
  return StellarSdk.nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" });
}
function map(entries: [string, StellarSdk.xdr.ScVal][]) {
  return StellarSdk.xdr.ScVal.scvMap(
    entries.map(
      ([key, val]) =>
        new StellarSdk.xdr.ScMapEntry({ key: sym(key), val }),
    ),
  );
}

function vkScVal(fill: string) {
  return map([
    ["alpha", bytes(fill.repeat(64))],
    ["beta", bytes("b".repeat(128))],
    ["gamma", bytes("c".repeat(128))],
    ["delta", bytes("d".repeat(128))],
    [
      "ic",
      StellarSdk.xdr.ScVal.scvVec([bytes(fill.repeat(64))]),
    ],
  ]);
}

function recordScVal(options: {
  version: number;
  fill: string;
  circuitId?: string;
  ceremony?: string;
  numPublicSignals?: number;
}) {
  const entries: [string, StellarSdk.xdr.ScVal][] = [
    ["vk", vkScVal(options.fill)],
    ["num_public_signals", u32(options.numPublicSignals ?? 5)],
    ["version", u32(options.version)],
    ["circuit_id", str(options.circuitId ?? "vote_v1")],
    ["registered_at", u64(1)],
  ];
  if (options.ceremony) {
    entries.push(["ceremony_transcript_hash", str(options.ceremony)]);
  }
  return map(entries);
}

function proposalScVal(options: {
  id: number;
  circuitId: string;
  daoId: number;
  status: string;
}) {
  return map([
    ["id", u32(options.id)],
    ["circuit_id", str(options.circuitId)],
    ["circuit_type", sym("Vote")],
    ["dao_id", u64(options.daoId)],
    ["status", sym(options.status)],
  ]);
}

function simulation(result: StellarSdk.xdr.ScVal) {
  return {
    result: { retval: result, auth: [] },
    minResourceFee: "0",
    cost: { cpuInsns: "0", memBytes: "0" },
  };
}

function methodOf(tx: unknown): string {
  try {
    const operation = (tx as {
      operations: {
        func: {
          invokeContract(): { functionName(): { toString(): string } };
        };
      }[];
    }).operations[0];
    return operation.func.invokeContract().functionName().toString();
  } catch {
    return "";
  }
}

type Handler = (method: string, tx: unknown) => unknown;

function deps(handlers: Record<string, Handler>, overrides: Partial<CircuitRegistryDeps> = {}): CircuitRegistryDeps {
  const server = {
    getAccount: async () => new StellarSdk.Account(TEST_ADDR, "1"),
    simulateTransaction: async (tx: unknown) => {
      const method = methodOf(tx);
      const handler = handlers[method] ?? handlers["*"];
      if (!handler) return simulation(sym("ok"));
      return handler(method, tx);
    },
  };
  return {
    server: server as never,
    relayerKeypair: { publicKey: () => TEST_ADDR },
    callWithTimeout: async <T>(fn: () => Promise<T>) => fn(),
    circuitRegistryContractId: TEST_CONTRACT_ID,
    networkPassphrase: "Test SDF Network ; September 2015",
    logger: noopLogger,
    // Explicitly production-like: the env-driven test-mode default must not
    // leak mock data into these assertions.
    testMode: false,
    ...overrides,
  };
}

function resetCaches() {
  invalidateVkCache();
  invalidateVersionCache();
}

test("registry unavailable -> fail closed, never synthetic VK/version", async () => {
  resetCaches();
  initCircuitRegistry(deps({}, { circuitRegistryContractId: undefined }));

  await assert.rejects(
    () => resolveVk({ daoId: 1, circuitId: "vote_v1", version: 1 }),
    CircuitRegistryUnavailableError,
  );
  await assert.rejects(
    () => getCurrentVersion("vote_v1"),
    CircuitRegistryUnavailableError,
  );
  // Legacy wrapper also fails closed instead of returning a synthetic key.
  await assert.rejects(
    () => getVK("vote_v1", "Vote"),
    CircuitRegistryUnavailableError,
  );
});

test("registry simulation error -> fail closed", async () => {
  resetCaches();
  initCircuitRegistry(
    deps({
      "*": () => ({ error: "contract missing function" }),
    }),
  );
  await assert.rejects(
    () => resolveVk({ circuitId: "vote_v1" }),
    CircuitRegistryUnavailableError,
  );
});

test("version resolution reads the on-chain record", async () => {
  resetCaches();
  initCircuitRegistry(
    deps({
      get_vk_record: () => simulation(recordScVal({ version: 3, fill: "a" })),
    }),
  );

  assert.equal(await getCurrentVersion("vote_v1"), 3);
  const resolved = await resolveVk({ daoId: 7, circuitId: "vote_v1" });
  assert.equal(resolved.version, 3);
  assert.equal(resolved.currentVersion, 3);
  assert.equal(resolved.numPublicSignals, 5);
  assert.equal(resolved.source, "on-chain");
  assert.equal(resolved.circuitId, "vote_v1");
});

test("canonical hash is deterministic and identical across clients", async () => {
  resetCaches();
  const record = {
    vk: {
      alpha: "a".repeat(64),
      beta: "b".repeat(128),
      gamma: "c".repeat(128),
      delta: "d".repeat(128),
      ic: ["a".repeat(64)],
    },
    circuitId: "vote_v1",
    version: 2,
    ceremonyTranscriptHash: "ceremony-abc",
  };

  const backendHash = await computeCanonicalVkHash(record);
  const sdkHash = await computeVkHash(record);
  assert.equal(backendHash, sdkHash);
  assert.match(backendHash, /^[0-9a-f]{64}$/);

  initCircuitRegistry(
    deps({
      get_vk_record: () =>
        simulation(
          recordScVal({
            version: 2,
            fill: "a",
            ceremony: "ceremony-abc",
          }),
        ),
    }),
  );
  const resolved = await resolveVk({ circuitId: "vote_v1", version: 2 });
  // The backend record's beta/gamma/delta use fixed fills from recordScVal;
  // recompute against the exact returned VK to prove stability.
  const expected = await computeCanonicalVkHash({
    vk: resolved.vk,
    circuitId: resolved.circuitId,
    version: resolved.version,
    ceremonyTranscriptHash: resolved.ceremonyTranscriptHash,
  });
  assert.equal(resolved.hash, expected);
  assert.equal(
    await computeVkHash({
      vk: resolved.vk,
      circuitId: resolved.circuitId,
      version: resolved.version,
      ceremonyTranscriptHash: resolved.ceremonyTranscriptHash,
    }),
    expected,
  );

  // A different ceremony transcript must produce a different digest.
  const other = await computeCanonicalVkHash({
    ...record,
    ceremonyTranscriptHash: "ceremony-xyz",
  });
  assert.notEqual(other, backendHash);
  assert.deepEqual(
    stableStringify({ b: 2, a: 1 }),
    '{"a":1,"b":2}',
  );
});

test("stale cached VK is rejected after rotation and cache invalidation refreshes it", async () => {
  resetCaches();
  let current = recordScVal({ version: 1, fill: "a" });
  initCircuitRegistry(
    deps({ get_vk_record: () => simulation(current) }),
  );

  const before = await resolveVk({ daoId: 1, circuitId: "vote_v1", version: 1 });
  assert.equal(before.version, 1);
  assert.equal(before.vk.alpha, "a".repeat(64));

  // Rotate on-chain: version 2 with a different VK.
  current = recordScVal({ version: 2, fill: "b" });

  // Without invalidation the old cached entry is still served (this is why
  // rotation must explicitly invalidate).
  const stillCached = await resolveVk({
    daoId: 1,
    circuitId: "vote_v1",
    version: 1,
  });
  assert.equal(stillCached.hash, before.hash);

  invalidateVkCache();
  invalidateVersionCache();

  await assert.rejects(
    () => resolveVk({ daoId: 1, circuitId: "vote_v1", version: 1 }),
    StaleVkError,
  );
  const after = await resolveVk({ daoId: 1, circuitId: "vote_v1" });
  assert.equal(after.version, 2);
  assert.equal(after.vk.alpha, "b".repeat(64));
  assert.notEqual(after.hash, before.hash);
});

test("executeVkUpgrade invalidates the rotated circuit's cached VKs", async () => {
  resetCaches();
  let current = recordScVal({ version: 1, fill: "a" });
  const { executeVkUpgrade } = await import(
    "../src/services/circuit-registry.js"
  );
  initCircuitRegistry(
    deps({
      get_vk_record: () => simulation(current),
      get_vk_proposal: () =>
        simulation(
          proposalScVal({
            id: 9,
            circuitId: "vote_v1",
            daoId: 3,
            status: "Executed",
          }),
        ),
      execute_vk_upgrade: () => simulation(sym("ok")),
    }),
  );

  const before = await resolveVk({
    daoId: 3,
    circuitId: "vote_v1",
    version: 1,
  });
  current = recordScVal({ version: 2, fill: "b" });

  await executeVkUpgrade(9, TEST_ADDR);

  await assert.rejects(
    () => resolveVk({ daoId: 3, circuitId: "vote_v1", version: 1 }),
    StaleVkError,
  );
  const after = await resolveVk({ daoId: 3, circuitId: "vote_v1" });
  assert.equal(after.version, 2);
  assert.notEqual(after.hash, before.hash);
});

test("scoped cache invalidation only drops the matching DAO/circuit/version", async () => {
  resetCaches();
  initCircuitRegistry(
    deps({
      get_vk_record: (method: string, tx: unknown) => {
        // Distinguish the two DAO calls by the u64 daoId argument is not
        // possible for get_vk_record; use distinct circuit ids instead.
        return simulation(recordScVal({ version: 1, fill: "a", circuitId: "vote_v1" }));
      },
    }),
  );
  await resolveVk({ daoId: 1, circuitId: "vote_v1", version: 1 });
  await resolveVk({ daoId: 2, circuitId: "vote_v1", version: 1 });

  invalidateVkCache({ daoId: 1, circuitId: "vote_v1", version: 1 });
  // dao 2's entry remains, so no new RPC call is needed for it.
  let calls = 0;
  initCircuitRegistry(
    deps({
      get_vk_record: () => {
        calls++;
        return simulation(recordScVal({ version: 1, fill: "a" }));
      },
    }),
  );
  await resolveVk({ daoId: 2, circuitId: "vote_v1", version: 1 });
  assert.equal(calls, 0, "other DAO's cached VK must survive scoped invalidation");
  await resolveVk({ daoId: 1, circuitId: "vote_v1", version: 1 });
  assert.equal(calls, 1, "invalidated DAO must re-read the registry");
});
