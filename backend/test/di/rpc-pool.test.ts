// Unit tests for the refactored RPC pool / stellar construction (#358).
//
// `RpcPoolManager` and `createSorobanServer`/`createRelayerKeypair` are the
// extracted construction sites for the RPC surface. Injecting a mock server
// factory proves the pool is testable without a live Soroban endpoint.

import test from "node:test";
import assert from "node:assert/strict";

import {
  RpcPoolManager,
  createRpcPool,
  createSorobanServer,
  createRelayerKeypair,
} from "../../src/services/stellar.js";
import { CircuitBreaker } from "../../src/services/circuit-breaker.js";
import type { RpcServerPort } from "../../src/services/interfaces.js";

/** Deterministic fake RPC server; records the URL it was created for. */
function mockServer(url: string): RpcServerPort {
  return {
    getHealth: async () => ({ status: "healthy" }),
    simulateTransaction: async () => ({ ok: true }),
    sendTransaction: async () => ({ status: "PENDING" }),
    getTransaction: async () => ({ status: "SUCCESS" }),
    getAccount: async () => ({ accountId: "G", sequence: "1" }),
    __url: url,
  } as RpcServerPort;
}

test("RpcPoolManager: getActiveServer round-robins across healthy endpoints", () => {
  const pool = createRpcPool(["url-a", "url-b"], {
    serverFactory: mockServer,
  });
  const first = pool.getActiveServer();
  const second = pool.getActiveServer();
  const third = pool.getActiveServer();
  // Round robin: a, b, a ...
  assert.equal((first as unknown as { __url: string }).__url, "url-a");
  assert.equal((second as unknown as { __url: string }).__url, "url-b");
  assert.equal((third as unknown as { __url: string }).__url, "url-a");
});

test("RpcPoolManager: skips unhealthy endpoints and falls back", async () => {
  const pool = new RpcPoolManager(["url-a", "url-b"], undefined, mockServer);
  // Mark url-a's endpoint unhealthy by failing a health check against it.
  const statuses = await pool.checkHealth(); // all healthy (mock returns healthy)
  assert.equal(statuses.length, 2);
  assert.ok(statuses.every((s) => s.healthy));

  // Force the first endpoint unhealthy directly through the pool internals is
  // not possible; instead verify a failing mock server flips the flag.
  const failingPool = new RpcPoolManager(["bad", "good"], undefined, (url) =>
    url === "bad"
      ? ({
          getHealth: async () => ({ status: "offline" }),
        } as RpcServerPort)
      : mockServer(url),
  );
  const after = await failingPool.checkHealth();
  const bad = after.find((s) => s.url === "bad");
  const good = after.find((s) => s.url === "good");
  assert.equal(bad?.healthy, false);
  assert.equal(good?.healthy, true);

  // getActiveServer must return the healthy endpoint.
  const active = failingPool.getActiveServer();
  assert.equal((active as unknown as { __url: string }).__url, "good");
});

test("RpcPoolManager: empty endpoint list uses the server factory for fallback", () => {
  const pool = new RpcPoolManager([], "fallback-url", mockServer);
  const active = pool.getActiveServer();
  assert.equal((active as unknown as { __url: string }).__url, "fallback-url");
});

test("createSorobanServer: test mode returns the offline stub", async () => {
  const server = createSorobanServer({
    testMode: true,
    pool: createRpcPool(["url"], { serverFactory: mockServer }),
    breaker: new CircuitBreaker("test_breaker", {
      failureThreshold: 5,
      resetTimeoutMs: 1000,
    }),
  });
  assert.equal((await server.getHealth()).status, "online");
  await assert.rejects(() => server.simulateTransaction({}), /disabled in RELAYER_TEST_MODE/);
});

test("createSorobanServer: delegates through the pool + breaker in prod mode", async () => {
  const pool = createRpcPool(["url-a"], { serverFactory: mockServer });
  const server = createSorobanServer({
    testMode: false,
    pool,
    breaker: new CircuitBreaker("test_breaker_2", {
      failureThreshold: 5,
      resetTimeoutMs: 1000,
    }),
  });
  const result = await server.simulateTransaction({ some: "tx" });
  assert.deepEqual(result, { ok: true });
});

test("createRelayerKeypair: test mode returns the stub address", () => {
  const kp = createRelayerKeypair(undefined, true);
  assert.equal(kp.publicKey(), "GTESTRELAYERADDRESS000000000000000000000000000000000000");
});

test("createRelayerKeypair: throws without a secret outside test mode", () => {
  assert.throws(() => createRelayerKeypair(undefined, false), /RELAYER_SECRET_KEY is not set/);
});

test("createRelayerKeypair: derives a real keypair from a secret", () => {
  const kp = createRelayerKeypair(
    "SD6SN4QXEXKCQFIN7IYT422G4AL6KRJCUHKK7HWCMHC62DF6KISW44VP",
    false,
  );
  assert.equal(typeof kp.publicKey(), "string");
  assert.match(kp.publicKey(), /^G[A-Z0-9]{55}$/);
});
