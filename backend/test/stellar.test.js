import test from "node:test";
import assert from "node:assert/strict";

process.env.RELAYER_TEST_MODE = "true";
process.env.SOROBAN_RPC_URL = "http://localhost:8000/soroban/rpc";
process.env.NETWORK_PASSPHRASE =
  "Test SDF Future Network ; October 2022";

const stellar = await import("../src/services/stellar.js");
const { config } = await import("../src/config.js");

test("withSequenceLock serializes concurrent operations", async () => {
  const events = [];
  let releaseFirst;

  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = stellar.withSequenceLock(async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
    return "first-result";
  });

  await new Promise((resolve) => setImmediate(resolve));

  const second = stellar.withSequenceLock(async () => {
    events.push("second:start");
    events.push("second:end");
    return "second-result";
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);

  releaseFirst();

  assert.deepEqual(await Promise.all([first, second]), [
    "first-result",
    "second-result",
  ]);

  assert.deepEqual(events, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

test("withSequenceLock releases the lock after a rejected operation", async () => {
  await assert.rejects(
    stellar.withSequenceLock(async () => {
      throw new Error("expected failure");
    }),
    /expected failure/,
  );

  const result = await stellar.withSequenceLock(async () => "recovered");
  assert.equal(result, "recovered");
});

test("callWithTimeout returns a completed RPC result", async () => {
  const result = await stellar.callWithTimeout(
    async () => "completed",
    "fast_call",
  );

  assert.equal(result, "completed");
});

test("callWithTimeout rejects a stalled RPC call", async () => {
  const originalTimeout = config.rpcTimeoutMs;
  config.rpcTimeoutMs = 20;

  try {
    await assert.rejects(
      stellar.callWithTimeout(
        () => new Promise(() => {}),
        "stalled_call",
      ),
      /Timeout: stalled_call \(20ms\)/,
    );
  } finally {
    config.rpcTimeoutMs = originalTimeout;
  }
});

test("simulateWithBackoff retries transient failures", async () => {
  let attempts = 0;

  const result = await stellar.simulateWithBackoff(async () => {
    attempts++;

    if (attempts < 3) {
      throw new Error(`transient failure ${attempts}`);
    }

    return "simulation-result";
  }, 3);

  assert.equal(result, "simulation-result");
  assert.equal(attempts, 3);
});

test("simulateWithBackoff returns the final error after exhaustion", async () => {
  let attempts = 0;

  await assert.rejects(
    stellar.simulateWithBackoff(async () => {
      attempts++;
      throw new Error(`failure ${attempts}`);
    }, 2),
    /failure 2/,
  );

  assert.equal(attempts, 2);
});

test("waitForTransaction returns immediately for a completed transaction", async () => {
  const originalGetTransaction = stellar.server.getTransaction;

  stellar.server.getTransaction = async () => ({
    status: "SUCCESS",
    hash: "test-hash",
  });

  try {
    const result = await stellar.waitForTransaction("test-hash", 1);
    assert.equal(result.status, "SUCCESS");
  } finally {
    stellar.server.getTransaction = originalGetTransaction;
  }
});

test("waitForTransaction rejects immediately when no attempts are allowed", async () => {
  await assert.rejects(
    stellar.waitForTransaction("missing-hash", 0),
    /Transaction not found after timeout/,
  );
});

test("isAllZeros detects point-at-infinity byte arrays", () => {
  assert.equal(stellar.isAllZeros(Buffer.alloc(64)), true);
  assert.equal(stellar.isAllZeros(Buffer.alloc(128)), true);

  const nonZero = Buffer.alloc(64);
  nonZero[63] = 1;

  assert.equal(stellar.isAllZeros(nonZero), false);
});

test("RpcPoolManager de-duplicates endpoints and rotates active servers", () => {
  const pool = new stellar.RpcPoolManager([
    "http://localhost:9001",
    "http://localhost:9001",
    "http://localhost:9002",
  ]);

  const metrics = pool.getMetrics();
  assert.equal(metrics.totalEndpoints, 2);
  assert.equal(metrics.healthyEndpoints, 2);

  const first = pool.getActiveServer();
  const second = pool.getActiveServer();
  const third = pool.getActiveServer();

  assert.notEqual(first, second);
  assert.equal(first, third);
});

test("u256 ScVal conversion round-trips padded hexadecimal values", () => {
  const input = "0x1234";
  const scVal = stellar.u256ToScVal(input);

  assert.equal(scVal.switch().name, "scvU256");
  assert.equal(
    stellar.scValToU256Hex(scVal),
    `0x${"1234".padStart(64, "0")}`,
  );

  const zero = stellar.u256ToScVal("");
  assert.equal(
    stellar.scValToU256Hex(zero),
    `0x${"0".repeat(64)}`,
  );
});

test("u256 ScVal conversion rejects malformed and out-of-range values", async () => {
  const StellarSdk = await import("@stellar/stellar-sdk");

  assert.throws(
    () => stellar.u256ToScVal("0xnot-hex"),
    /non-hexadecimal/,
  );

  assert.throws(
    () => stellar.u256ToScVal("abc"),
    /odd length/,
  );

  assert.throws(
    () => stellar.u256ToScVal("00".repeat(33)),
    /too long/,
  );

  assert.throws(
    () => stellar.u256ToScVal("ff".repeat(32)),
    /BN254 scalar field modulus/,
  );

  assert.throws(
    () =>
      stellar.scValToU256Hex(
        StellarSdk.xdr.ScVal.scvBool(true),
      ),
    /Expected U256 ScVal/,
  );
});

test("validateSponsoredFeeRequest defaults to the relayer and caps abusive fee budgets", () => {
  const defaulted = stellar.validateSponsoredFeeRequest({
    voterPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" +"Q",
    sponsor: "relayer",
  });

  assert.equal(defaulted.feePayer, config.relayerPublicKey || stellar.relayerKeypair.publicKey());
  assert.equal(defaulted.feeBudgetStroops, 100000);

  assert.throws(
    () =>
      stellar.validateSponsoredFeeRequest({
        voterPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHFQ",
        sponsor: "relayer",
        feeBudgetStroops: 10_000_001,
      }),
    /fee budget/i,
  );
});

test("hexToBytes pads values and rejects malformed inputs", () => {
  assert.deepEqual(
    stellar.hexToBytes("0x01", 4),
    Buffer.from([0, 0, 0, 1]),
  );

  assert.throws(
    () => stellar.hexToBytes("xyz", 4),
    /non-hexadecimal/,
  );

  assert.throws(
    () => stellar.hexToBytes("abc", 4),
    /odd length/,
  );

  assert.throws(
    () => stellar.hexToBytes("0011223344", 4),
    /too long/,
  );
});

test("proofToScVal converts valid Groth16 proof components", () => {
  const proof = {
    a: "01".padStart(128, "0"),
    b: "02".padStart(256, "0"),
    c: "03".padStart(128, "0"),
  };

  const scVal = stellar.proofToScVal(proof);

  assert.equal(scVal.switch().name, "scvMap");

  const entries = scVal.map();

  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((entry) =>
      Buffer.from(entry.val().bytes()).length
    ),
    [64, 128, 64],
  );
});

test("proofToScVal rejects incomplete and point-at-infinity proofs", () => {
  assert.throws(
    () => stellar.proofToScVal(null),
    /must be an object/,
  );

  assert.throws(
    () =>
      stellar.proofToScVal({
        a: "01",
        b: "02",
      }),
    /missing a, b, or c/,
  );

  assert.throws(
    () =>
      stellar.proofToScVal({
        a: "00".repeat(64),
        b: "01".padStart(256, "0"),
        c: "01".padStart(128, "0"),
      }),
    /point at infinity/,
  );
});
