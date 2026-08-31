/**
 * E2E encrypted governance content (#324)
 *
 * Acceptance: a member decrypts, a non-member fails, rotation cuts a departed
 * member off from new content, and redaction destroys the stored ciphertext.
 * The relay is exercised through its HTTP surface as well as its service layer,
 * because "the relay never sees plaintext" is a property of the API, not just
 * of the crypto.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import request from "supertest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zkvote-e2e-crypto-"));
const dbPath = path.join(tempDir, "encryption.db");

const TOKEN = "encryption-test-token";

process.env.RELAYER_TEST_MODE = "true";
process.env.RELAYER_SECRET_KEY =
  "SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF";
process.env.RELAYER_AUTH_TOKEN = TOKEN;
process.env.AUTH_MASTER_KEY = "encryption-master-key";
process.env.VOTING_CONTRACT_ID = "C".padEnd(56, "A");
process.env.TREE_CONTRACT_ID = "C".padEnd(56, "B");
process.env.COMMENTS_CONTRACT_ID = "C".padEnd(56, "D");
process.env.SOROBAN_RPC_URL = "http://localhost";
process.env.NETWORK_PASSPHRASE = "Test";
process.env.CORS_ORIGIN = "http://localhost";
process.env.IPFS_ENABLED = "false";

const { app } = await import("../src/index.ts");
const { initDb } = await import("../src/services/db.js");
const enc = await import("../src/services/encryption.js");

initDb(dbPath);
enc.initEncryptionSchema();

const auth = (req) => req.set("Authorization", `Bearer ${TOKEN}`);

// ============================================
// SHAMIR SECRET SHARING
// ============================================

test("a threshold of shares recovers the secret; fewer does not", () => {
  const secret = enc.generateGroupKey();
  const shares = enc.splitSecret(secret, 5, 3);

  assert.equal(shares.length, 5);
  assert.deepEqual(
    shares.map((s) => s.index),
    [1, 2, 3, 4, 5],
  );

  // Any 3 of the 5 recover it, regardless of which 3.
  for (const picked of [
    [0, 1, 2],
    [0, 2, 4],
    [2, 3, 4],
  ]) {
    const recovered = enc.combineShares(picked.map((i) => shares[i]));
    assert.ok(recovered.equals(secret), `shares ${picked} should recover the key`);
  }

  // All five also work — extra shares are consistent, not contradictory.
  assert.ok(enc.combineShares(shares).equals(secret));

  // Below the threshold the result is wrong, not merely partial.
  const short = enc.combineShares(shares.slice(0, 2));
  assert.ok(!short.equals(secret), "two shares must not reveal a 3-of-5 secret");
});

test("share splitting rejects impossible parameters", () => {
  const secret = enc.generateGroupKey();

  assert.throws(() => enc.splitSecret(secret, 3, 4), /Threshold must be/);
  assert.throws(() => enc.splitSecret(secret, 0, 1), /Share count must be/);
  assert.throws(() => enc.splitSecret(secret, 256, 2), /Share count must be/);
  assert.throws(() => enc.combineShares([]), /No shares/);
});

test("duplicate share indices are refused rather than silently wrong", () => {
  const shares = enc.splitSecret(enc.generateGroupKey(), 3, 2);
  assert.throws(
    () => enc.combineShares([shares[0], shares[0]]),
    /Duplicate share indices/,
  );
});

test("a recovered key is checked against the epoch commitment", () => {
  const secret = enc.generateGroupKey();
  const epoch = {
    daoId: 1,
    epoch: 1,
    threshold: 2,
    memberCount: 3,
    keyCommitment: enc.keyCommitment(secret),
    rotationReason: "genesis",
    createdAt: new Date().toISOString(),
    active: true,
  };

  const shares = enc.splitSecret(secret, 3, 2);
  assert.equal(enc.verifyGroupKey(enc.combineShares(shares.slice(0, 2)), epoch), true);
  assert.equal(enc.verifyGroupKey(enc.generateGroupKey(), epoch), false);
});

// ============================================
// MEMBER / NON-MEMBER
// ============================================

const DAO = 42;

/** A member with a device secret and their derived wrapping key. */
function makeMember(memberId) {
  const secret = crypto.randomBytes(32);
  return {
    memberId,
    secret,
    key: enc.deriveMemberKey(secret, DAO, memberId),
  };
}

