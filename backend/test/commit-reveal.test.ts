import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CommitRevealError,
  commitRegistration,
  computeCommitmentHash,
  generateRegistrationSalt,
  revealRegistration,
  type CommitRevealChain,
} from "../src/services/commit-reveal.js";

function fakeChain(startLedger = 100): CommitRevealChain & {
  ledger: number;
  commits: unknown[];
  reveals: unknown[];
} {
  const state = {
    ledger: startLedger,
    commits: [] as unknown[],
    reveals: [] as unknown[],
    async getLatestLedger() {
      return state.ledger;
    },
    async submitCommit(params: {
      daoId: number;
      commitHash: string;
      caller: string;
    }) {
      state.commits.push(params);
      return { ledger: state.ledger, txHash: "commit-tx" };
    },
    async submitReveal(params: {
      daoId: number;
      commitment: string;
      salt: string;
      caller: string;
    }) {
      state.reveals.push(params);
      return { ledger: state.ledger, txHash: "reveal-tx" };
    },
  };
  return state;
}

describe("commit-reveal membership", () => {
  it("hides the commitment until reveal and enforces the one-ledger delay", async () => {
    const chain = fakeChain(500);
    const commitment = "12345678901234567890";
    const committed = await commitRegistration(chain, {
      daoId: 7,
      commitment,
      caller: "GAAA",
    });

    assert.equal(committed.committedAtLedger, 500);
    assert.match(committed.commitHash, /^[0-9a-f]{64}$/);
    assert.notEqual(
      committed.commitHash,
      commitment.padStart(64, "0"),
      "hash must not equal the raw commitment",
    );
    assert.equal(
      computeCommitmentHash(commitment, committed.salt),
      committed.commitHash,
    );

    await assert.rejects(
      revealRegistration(chain, {
        daoId: 7,
        commitment,
        salt: committed.salt,
        caller: "GAAA",
        committedAtLedger: committed.committedAtLedger,
      }),
      (err: unknown) =>
        err instanceof CommitRevealError && err.code === "REVEAL_TOO_EARLY",
    );

    chain.ledger = 501;
    const revealed = await revealRegistration(chain, {
      daoId: 7,
      commitment,
      salt: committed.salt,
      caller: "GAAA",
      committedAtLedger: committed.committedAtLedger,
      commitHash: committed.commitHash,
    });
    assert.equal(revealed.revealedAtLedger, 501);
    assert.equal(chain.reveals.length, 1);
  });

  it("rejects a salt that does not match the committed hash", async () => {
    const chain = fakeChain(10);
    const commitment = "42";
    const committed = await commitRegistration(chain, {
      daoId: 1,
      commitment,
      caller: "GAAA",
    });
    chain.ledger = 11;

    await assert.rejects(
      revealRegistration(chain, {
        daoId: 1,
        commitment,
        salt: generateRegistrationSalt(),
        caller: "GAAA",
        committedAtLedger: committed.committedAtLedger,
        commitHash: committed.commitHash,
      }),
      (err: unknown) =>
        err instanceof CommitRevealError &&
        err.code === "COMMITMENT_MISMATCH",
    );
  });
});
