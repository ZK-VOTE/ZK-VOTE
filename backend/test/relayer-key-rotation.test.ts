import test from "node:test";
import assert from "node:assert/strict";
import * as StellarSdk from "@stellar/stellar-sdk";

process.env.RELAYER_TEST_MODE = "true";
process.env.RELAYER_AUTH_TOKEN =
  "test_admin_token_01234567890123456789012345678901";

const { relayerKeyManager, LocalKeypairSigner, MockTestSigner } = await import(
  "../src/services/relayerKeyManager.ts"
);
const { relayerKeypair, activeSigner, sequenceManager } = await import(
  "../src/services/stellar.ts"
);

test.beforeEach(() => {
  relayerKeyManager.reset();
});

test("RelayerKeyManager: initializes with primary and secondary test keys in test mode", () => {
  relayerKeyManager.initialize({ testMode: true });

  const active = relayerKeyManager.getActiveKey();
  assert.ok(active);
  assert.equal(active.role, "primary");
  assert.equal(active.status, "active");
  assert.ok(active.publicKey.startsWith("G"));

  const allKeys = relayerKeyManager.getAllKeys();
  assert.equal(allKeys.length, 2);

  const secondary = allKeys.find((k) => k.role === "secondary");
  assert.ok(secondary);
  assert.equal(secondary.status, "standby");
});

test("RelayerKeyManager: supports local keypairs with secret keys", () => {
  const kp1 = StellarSdk.Keypair.random();
  const kp2 = StellarSdk.Keypair.random();

  relayerKeyManager.initialize({
    secretKey: kp1.secret(),
    secondarySecretKey: kp2.secret(),
    testMode: false,
  });

  const active = relayerKeyManager.getActiveKey();
  assert.ok(active);
  assert.equal(active.publicKey, kp1.publicKey());
  assert.equal(active.role, "primary");
  assert.equal(active.status, "active");

  const keys = relayerKeyManager.getAllKeys();
  assert.equal(keys.length, 2);
  const sec = keys.find((k) => k.role === "secondary");
  assert.ok(sec);
  assert.equal(sec.publicKey, kp2.publicKey());
  assert.equal(sec.status, "standby");
});

test("RelayerKeyManager: performs hot key swap without restarting", async () => {
  const kp1 = StellarSdk.Keypair.random();
  const kp2 = StellarSdk.Keypair.random();

  relayerKeyManager.initialize({
    secretKey: kp1.secret(),
    secondarySecretKey: kp2.secret(),
    testMode: false,
  });

  assert.equal(relayerKeyManager.getPublicKey(), kp1.publicKey());

  let notifiedNew: string | null = null;
  let notifiedOld: string | null = null;
  relayerKeyManager.onRotate((newKey, oldKey) => {
    notifiedNew = newKey.publicKey;
    notifiedOld = oldKey ? oldKey.publicKey : null;
  });

  // Rotate to secondary
  const result = await relayerKeyManager.rotateActiveKey(
    undefined,
    "manual",
  );
  assert.ok(result.success);
  assert.equal(result.activeKey.publicKey, kp2.publicKey());
  assert.equal(result.activeKey.role, "primary");
  assert.equal(result.previousKey?.publicKey, kp1.publicKey());
  assert.equal(result.previousKey?.role, "secondary");

  assert.equal(relayerKeyManager.getPublicKey(), kp2.publicKey());
  assert.equal(notifiedNew, kp2.publicKey());
  assert.equal(notifiedOld, kp1.publicKey());

  // Dynamic proxy exports also update automatically
  assert.equal(relayerKeypair.publicKey(), kp2.publicKey());
  assert.equal(activeSigner.getPublicKey(), kp2.publicKey());
});

test("RelayerKeyManager: registers new secondary keys and generates keys", () => {
  relayerKeyManager.initialize({ testMode: true });

  const generated = relayerKeyManager.generateKey("secondary", false);
  assert.ok(generated);
  assert.equal(generated.role, "secondary");
  assert.equal(generated.status, "standby");

  const kpCustom = StellarSdk.Keypair.random();
  const registered = relayerKeyManager.registerKey({
    id: "custom-standby",
    secretKey: kpCustom.secret(),
    signerType: "local",
    role: "secondary",
  });

  assert.equal(registered.id, "custom-standby");
  assert.equal(registered.publicKey, kpCustom.publicKey());
  assert.equal(registered.role, "secondary");

  const keys = relayerKeyManager.getAllKeys();
  assert.equal(keys.length, 4); // primary + default secondary + generated + custom
});

test("RelayerKeyManager: automated low-balance failover rotates to secondary", async () => {
  const kp1 = StellarSdk.Keypair.random();
  const kp2 = StellarSdk.Keypair.random();

  relayerKeyManager.initialize({
    secretKey: kp1.secret(),
    secondarySecretKey: kp2.secret(),
    testMode: false,
  });

  const activeKey = relayerKeyManager.getActiveKey();
  assert.ok(activeKey);
  // Set active key balance low (below threshold of 5 XLM)
  activeKey.balanceXlm = 2.5;

  const secondaryKey = Array.from(
    (relayerKeyManager as any).keys.values(),
  ).find((k: any) => (k as any).role === "secondary") as any;
  assert.ok(secondaryKey);
  secondaryKey.balanceXlm = 50.0;

  const failover = await relayerKeyManager.checkAndHandleLowBalance(5.0);
  assert.ok(failover.rotated);
  assert.equal(failover.activePublicKey, kp2.publicKey());
  assert.equal(relayerKeyManager.getPublicKey(), kp2.publicKey());
});