test("a member decrypts governance content; a non-member cannot", () => {
  const groupKey = enc.generateGroupKey();
  const alice = makeMember("alice");
  const mallory = makeMember("mallory");

  const wrap = enc.wrapGroupKeyForMember(groupKey, alice.key, DAO, 1, "alice");
  const envelope = enc.encryptContent(groupKey, {
    daoId: DAO,
    epoch: 1,
    contentType: "proposal",
    contentId: "prop-1",
    plaintext: "Treasury: allocate 10,000 XLM to the audit fund.",
  });

  // Member: unwrap, then read.
  const memberKey = enc.unwrapGroupKeyForMember(wrap, alice.key, DAO, 1, "alice");
  assert.ok(memberKey.equals(groupKey));
  assert.equal(
    enc.decryptContent(memberKey, envelope),
    "Treasury: allocate 10,000 XLM to the audit fund.",
  );

  // Non-member holding the same wrap: the AAD binds it to alice's slot, and
  // her key is not derivable from mallory's secret.
  assert.throws(
    () => enc.unwrapGroupKeyForMember(wrap, mallory.key, DAO, 1, "alice"),
    /Not authorized/,
  );
  assert.throws(
    () => enc.unwrapGroupKeyForMember(wrap, mallory.key, DAO, 1, "mallory"),
    /Not authorized/,
  );

  // And with no key at all the ciphertext is opaque.
  assert.throws(
    () => enc.decryptContent(enc.generateGroupKey(), envelope),
    /Unable to decrypt/,
  );
});

test("member keys are scoped to their DAO and member ID", () => {
  const secret = crypto.randomBytes(32);

  const inDao1 = enc.deriveMemberKey(secret, 1, "alice");
  const inDao2 = enc.deriveMemberKey(secret, 2, "alice");
  const asBob = enc.deriveMemberKey(secret, 1, "bob");

  assert.ok(!inDao1.equals(inDao2), "the same device secret differs across DAOs");
  assert.ok(!inDao1.equals(asBob), "and across members");
  assert.ok(enc.deriveMemberKey(secret, 1, "alice").equals(inDao1), "derivation is stable");
});

// ============================================
// NONCE DOMAIN
// ============================================

test("the nonce domain pins content to its DAO, epoch, type and ID", () => {
  const groupKey = enc.generateGroupKey();
  const envelope = enc.encryptContent(groupKey, {
    daoId: DAO,
    epoch: 1,
    contentType: "proposal",
    contentId: "prop-1",
    plaintext: "body",
  });

  // Each field is authenticated: editing any of them breaks the tag.
  for (const mutation of [
    { daoId: DAO + 1 },
    { epoch: 2 },
    { contentType: "comment" },
    { contentId: "prop-2" },
  ]) {
    assert.throws(
      () => enc.decryptContent(groupKey, { ...envelope, ...mutation }),
      /Unable to decrypt/,
      `mutating ${JSON.stringify(mutation)} must fail authentication`,
    );
  }
});

test("nonces share a per-domain prefix but never repeat", () => {
  const domain = enc.contentDomain(DAO, 1, "proposal", "prop-1");
  const other = enc.contentDomain(DAO, 1, "comment", "prop-1");

  const a = enc.deriveNonce(domain);
  const b = enc.deriveNonce(domain);
  const c = enc.deriveNonce(other);

  assert.equal(a.length, 12);
  assert.ok(a.subarray(0, 4).equals(b.subarray(0, 4)), "same domain, same prefix");
  assert.ok(!a.subarray(0, 4).equals(c.subarray(0, 4)), "different domain, different prefix");
  assert.ok(!a.equals(b), "the random suffix keeps nonces unique within a domain");
});

