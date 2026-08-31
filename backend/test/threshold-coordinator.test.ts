import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  initializeDKG,
  registerAuthority,
  finalizeDKG,
  encryptAndSubmitVote,
  computeEncryptedTally,
  generateAuthorityDecryptionShare,
  computeFinalTally,
  getProtocolState,
} from "../src/services/threshold-coordinator.js";

const DAO_ID = 1;
const PROPOSAL_ID = 1;
const THRESHOLD_N = 3;
const THRESHOLD_T = 2;

async function setupCompletedDKG(): Promise<void> {
  await initializeDKG(DAO_ID, PROPOSAL_ID, THRESHOLD_N, THRESHOLD_T, "creator");
  for (let i = 0; i < THRESHOLD_N; i++) {
    await registerAuthority(
      DAO_ID,
      PROPOSAL_ID,
      `authority-${i}`,
      `Auth ${i}`,
      `verifier-${i}`,
    );
  }
  await finalizeDKG(DAO_ID, PROPOSAL_ID);
}

describe("Threshold Coordinator", () => {
  describe("initializeDKG", () => {
    it("should initialize a DKG round", async () => {
      const round = await initializeDKG(
        DAO_ID,
        PROPOSAL_ID,
        THRESHOLD_N,
        THRESHOLD_T,
        "creator-address",
      );
      assert.strictEqual(round.thresholdN, THRESHOLD_N);
      assert.strictEqual(round.thresholdT, THRESHOLD_T);
      assert.strictEqual(round.phase, "registration");
      assert.strictEqual(round.authorities.length, 0);
    });
  });

  describe("registerAuthority", () => {
    it("should register an authority and return shares", async () => {
      await initializeDKG(
        DAO_ID,
        PROPOSAL_ID,
        THRESHOLD_N,
        THRESHOLD_T,
        "creator",
      );
      const result = await registerAuthority(
        DAO_ID,
        PROPOSAL_ID,
        "authority-0",
        "Auth 0",
        "verifier-0",
      );
      assert.ok(result.shares.length > 0);
      assert.ok(result.commitments.length > 0);
    });

    it("should increment authority index", async () => {
      await initializeDKG(
        DAO_ID,
        PROPOSAL_ID,
        THRESHOLD_N,
        THRESHOLD_T,
        "creator",
      );
      const r1 = await registerAuthority(
        DAO_ID,
        PROPOSAL_ID,
        "authority-0",
        "Auth 0",
        "v0",
      );
      const r2 = await registerAuthority(
        DAO_ID,
        PROPOSAL_ID,
        "authority-1",
        "Auth 1",
        "v1",
      );
      assert.notStrictEqual(r1.shares, r2.shares);
    });
  });

  describe("finalizeDKG", () => {
    it("should compute joint public key", async () => {
      await initializeDKG(
        DAO_ID,
        PROPOSAL_ID,
        THRESHOLD_N,
        THRESHOLD_T,
        "creator",
      );
      for (let i = 0; i < THRESHOLD_N; i++) {
        await registerAuthority(
          DAO_ID,
          PROPOSAL_ID,
          `authority-${i}`,
          `Auth ${i}`,
          `v${i}`,
        );
      }
      const result = await finalizeDKG(DAO_ID, PROPOSAL_ID);
      assert.ok(result.jointPublicKey.length > 0);
      assert.strictEqual(result.authorities.length, THRESHOLD_N);
    });

    it("should throw if no round exists", async () => {
      await assert.rejects(
        () => finalizeDKG(999, 999),
        /DKG round not found/,
      );
    });
  });

  describe("encryptAndSubmitVote", () => {
    it("should encrypt a vote", async () => {
      await setupCompletedDKG();
      const ct = await encryptAndSubmitVote(
        DAO_ID,
        PROPOSAL_ID,
        1,
        "nullifier-1",
      );
      assert.ok(ct.c1);
      assert.ok(ct.c2);
    });

    it("should throw if DKG not completed", async () => {
      await assert.rejects(
        () => encryptAndSubmitVote(DAO_ID, PROPOSAL_ID, 1, "null-1"),
        /DKG not completed/,
      );
    });
  });

  describe("computeEncryptedTally", () => {
    it("should aggregate encrypted votes", async () => {
      await setupCompletedDKG();
      await encryptAndSubmitVote(DAO_ID, PROPOSAL_ID, 1, "null-1");
      await encryptAndSubmitVote(DAO_ID, PROPOSAL_ID, 0, "null-2");
      const tally = await computeEncryptedTally(DAO_ID, PROPOSAL_ID);
      assert.ok(tally.c1);
      assert.ok(tally.c2);
    });

    it("should throw if no votes", async () => {
      await setupCompletedDKG();
      await assert.rejects(
        () => computeEncryptedTally(DAO_ID, PROPOSAL_ID),
        /No votes to tally/,
      );
    });
  });

  describe("generateAuthorityDecryptionShare", () => {
    it("should generate a decryption share", async () => {
      await setupCompletedDKG();
      await encryptAndSubmitVote(DAO_ID, PROPOSAL_ID, 1, "null-1");
      const tally = await computeEncryptedTally(DAO_ID, PROPOSAL_ID);
      const share = await generateAuthorityDecryptionShare(
        DAO_ID,
        PROPOSAL_ID,
        "authority-0",
        123n,
        tally,
      );
      assert.ok(share.length > 0);
    });

    it("should throw if authority not found", async () => {
      await setupCompletedDKG();
      await encryptAndSubmitVote(DAO_ID, PROPOSAL_ID, 1, "null-1");
      const tally = await computeEncryptedTally(DAO_ID, PROPOSAL_ID);
      await assert.rejects(
        () =>
          generateAuthorityDecryptionShare(
            DAO_ID,
            PROPOSAL_ID,
            "nonexistent",
            123n,
            tally,
          ),
        /Authority not found/,
      );
    });
  });

  describe("computeFinalTally", () => {
    it("should throw if insufficient shares", async () => {
      await setupCompletedDKG();
      await encryptAndSubmitVote(DAO_ID, PROPOSAL_ID, 1, "null-1");
      const tally = await computeEncryptedTally(DAO_ID, PROPOSAL_ID);
      await assert.rejects(
        () => computeFinalTally(DAO_ID, PROPOSAL_ID, tally),
        /Insufficient decryption shares/,
      );
    });
  });

  describe("getProtocolState", () => {
    it("should return initial state", async () => {
      const ps = getProtocolState(DAO_ID, PROPOSAL_ID);
      assert.strictEqual(ps.encryptedVoteCount, 0);
      assert.strictEqual(ps.decryptionShareCount, 0);
      assert.strictEqual(ps.isTallyDecrypted, false);
      assert.strictEqual(ps.decryptedTally, null);
    });

    it("should reflect DKG completion", async () => {
      await setupCompletedDKG();
      const ps = getProtocolState(DAO_ID, PROPOSAL_ID);
      assert.ok(ps.dkgRound);
      assert.strictEqual(ps.dkgRound.phase, "completed");
    });

    it("should track encrypted vote count", async () => {
      await setupCompletedDKG();
      await encryptAndSubmitVote(DAO_ID, PROPOSAL_ID, 1, "null-1");
      const ps = getProtocolState(DAO_ID, PROPOSAL_ID);
      assert.strictEqual(ps.encryptedVoteCount, 1);
    });
  });
});
