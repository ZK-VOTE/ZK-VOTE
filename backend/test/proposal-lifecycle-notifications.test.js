import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as StellarSdk from "@stellar/stellar-sdk";

const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "zkvote-proposal-lifecycle-"),
);
const dbPath = path.join(tempDir, "proposal-lifecycle.db");

process.env.RELAYER_TEST_MODE = "true";
process.env.RELAYER_SECRET_KEY =
  "SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF";
process.env.AUTH_MASTER_KEY = "proposal-lifecycle-master-key";
process.env.RELAYER_AUTH_TOKEN = "proposal-lifecycle-token";
process.env.VOTING_CONTRACT_ID = StellarSdk.StrKey.encodeContract(
  Buffer.alloc(32, 1),
);
process.env.TREE_CONTRACT_ID = StellarSdk.StrKey.encodeContract(
  Buffer.alloc(32, 2),
);
process.env.COMMENTS_CONTRACT_ID = StellarSdk.StrKey.encodeContract(
  Buffer.alloc(32, 3),
);
process.env.BRIDGE_CONTRACT_ID = StellarSdk.StrKey.encodeContract(
  Buffer.alloc(32, 4),
);
process.env.SOROBAN_RPC_URL = "http://127.0.0.1:1";
process.env.NETWORK_PASSPHRASE = "Test";
process.env.CORS_ORIGIN = "http://localhost";

delete process.env.PINATA_JWT;
delete process.env.DAO_REGISTRY_CONTRACT_ID;
delete process.env.MEMBERSHIP_SBT_CONTRACT_ID;

const {
  initDb,
  closeDb,
  subscribeToDaoProposalLifecycle,
  unsubscribeFromDaoProposalLifecycle,
  listDaoProposalLifecycleSubscriptions,
  getDaoProposalLifecycleNotifications,
  addEvent,
} = await import("../src/services/db.js");

const walletAddress = StellarSdk.Keypair.random().publicKey();

test.before(() => {
  initDb(dbPath);
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("proposal lifecycle subscriptions can be created and removed per DAO", async () => {
  const subscribeRes = subscribeToDaoProposalLifecycle(42, walletAddress);

  assert.equal(subscribeRes.success, true);
  assert.equal(subscribeRes.active, true);

  const subscriptions = await listDaoProposalLifecycleSubscriptions(42);
  assert.equal(subscriptions.length, 1);
  assert.equal(typeof subscriptions[0].walletAddressHash, "string");
  assert.equal(subscriptions[0].active, true);

  const unsubscribeRes = unsubscribeFromDaoProposalLifecycle(42, walletAddress);

  assert.equal(unsubscribeRes.success, true);
  assert.equal(unsubscribeRes.active, false);

  const afterUnsubscribe = await listDaoProposalLifecycleSubscriptions(42, {
    includeInactive: true,
  });
  assert.equal(afterUnsubscribe.length, 1);
  assert.equal(afterUnsubscribe[0].active, false);
});

test("proposal lifecycle notifications are tracked when a proposal opens and closes", async () => {
  const anotherWallet = StellarSdk.Keypair.random().publicKey();
  await subscribeToDaoProposalLifecycle(7, anotherWallet);

  const created = addEvent({
    daoId: 7,
    type: "proposal_created",
    data: { proposalId: 99, title: "Budget vote" },
    txHash: "proposal_created_99",
    verified: true,
  });

  assert.equal(created, true);

  const createdNotifications = await getDaoProposalLifecycleNotifications(7, {
    eventType: "proposal_created",
  });
  assert.equal(createdNotifications.length, 1);
  assert.equal(createdNotifications[0].eventType, "proposal_created");
  assert.equal(typeof createdNotifications[0].walletAddressHash, "string");

  const closed = addEvent({
    daoId: 7,
    type: "proposal_closed",
    data: { proposalId: 99, status: "closed" },
    txHash: "proposal_closed_99",
    verified: true,
  });

  assert.equal(closed, true);

  const closeNotifications = await getDaoProposalLifecycleNotifications(7, {
    eventType: "proposal_closed",
  });
  assert.equal(closeNotifications.length, 1);
  assert.equal(closeNotifications[0].eventType, "proposal_closed");
  assert.equal(typeof closeNotifications[0].walletAddressHash, "string");

  const unsubscribeRes = await unsubscribeFromDaoProposalLifecycle(7, anotherWallet);
  assert.equal(unsubscribeRes.active, false);
});