test("a tampered ciphertext or tag is rejected", () => {
  const groupKey = enc.generateGroupKey();
  const envelope = enc.encryptContent(groupKey, {
    daoId: DAO,
    epoch: 1,
    contentType: "comment",
    contentId: "c-1",
    plaintext: "the quiet part",
  });

  const flipped = Buffer.from(envelope.ciphertext, "base64");
  flipped[0] ^= 0xff;

  assert.throws(
    () =>
      enc.decryptContent(groupKey, {
        ...envelope,
        ciphertext: flipped.toString("base64"),
      }),
    /Unable to decrypt/,
  );
  assert.throws(
    () =>
      enc.decryptContent(groupKey, {
        ...envelope,
        tag: Buffer.alloc(16).toString("base64"),
      }),
    /Unable to decrypt/,
  );
});

// ============================================
// ROTATION
// ============================================

test("rotation cuts a departed member off from new content", () => {
  const daoId = 77;
  const alice = { memberId: "alice", key: enc.deriveMemberKey(crypto.randomBytes(32), daoId, "alice") };
  const bob = { memberId: "bob", key: enc.deriveMemberKey(crypto.randomBytes(32), daoId, "bob") };

  // --- Epoch 1: alice and bob are members. ---
  const epoch1Key = enc.generateGroupKey();
  const epoch1 = enc.recordGroupKeyEpoch({
    daoId,
    epoch: enc.nextEpoch(daoId),
    threshold: 2,
    keyCommitment: enc.keyCommitment(epoch1Key),
    rotationReason: "genesis",
    wraps: [
      enc.wrapGroupKeyForMember(epoch1Key, alice.key, daoId, 1, "alice"),
      enc.wrapGroupKeyForMember(epoch1Key, bob.key, daoId, 1, "bob"),
    ],
    recoveryShares: enc.splitSecret(epoch1Key, 2, 2).map((share) => ({
      index: share.index,
      wrappedShare: share.value.toString("base64"),
    })),
  });
  assert.equal(epoch1.epoch, 1);

  const oldPost = enc.encryptContent(epoch1Key, {
    daoId,
    epoch: 1,
    contentType: "proposal",
    contentId: "p-1",
    plaintext: "written while bob was still a member",
  });
  enc.storeCiphertext(oldPost);

  // --- Epoch 2: bob leaves. Only alice is wrapped in. ---
  const epoch2Key = enc.generateGroupKey();
  const epoch2 = enc.recordGroupKeyEpoch({
    daoId,
    epoch: enc.nextEpoch(daoId),
    threshold: 1,
    keyCommitment: enc.keyCommitment(epoch2Key),
    rotationReason: "member_left",
    wraps: [enc.wrapGroupKeyForMember(epoch2Key, alice.key, daoId, 2, "alice")],
    recoveryShares: [],
  });

  assert.equal(epoch2.epoch, 2);
  assert.equal(enc.getActiveEpoch(daoId).epoch, 2, "the new epoch supersedes the old");
  assert.notEqual(epoch1.keyCommitment, epoch2.keyCommitment, "rotation changes the key");

  const newPost = enc.encryptContent(epoch2Key, {
    daoId,
    epoch: 2,
    contentType: "proposal",
    contentId: "p-2",
    plaintext: "written after bob left",
  });
  enc.storeCiphertext(newPost);

  // Alice can open epoch 2.
  const aliceWrap = enc.getWrappedKey(daoId, 2, "alice");
  assert.ok(aliceWrap, "alice is wrapped into the new epoch");
  const aliceKey = enc.unwrapGroupKeyForMember(aliceWrap, alice.key, daoId, 2, "alice");
  assert.equal(enc.decryptContent(aliceKey, newPost), "written after bob left");

  // Bob has no wrap for epoch 2 at all — the relay has nothing to hand him.
  assert.equal(enc.getWrappedKey(daoId, 2, "bob"), null);

  // Bob's old epoch-1 key does not open epoch-2 content.
  const bobEpoch1Key = enc.unwrapGroupKeyForMember(
    enc.getWrappedKey(daoId, 1, "bob"),
    bob.key,
    daoId,
    1,
    "bob",
  );
  assert.throws(() => enc.decryptContent(bobEpoch1Key, newPost), /Unable to decrypt/);

  // He can still read what he could read while a member — rotation is not
  // retroactive erasure. That is redaction's job.
  assert.equal(
    enc.decryptContent(bobEpoch1Key, oldPost),
    "written while bob was still a member",
  );
});

