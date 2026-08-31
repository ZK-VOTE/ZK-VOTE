import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import * as StellarSdk from "@stellar/stellar-sdk";

const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "zkvote-route-branches-"),
);
const dbPath = path.join(tempDir, "routes.db");

process.env.RELAYER_TEST_MODE = "true";
process.env.RELAYER_SECRET_KEY =
  "SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF";
process.env.RELAYER_AUTH_TOKEN = "route-branches-token";
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

const { app } = await import("../src/index.ts");
const { config, LIMITS } = await import("../src/config.js");
const { initDb, closeDb } = await import("../src/services/db.js");

const auth = {
  Authorization: "Bearer route-branches-token",
};

const author = StellarSdk.Keypair.random().publicKey();

const validCid = `Qm${"1".repeat(44)}`;

test.before(() => {
  initDb(dbPath);
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("circuit status returns defaults for vote and comment circuits", async () => {
  let response = await request(app).get("/circuits/1/vote/status");

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.daoId, 1);
  assert.equal(response.body.circuitType, "Vote");
  assert.equal(typeof response.body.currentCircuit, "string");
  assert.ok(Array.isArray(response.body.availableCircuits));

  response = await request(app).get("/circuits/1/comment/status");

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.daoId, 1);
  assert.equal(response.body.circuitType, "Comment");

  response = await request(app).get("/circuits/1/invalid/status");

  assert.equal(response.statusCode, 400);
});

test("DAO listing handles an optional user address", async () => {
  const response = await request(app).get("/daos").query({ user: author });

  assert.equal(response.statusCode, 200);
  assert.ok(Array.isArray(response.body.data));
});

test("IPFS metadata validates version and video URLs", async () => {
  let response = await request(app).post("/ipfs/metadata").set(auth).send({});

  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /metadata\.version/);

  response = await request(app).post("/ipfs/metadata").set(auth).send({
    version: 1,
    videoUrl: "https://example.com/not-allowed",
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /YouTube and Vimeo/);

  response = await request(app).post("/ipfs/metadata").set(auth).send({
    version: 1,
    body: "Valid metadata",
    videoUrl: "https://youtube.com/watch?v=test",
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, {
    error: "IPFS service not configured",
  });
});

test("IPFS image upload handles missing and invalid files", async () => {
  const originalEnabled = config.ipfsEnabled;

  try {
    Object.assign(config, { ipfsEnabled: true });

    let response = await request(app).post("/ipfs/image").set(auth);

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, {
      error: "No image file provided",
    });

    response = await request(app)
      .post("/ipfs/image")
      .set(auth)
      .attach("image", Buffer.from("plain text"), {
        filename: "notes.txt",
        contentType: "text/plain",
      });

    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /Unsupported file type/);

    response = await request(app)
      .post("/ipfs/image")
      .set(auth)
      .attach("image", Buffer.alloc(LIMITS.MAX_IMAGE_SIZE + 1), {
        filename: "oversized.png",
        contentType: "image/png",
      });

    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /File too large/);
  } finally {
    Object.assign(config, { ipfsEnabled: originalEnabled });
  }
});

test("comment edit and delete fail closed at the RPC boundary", async () => {
  let response = await request(app).post("/comment/edit").set(auth).send({
    daoId: 1,
    proposalId: 2,
    commentId: 3,
    newContentCid: validCid,
    author,
  });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, {
    error: "Internal server error",
  });

  response = await request(app).post("/comment/delete").set(auth).send({
    daoId: 1,
    proposalId: 2,
    commentId: 3,
    author,
  });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, {
    error: "Internal server error",
  });
});

test("comment flagging executes the anti-spam service in test mode", async () => {
  const payload = {
    daoId: 1,
    proposalId: 2,
    commentId: 3,
    flaggerCommitment: "05".padStart(64, "0"),
    flaggerNullifier: "06".padStart(64, "0"),
    serverId: "test-server",
    workNonce: "test-work",
  };

  const response = await request(app)
    .post("/comment/flag")
    .set(auth)
    .send(payload);

  assert.equal(response.statusCode, 200);
  assert.equal(typeof response.body.success, "boolean");
  assert.equal(typeof response.body.hidden, "boolean");
  assert.equal(typeof response.body.flagCount, "number");
  assert.equal(typeof response.body.threshold, "number");
});

test("comment nonce returns its safe RPC fallback", async () => {
  const response = await request(app)
    .get("/comments/1/2/nonce")
    .query({
      commitment: "07".padStart(64, "0"),
    });

  assert.equal(response.statusCode, 200);
  assert.equal(typeof response.body, "object");
});

test("event notification rejects an unverifiable event", async () => {
  const response = await request(app)
    .post("/events/notify")
    .set(auth)
    .send({
      daoId: 2,
      type: "member_added",
      data: {
        member: author,
      },
      txHash: "notify_tx_001",
    });

  assert.equal(response.statusCode, 400);
  assert.equal(typeof response.body, "object");
});

test("valid image upload reaches the IPFS service failure boundary", async () => {
  const originalEnabled = config.ipfsEnabled;

  try {
    Object.assign(config, { ipfsEnabled: true });

    const response = await request(app)
      .post("/ipfs/image")
      .set(auth)
      .attach("image", Buffer.from("small-image-content"), {
        filename: "valid.png",
        contentType: "image/png",
      });

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, {
      error: "Failed to upload image to IPFS",
    });
  } finally {
    Object.assign(config, { ipfsEnabled: originalEnabled });
  }
});

test("valid metadata reaches the IPFS service failure boundary", async () => {
  const originalEnabled = config.ipfsEnabled;

  try {
    Object.assign(config, { ipfsEnabled: true });

    const response = await request(app).post("/ipfs/metadata").set(auth).send({
      version: 1,
      body: "<script>removed()</script>Valid metadata",
      videoUrl: "https://vimeo.com/123456",
    });

    // The route fails gracefully: the write is queued for retry (202) with
    // degradation markers instead of a hard 500, so the UI keeps working.
    assert.equal(response.statusCode, 202);
    assert.equal(response.body.queued, true);
    assert.equal(typeof response.body.queueId, "string");
    assert.equal(response.body.degraded, true);
    assert.match(response.body.error, /queued for retry/);
  } finally {
    Object.assign(config, { ipfsEnabled: originalEnabled });
  }
});

test("valid anonymous comment reaches controlled execution handling", async () => {
  const response = await request(app)
    .post("/comment/anonymous")
    .set(auth)
    .send({
      daoId: 1,
      proposalId: 1,
      contentCid: "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
      parentId: null,
      voteChoice: true,
      nullifier: "11".repeat(32),
      root: "22".repeat(32),
      proof: {
        a: "44".repeat(64),
        b: "55".repeat(128),
        c: "66".repeat(64),
      },
    });

  assert.ok(
    [400, 500].includes(response.statusCode),
    `unexpected status ${response.statusCode}`,
  );
  assert.equal(typeof response.body.error, "string");
});
