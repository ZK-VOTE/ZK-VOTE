import test from "node:test";
import assert from "node:assert/strict";

// #919 — production must fail closed when Vault is configured but unavailable.
const { initSecretManager, getSecret, assertSecretBackendReady } = await import(
  "../src/services/secrets/index.js"
);

const DEAD_VAULT = "http://127.0.0.1:1"; // nothing listens here

test("production: Vault miss does not fall back to env", async () => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  process.env.CANARY_FAIL_CLOSED_KEY = "canary-value-do-not-leak";
  try {
    initSecretManager({
      vault: { url: DEAD_VAULT, token: "test" },
      encryptionKey: "test-key-32-bytes-long-xxxxxxxxxx",
    });
    const value = await getSecret("CANARY_FAIL_CLOSED_KEY");
    assert.equal(value, undefined, "production must not downgrade to env");
  } finally {
    delete process.env.CANARY_FAIL_CLOSED_KEY;
    process.env.NODE_ENV = previousEnv;
  }
});

test("production: boot check rejects when Vault is unreachable", async () => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    initSecretManager({
      vault: { url: DEAD_VAULT, token: "test" },
      encryptionKey: "test-key-32-bytes-long-xxxxxxxxxx",
    });
    await assert.rejects(() => assertSecretBackendReady(1_000), /Refusing to start/);
  } finally {
    process.env.NODE_ENV = previousEnv;
  }
});

test("non-production: boot check only warns when Vault is unreachable", async () => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    initSecretManager({
      vault: { url: DEAD_VAULT, token: "test" },
      encryptionKey: "test-key-32-bytes-long-xxxxxxxxxx",
    });
    await assertSecretBackendReady(1_000);
  } finally {
    process.env.NODE_ENV = previousEnv;
  }
});
