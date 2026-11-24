import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EpochWitnessChangedError,
  fetchAtomicEpochWitness,
  isEpochWithinGrace,
  type EpochWitnessSource,
} from "../src/services/exclusion-proof.js";

function source(overrides: Partial<EpochWitnessSource> = {}): EpochWitnessSource {
  let ledger = 50;
  return {
    async getLatestLedger() {
      return ledger;
    },
    async getEpochInfo() {
      return { epoch: 3, root: "0xabc", advancedAt: 1_000 };
    },
    async getMerklePath() {
      return {
        pathElements: ["1", "2"],
        pathIndices: [0, 1],
      };
    },
    ...overrides,
  };
}

describe("atomic epoch witness", () => {
  it("returns a bundle when epoch and ledger are stable", async () => {
    const bundle = await fetchAtomicEpochWitness(source(), {
      daoId: 1,
      commitment: "99",
    });
    assert.equal(bundle.epoch, 3);
    assert.equal(bundle.root, "0xabc");
    assert.equal(bundle.fetchedAtLedger, 50);
    assert.deepEqual(bundle.pathIndices, [0, 1]);
  });

  it("retries when the epoch advances mid-read", async () => {
    let calls = 0;
    const unstable = source({
      async getEpochInfo() {
        calls += 1;
        return calls === 1
          ? { epoch: 3, root: "0xold", advancedAt: 1_000 }
          : { epoch: 4, root: "0xnew", advancedAt: 2_000 };
      },
    });
    const bundle = await fetchAtomicEpochWitness(unstable, {
      daoId: 1,
      commitment: "99",
    });
    assert.equal(bundle.epoch, 4);
    assert.equal(bundle.root, "0xnew");
  });

  it("fails closed if the witness keeps changing", async () => {
    let epoch = 0;
    const flapping = source({
      async getEpochInfo() {
        epoch += 1;
        return { epoch, root: `0x${epoch}`, advancedAt: epoch };
      },
    });
    await assert.rejects(
      fetchAtomicEpochWitness(flapping, {
        daoId: 1,
        commitment: "99",
        maxAttempts: 2,
      }),
      EpochWitnessChangedError,
    );
  });

  it("mirrors the on-chain grace window", () => {
    assert.equal(isEpochWithinGrace({ epoch: 5, advancedAt: 100 }, 5, 100, 200), true);
    assert.equal(isEpochWithinGrace({ epoch: 4, advancedAt: 100 }, 5, 200, 300), true);
    assert.equal(isEpochWithinGrace({ epoch: 4, advancedAt: 100 }, 5, 200, 700), false);
    assert.equal(isEpochWithinGrace({ epoch: 6, advancedAt: 100 }, 5, 200, 300), false);
  });
});
