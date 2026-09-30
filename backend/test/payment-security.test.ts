import test from "node:test";
import assert from "node:assert/strict";

process.env.RELAYER_TEST_MODE = "true";
process.env.RELAYER_AUTH_TOKEN = "test-token";
process.env.SOROBAN_RPC_URL = "http://localhost:8000/soroban/rpc";
process.env.NETWORK_PASSPHRASE = "Test SDF Future Network ; October 2022";

const payments = await import("../src/services/payments.js");

test("canonicalizes human amounts to Horizon's seven decimals", () => {
  assert.equal(payments.canonicalHorizonAmount("1"), "1.0000000");
  assert.equal(payments.canonicalHorizonAmount("1.2345678"), "1.2345678");
  assert.throws(() => payments.canonicalHorizonAmount("1.23456789"), /at most 7 decimals/);
  assert.throws(() => payments.canonicalHorizonAmount("0"), /positive/);
});

test("converts Soroban 12-decimal atomic amounts without a 100x skew", () => {
  assert.equal(payments.sorobanAtomicToHorizonAmount("1000000000000"), "1.0000000");
  assert.equal(payments.sorobanAtomicToHorizonAmount("10000000"), "0.0000100");
  assert.throws(() => payments.sorobanAtomicToHorizonAmount("10000001"), /represented exactly/);
});
