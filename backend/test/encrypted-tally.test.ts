import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EncryptedTallyService,
  TallyError,
} from "../src/services/encrypted-tally.js";
import { encryptBallot } from "../src/services/elgamal.js";

describe("encrypted tally ceremony", () => {
  it("decrypts 10 yes / 5 no without exposing individual ballots", async () => {
    let now = 1_000;
    const service = new EncryptedTallyService({ now: () => now });
    const { shares } = await service.createElection({
      electionId: "dao-1:proposal-1",
      endTime: 2_000,
      threshold: 2,
      totalAuthorities: 3,
    });
    assert.equal(shares.length, 3);

    const publicKey = service.getPublicKey("dao-1:proposal-1");
    for (let i = 0; i < 10; i++) {
      const ballot = await encryptBallot(publicKey, 1);
      await service.registerBallot("dao-1:proposal-1", ballot);
    }
    for (let i = 0; i < 5; i++) {
      const ballot = await encryptBallot(publicKey, 0);
      await service.registerBallot("dao-1:proposal-1", ballot);
    }

    const count = await service.registerBallot(
      "dao-1:proposal-1",
      await encryptBallot(publicKey, 1),
    );
    assert.equal(count.count, 16);

    now = 2_001;
    const approval1 = await service.createApproval("dao-1:proposal-1", 1);
    await assert.rejects(
      service.finalize({
        electionId: "dao-1:proposal-1",
        approvals: [approval1],
      }),
      (err: unknown) =>
        err instanceof TallyError && err.code === "INSUFFICIENT_APPROVALS",
    );

    const approval2 = await service.createApproval("dao-1:proposal-1", 2);
    const result = await service.finalize({
      electionId: "dao-1:proposal-1",
      approvals: [approval1, approval2],
    });

    assert.equal(result.ballotCount, 16);
    assert.equal(result.yesVotes, 11);
    assert.equal(result.noVotes, 5);
    assert.equal(result.approvers.length, 2);
    assert.match(result.transcriptHash, /^[0-9a-f]{64}$/);
    assert.equal(result.aggregateC1.length, 128);
    assert.equal(result.aggregateCYes.length, 128);
    assert.equal(result.aggregateCNo.length, 128);
  });

  it("refuses to reveal before end_time and refuses duplicate approvals", async () => {
    let now = 0;
    const service = new EncryptedTallyService({ now: () => now });
    await service.createElection({
      electionId: "e",
      endTime: 100,
      threshold: 2,
      totalAuthorities: 3,
    });
    const publicKey = service.getPublicKey("e");
    await service.registerBallot("e", await encryptBallot(publicKey, 1));

    const approval1 = await service.createApproval("e", 1);
    await assert.rejects(
      service.finalize({ electionId: "e", approvals: [approval1] }),
      (err: unknown) =>
        err instanceof TallyError && err.code === "ELECTION_STILL_OPEN",
    );

    now = 101;
    await assert.rejects(
      service.finalize({
        electionId: "e",
        approvals: [approval1, approval1],
      }),
      (err: unknown) =>
        err instanceof TallyError && err.code === "INSUFFICIENT_APPROVALS",
    );
  });
});