test("a joiner is wrapped into the new epoch only", () => {
  const daoId = 78;
  const founder = { key: enc.deriveMemberKey(crypto.randomBytes(32), daoId, "founder") };
  const joiner = { key: enc.deriveMemberKey(crypto.randomBytes(32), daoId, "joiner") };

  const key1 = enc.generateGroupKey();
  enc.recordGroupKeyEpoch({
    daoId,
    epoch: enc.nextEpoch(daoId),
    threshold: 1,
    keyCommitment: enc.keyCommitment(key1),
    rotationReason: "genesis",
    wraps: [enc.wrapGroupKeyForMember(key1, founder.key, daoId, 1, "founder")],
    recoveryShares: [],
  });

  const key2 = enc.generateGroupKey();
  enc.recordGroupKeyEpoch({
    daoId,
    epoch: enc.nextEpoch(daoId),
    threshold: 1,
    keyCommitment: enc.keyCommitment(key2),
    rotationReason: "member_joined",
    wraps: [
      enc.wrapGroupKeyForMember(key2, founder.key, daoId, 2, "founder"),
      enc.wrapGroupKeyForMember(key2, joiner.key, daoId, 2, "joiner"),
    ],
    recoveryShares: [],
  });

  assert.equal(enc.getWrappedKey(daoId, 1, "joiner"), null, "no retroactive access");
  assert.ok(enc.getWrappedKey(daoId, 2, "joiner"), "access from the join epoch onward");
  assert.equal(enc.getActiveEpoch(daoId).rotationReason, "member_joined");
});

// ============================================
// REDACTION
// ============================================

test("redaction destroys the stored ciphertext but keeps the reference", () => {
  const daoId = 79;
  const groupKey = enc.generateGroupKey();
  enc.recordGroupKeyEpoch({
    daoId,
    epoch: enc.nextEpoch(daoId),
    threshold: 1,
    keyCommitment: enc.keyCommitment(groupKey),
    rotationReason: "genesis",
    wraps: [
      enc.wrapGroupKeyForMember(
        groupKey,
        enc.deriveMemberKey(crypto.randomBytes(32), daoId, "m"),
        daoId,
        1,
        "m",
      ),
    ],
    recoveryShares: [],
  });

  const envelope = enc.encryptContent(groupKey, {
    daoId,
    epoch: 1,
    contentType: "comment",
    contentId: "abuse-1",
    plaintext: "content requiring removal",
  });
  enc.storeCiphertext(envelope);

  const before = enc.loadCiphertext(daoId, "comment", "abuse-1");
  assert.equal(before.redacted, false);
  assert.equal(enc.decryptContent(groupKey, before.envelope), "content requiring removal");

  assert.equal(
    enc.redactContent(daoId, "comment", "abuse-1", "moderation: abuse report"),
    true,
  );

  const after = enc.loadCiphertext(daoId, "comment", "abuse-1");
  assert.equal(after.redacted, true, "the row survives so references still resolve");
  assert.equal(after.envelope, null, "but nothing decryptable is left");
  assert.equal(after.redactionReason, "moderation: abuse report");
  assert.ok(after.redactedAt);

  // Redaction is idempotent: a second call reports that nothing changed.
  assert.equal(enc.redactContent(daoId, "comment", "abuse-1", "again"), false);
  assert.equal(
    enc.loadCiphertext(daoId, "comment", "abuse-1").redactionReason,
    "moderation: abuse report",
    "the original reason is preserved",
  );
});

