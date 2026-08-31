import test from "node:test";
import assert from "node:assert/strict";
import { config, validateEnv } from "../src/config.ts";

test("config: loads with default values", () => {
  assert.equal(typeof config.port, "number");
  assert.equal(config.port > 0, true);
  assert.equal(typeof config.NODE_ENV, "string");
});

test("config: numeric env vars parse correctly", () => {
  assert.equal(typeof config.rpcTimeoutMs, "number");
  assert.equal(config.rpcTimeoutMs > 0, true);
  assert.equal(typeof config.powDifficulty, "number");
  assert.equal(config.powDifficulty > 0, true);
});

test("config: boolean flags parse correctly", () => {
  assert.equal(typeof config.clusterEnabled, "boolean");
  assert.equal(typeof config.logRequestBody, "boolean");
  assert.equal(typeof config.indexerEnabled, "boolean");
  assert.equal(typeof config.powEnabled, "boolean");
});

test("config: arrays and lists parse correctly", () => {
  assert.equal(Array.isArray(config.rpcUrls), true);
  assert.equal(config.rpcUrls.length > 0, true);
});

test("validateEnv: detects missing required VOTING_CONTRACT_ID", () => {
  const originalValue = process.env.VOTING_CONTRACT_ID;
  const originalExit = process.exit;
  delete process.env.VOTING_CONTRACT_ID;

  try {
    // validateEnv() hard-exits on missing required vars; capture that as an
    // exception so the assertion runs instead of killing the test runner.
    process.exit = (code) => {
      throw new Error(`process.exit(${code}) called`);
    };
    assert.throws(() => validateEnv(), /process\.exit\(1\)/);
  } finally {
    process.exit = originalExit;
    if (originalValue) process.env.VOTING_CONTRACT_ID = originalValue;
  }
});

test("validateEnv: accepts valid Stellar contract IDs", () => {
  if (!config.votingContractId || !config.treeContractId) {
    assert.skip(
      "Skipping: test contract IDs not configured in environment",
    );
    return;
  }

  // If we get here, validateEnv() should have already passed at module load
  assert.ok(config.votingContractId);
  assert.ok(config.treeContractId);
});

test("config: CORS origins parsed correctly", () => {
  if (config.corsOrigins === "*") {
    assert.equal(config.corsOrigins, "*");
  } else {
    assert.equal(Array.isArray(config.corsOrigins), true);
  }
});

test("config: memory ratio values in valid range", () => {
  assert.equal(config.memoryWarnRatio >= 0 && config.memoryWarnRatio <= 1, true);
  assert.equal(
    config.memoryCriticalRatio >= 0 && config.memoryCriticalRatio <= 1,
    true,
  );
});

test("config: circuit breaker thresholds positive", () => {
  assert.equal(config.circuitBreakerRpcFailureThreshold > 0, true);
  assert.equal(config.circuitBreakerPinataFailureThreshold > 0, true);
  assert.equal(config.circuitBreakerGatewayFailureThreshold > 0, true);
});

test("config: TTL settings within reasonable bounds", () => {
  assert.equal(config.ttlBatchSize > 0, true);
  assert.equal(config.ttlRenewalIntervalMs > 0, true);
  assert.equal(config.ttlRenewalThresholdMs > 0, true);
});