test("RelayerKeyManager: key health monitoring inspects age, balance, alerts", () => {
  relayerKeyManager.initialize({ testMode: true });
  relayerKeyManager.setMinBalanceThreshold(10);

  const health = relayerKeyManager.getKeyHealth();
  assert.equal(health.status, "healthy");
  assert.ok(health.activeKey);
  assert.ok(health.secondaryKey);
  assert.equal(health.minBalanceThresholdXlm, 10);
  assert.equal(health.totalKeys, 2);
  assert.equal(health.alerts.length, 0);

  // Trigger degraded alert when active key balance is below threshold
  const active = relayerKeyManager.getActiveKey();
  if (active) active.balanceXlm = 3;

  const degradedHealth = relayerKeyManager.getKeyHealth();
  assert.equal(degradedHealth.status, "degraded");
  assert.ok(degradedHealth.alerts.length > 0);
  assert.match(degradedHealth.alerts[0], /below threshold/i);
});

test("RelayerKeyManager: funds keys via Friendbot automation", async () => {
  relayerKeyManager.initialize({ testMode: true });

  const active = relayerKeyManager.getActiveKey();
  assert.ok(active);

  const result = await relayerKeyManager.fundKey(active.publicKey);
  assert.ok(result.success);
  assert.match(result.message, /Funded/i);
  assert.ok(active.balanceXlm && active.balanceXlm >= 1000);
});

test("Stellar Service: dynamic signing continuity across key rotation", async () => {
  const kp1 = StellarSdk.Keypair.random();
  const kp2 = StellarSdk.Keypair.random();

  relayerKeyManager.initialize({
    secretKey: kp1.secret(),
    secondarySecretKey: kp2.secret(),
    testMode: false,
  });

  const account1 = new StellarSdk.Account(kp1.publicKey(), "100");
  const dummyTx = new StellarSdk.TransactionBuilder(account1, {
    fee: "100",
    networkPassphrase: "Standalone Network ; February 2017",
  })
    .setTimeout(30)
    .build();

  // Sign with Key 1
  await relayerKeyManager.signTransaction(dummyTx);
  assert.equal(relayerKeyManager.getActiveKey()?.txCount, 1);

  // Rotate to Key 2
  await relayerKeyManager.rotateActiveKey();
  assert.equal(relayerKeyManager.getPublicKey(), kp2.publicKey());

  const account2 = new StellarSdk.Account(kp2.publicKey(), "200");
  const dummyTx2 = new StellarSdk.TransactionBuilder(account2, {
    fee: "100",
    networkPassphrase: "Standalone Network ; February 2017",
  })
    .setTimeout(30)
    .build();

  // Sign with Key 2
  await relayerKeyManager.signTransaction(dummyTx2);
  assert.equal(relayerKeyManager.getActiveKey()?.txCount, 1);
  assert.equal(relayerKeyManager.getPublicKey(), kp2.publicKey());
});

test("Admin API: /admin/relayer endpoints allow key inspection, rotation, generation, and funding", async () => {
  const express = (await import("express")).default;
  const request = (await import("supertest")).default;
  const adminRouter = (await import("../src/routes/admin.ts")).default;

  const app = express();
  app.use(express.json());
  // Mock admin auth
  app.use((req: any, _res: any, next: any) => {
    req.user = { role: "admin" };
    req.headers.authorization = `Bearer ${process.env.RELAYER_AUTH_TOKEN}`;
    next();
  });
  app.use(adminRouter);

  relayerKeyManager.initialize({ testMode: true });

  // 1. GET /admin/relayer/keys
  const getKeysRes = await request(app)
    .get("/admin/relayer/keys")
    .set("Authorization", `Bearer ${process.env.RELAYER_AUTH_TOKEN}`);
  assert.equal(getKeysRes.status, 200);
  assert.equal(getKeysRes.body.status, "success");
  assert.equal(getKeysRes.body.total, 2);

  // 2. GET /admin/relayer/health
  const getHealthRes = await request(app)
    .get("/admin/relayer/health")
    .set("Authorization", `Bearer ${process.env.RELAYER_AUTH_TOKEN}`);
  assert.equal(getHealthRes.status, 200);
  assert.equal(getHealthRes.body.status, "healthy");

  // 3. POST /admin/relayer/rotate
  const rotateRes = await request(app)
    .post("/admin/relayer/rotate")
    .set("Authorization", `Bearer ${process.env.RELAYER_AUTH_TOKEN}`)
    .send({ reason: "api_unit_test" });
  assert.equal(rotateRes.status, 200);
  assert.equal(rotateRes.body.status, "success");
  assert.equal(rotateRes.body.activeKey.role, "primary");
  assert.equal(rotateRes.body.previousKey.role, "secondary");

  // 4. POST /admin/relayer/generate
  const genRes = await request(app)
    .post("/admin/relayer/generate")
    .set("Authorization", `Bearer ${process.env.RELAYER_AUTH_TOKEN}`)
    .send({ role: "secondary", makeActive: false });
  assert.equal(genRes.status, 201);
  assert.equal(genRes.body.status, "success");
  assert.equal(genRes.body.key.role, "secondary");

  // 5. POST /admin/relayer/fund
  const fundRes = await request(app)
    .post("/admin/relayer/fund")
    .set("Authorization", `Bearer ${process.env.RELAYER_AUTH_TOKEN}`)
    .send({ publicKey: genRes.body.key.publicKey });
  assert.equal(fundRes.status, 200);
  assert.equal(fundRes.body.status, "success");

  // 6. POST /admin/relayer/check-balances
  const checkRes = await request(app)
    .post("/admin/relayer/check-balances")
    .set("Authorization", `Bearer ${process.env.RELAYER_AUTH_TOKEN}`)
    .send({});
  assert.equal(checkRes.status, 200);
  assert.equal(checkRes.body.status, "success");
});