test("log redaction keeps the envelope's shape but none of its bytes", () => {
  const groupKey = enc.generateGroupKey();
  const envelope = enc.encryptContent(groupKey, {
    daoId: DAO,
    epoch: 1,
    contentType: "proposal",
    contentId: "p-log",
    plaintext: "a body that must never be logged",
  });

  const safe = enc.redactEnvelopeForLog(envelope);
  const serialised = JSON.stringify(safe);

  assert.equal(safe.daoId, DAO);
  assert.equal(safe.contentId, "p-log");
  assert.equal(safe.ciphertext, "[redacted]");
  assert.equal(safe.nonce, "[redacted]");
  assert.equal(safe.tag, "[redacted]");
  assert.ok(safe.ciphertextBytes > 0);
  assert.ok(!serialised.includes(envelope.ciphertext));
  assert.ok(!serialised.includes(envelope.nonce));
  assert.ok(!serialised.includes(envelope.tag));
});

// ============================================
// HTTP SURFACE
// ============================================

const HTTP_DAO = 91;

test("the relay stores and returns ciphertext without ever seeing plaintext", async () => {
  const groupKey = enc.generateGroupKey();
  const memberKey = enc.deriveMemberKey(crypto.randomBytes(32), HTTP_DAO, "alice");

  // Publish the genesis epoch.
  const published = await auth(
    request(app).post(`/api/v1/encryption/daos/${HTTP_DAO}/epoch`),
  ).send({
    threshold: 1,
    keyCommitment: enc.keyCommitment(groupKey),
    rotationReason: "genesis",
    wraps: [
      {
        memberId: "alice",
        wrapped: enc.wrapGroupKeyForMember(groupKey, memberKey, HTTP_DAO, 1, "alice")
          .wrapped,
      },
    ],
    recoveryShares: [],
  });

  assert.equal(published.status, 201);
  assert.equal(published.body.epoch, 1);

  // Store an encrypted body.
  const plaintext = "This body must never exist in the relay in the clear.";
  const envelope = enc.encryptContent(groupKey, {
    daoId: HTTP_DAO,
    epoch: 1,
    contentType: "proposal",
    contentId: "p-http",
    plaintext,
  });

  const stored = await request(app)
    .put(`/api/v1/encryption/daos/${HTTP_DAO}/content/proposal/p-http`)
    .send({
      v: envelope.v,
      epoch: envelope.epoch,
      nonce: envelope.nonce,
      ciphertext: envelope.ciphertext,
      tag: envelope.tag,
    });

  assert.equal(stored.status, 201);
  assert.equal(stored.body.ciphertext, "[redacted]", "even the ack is redacted");

  // Read it back and open it as the member would.
  const fetched = await request(app).get(
    `/api/v1/encryption/daos/${HTTP_DAO}/content/proposal/p-http`,
  );
  assert.equal(fetched.status, 200);
  assert.ok(
    !JSON.stringify(fetched.body).includes(plaintext),
    "the stored body is returned as ciphertext, never as plaintext",
  );

  const wrapResponse = await auth(
    request(app).get(`/api/v1/encryption/daos/${HTTP_DAO}/members/alice/key`),
  );
  assert.equal(wrapResponse.status, 200);

  const recovered = enc.unwrapGroupKeyForMember(
    { daoId: HTTP_DAO, epoch: 1, memberId: "alice", wrapped: wrapResponse.body.wrapped },
    memberKey,
    HTTP_DAO,
    1,
    "alice",
  );
  assert.equal(enc.decryptContent(recovered, fetched.body), plaintext);
});

test("a non-member gets no wrap from the relay", async () => {
  const response = await auth(
    request(app).get(`/api/v1/encryption/daos/${HTTP_DAO}/members/mallory/key`),
  );

  assert.equal(response.status, 404);
  assert.match(response.body.error, /No group key for this member/);
});

test("content encrypted to a stale epoch is refused", async () => {
  const response = await request(app)
    .put(`/api/v1/encryption/daos/${HTTP_DAO}/content/proposal/p-stale`)
    .send({
      v: 1,
      epoch: 99,
      nonce: Buffer.alloc(12).toString("base64"),
      ciphertext: Buffer.alloc(16).toString("base64"),
      tag: Buffer.alloc(16).toString("base64"),
    });

  assert.equal(response.status, 409);
  assert.equal(response.body.activeEpoch, 1);
});

test("key distribution and rotation require a token", async () => {
  const rotate = await request(app)
    .post(`/api/v1/encryption/daos/${HTTP_DAO}/epoch`)
    .send({
      threshold: 1,
      keyCommitment: "0".repeat(64),
      rotationReason: "manual",
      wraps: [{ memberId: "attacker", wrapped: "AAAA" }],
      recoveryShares: [],
    });
  assert.equal(rotate.status, 401);

  const wrap = await request(app).get(
    `/api/v1/encryption/daos/${HTTP_DAO}/members/alice/key`,
  );
  assert.equal(wrap.status, 401);
});

test("malformed key material and envelopes are rejected with 400", async () => {
  const badCommitment = await auth(
    request(app).post(`/api/v1/encryption/daos/${HTTP_DAO}/epoch`),
  ).send({
    threshold: 1,
    keyCommitment: "not-a-digest",
    rotationReason: "manual",
    wraps: [{ memberId: "alice", wrapped: "AAAA" }],
  });
  assert.equal(badCommitment.status, 400);

  const badReason = await auth(
    request(app).post(`/api/v1/encryption/daos/${HTTP_DAO}/epoch`),
  ).send({
    threshold: 1,
    keyCommitment: "a".repeat(64),
    rotationReason: "because",
    wraps: [{ memberId: "alice", wrapped: "AAAA" }],
  });
  assert.equal(badReason.status, 400);

  const badEnvelope = await request(app)
    .put(`/api/v1/encryption/daos/${HTTP_DAO}/content/proposal/p-bad`)
    .send({ v: 1, epoch: 1, nonce: "not base64!!", ciphertext: "AAAA", tag: "AAAA" });
  assert.equal(badEnvelope.status, 400);

  const badContentType = await request(app)
    .put(`/api/v1/encryption/daos/${HTTP_DAO}/content/ballot/p-bad`)
    .send({ v: 1, epoch: 1, nonce: "AAAA", ciphertext: "AAAA", tag: "AAAA" });
  assert.equal(badContentType.status, 400);
});

test("redacted content is served as a tombstone, not a failure", async () => {
  const redaction = await auth(
    request(app).delete(
      `/api/v1/encryption/daos/${HTTP_DAO}/content/proposal/p-http`,
    ),
  ).send({ reason: "moderation: takedown request" });

  assert.equal(redaction.status, 200);
  assert.equal(redaction.body.redacted, true);

  const fetched = await request(app).get(
    `/api/v1/encryption/daos/${HTTP_DAO}/content/proposal/p-http`,
  );

  assert.equal(fetched.status, 410);
  assert.match(fetched.body.error, /redacted/);
  assert.equal(fetched.body.reason, "moderation: takedown request");
  assert.equal(fetched.body.ciphertext, undefined, "no ciphertext survives redaction");
});

test("redaction requires a token and a reason", async () => {
  const unauthorized = await request(app)
    .delete(`/api/v1/encryption/daos/${HTTP_DAO}/content/proposal/p-http`)
    .send({ reason: "no token here" });
  assert.equal(unauthorized.status, 401);

  const noReason = await auth(
    request(app).delete(
      `/api/v1/encryption/daos/${HTTP_DAO}/content/proposal/p-http`,
    ),
  ).send({ reason: "x" });
  assert.equal(noReason.status, 400);
});
