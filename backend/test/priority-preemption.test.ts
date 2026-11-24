import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { priorityStarvationTotal } from "../src/services/metrics.js";
import {
  classifyPriority,
  PriorityTier,
  type TierSettings,
} from "../src/priority/priorityConfig.js";
import { PriorityQueue } from "../src/priority/priorityQueue.js";

const settings: Record<PriorityTier, TierSettings> = {
  [PriorityTier.CRITICAL]: { concurrency: 1, maxQueueWaitMs: 1_000 },
  [PriorityTier.HIGH]: { concurrency: 1, maxQueueWaitMs: 2_000 },
  [PriorityTier.NORMAL]: { concurrency: 1, maxQueueWaitMs: 3_000 },
  [PriorityTier.LOW]: { concurrency: 1, maxQueueWaitMs: 5_000 },
};

function work(ms: number, done?: () => void): () => Promise<void> {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    done?.();
  };
}

describe("priority queue", () => {
  it("classifies vote, admin, dispute, payment, and comment writes identically on all API mounts", () => {
    for (const prefix of ["", "/api/v1", "/api/v2"]) {
      assert.equal(
        classifyPriority("POST", `${prefix}/vote`),
        PriorityTier.CRITICAL,
      );
      assert.equal(
        classifyPriority("POST", `${prefix}/admin/shutdown`),
        PriorityTier.HIGH,
      );
      assert.equal(
        classifyPriority("POST", `${prefix}/disputes/42/resolve`),
        PriorityTier.HIGH,
      );
      assert.equal(
        classifyPriority("POST", `${prefix}/dispute`),
        PriorityTier.HIGH,
      );
      assert.equal(
        classifyPriority("POST", `${prefix}/pay`),
        PriorityTier.NORMAL,
      );
      assert.equal(
        classifyPriority("POST", `${prefix}/pay/batch`),
        PriorityTier.NORMAL,
      );
      assert.equal(
        classifyPriority("POST", `${prefix}/swap`),
        PriorityTier.NORMAL,
      );
      assert.equal(
        classifyPriority("POST", `${prefix}/ramp/deposit`),
        PriorityTier.NORMAL,
      );
      assert.equal(
        classifyPriority("POST", `${prefix}/comment/anonymous`),
        PriorityTier.LOW,
      );
    }
  });

  it("does not classify GET requests, even on priority-bearing paths", () => {
    assert.equal(classifyPriority("GET", "/vote"), null);
    assert.equal(classifyPriority("GET", "/admin/status"), null);
    assert.equal(classifyPriority("GET", "/pay"), null);
  });

  it("does not misclassify unrelated paths that merely start with a priority prefix", () => {
    // "/paylater" is not "/pay" — must not share its tier.
    assert.equal(classifyPriority("POST", "/paylater"), null);
    assert.equal(classifyPriority("POST", "/administrator"), null);
  });

  it("starts a vote before a backlog of 100 comments drains", async () => {
    const queue = new PriorityQueue({ settings });
    let completedComments = 0;
    const comments = Array.from({ length: 100 }, () =>
      queue.enqueue(
        PriorityTier.LOW,
        work(2, () => {
          completedComments += 1;
        }),
        "/comment/anonymous",
      ),
    );

    await queue.enqueue(PriorityTier.CRITICAL, work(1), "/vote");
    assert.ok(
      completedComments < 10,
      `vote should preempt the comment backlog; ${completedComments} comments completed first`,
    );
    await Promise.all(comments);
  });

  it("starts an admin/dispute request before a backlog of payment bursts drains (ZV-110)", async () => {
    const queue = new PriorityQueue({ settings });
    let completedPayments = 0;
    const payments = Array.from({ length: 100 }, () =>
      queue.enqueue(
        PriorityTier.NORMAL,
        work(2, () => {
          completedPayments += 1;
        }),
        "/pay",
      ),
    );

    await queue.enqueue(PriorityTier.HIGH, work(1), "/admin/shutdown");
    assert.ok(
      completedPayments < 10,
      `admin/dispute work should preempt the payment backlog; ${completedPayments} payments completed first`,
    );
    await Promise.all(payments);
  });

  it("reserves separate concurrency per tier: a payment burst cannot occupy an admin/dispute worker", async () => {
    const queue = new PriorityQueue({ settings });
    const highInFlight: number[] = [];

    const payments = Array.from({ length: 20 }, () =>
      queue.enqueue(PriorityTier.NORMAL, work(5), "/pay"),
    );
    const disputeResolution = queue.enqueue(
      PriorityTier.HIGH,
      async () => {
        highInFlight.push(
          queue.getQueueDepths().find((d) => d.tier === PriorityTier.HIGH)!
            .inFlight,
        );
      },
      "/disputes/1/resolve",
    );

    await Promise.all([disputeResolution, ...payments]);
    assert.deepEqual(highInFlight, [1]);
  });

  it("increments the starvation metric when critical work waits too long", async () => {
    const before = await priorityStarvationTotal.get();
    const beforeValue = before.values.reduce(
      (sum, value) => sum + value.value,
      0,
    );
    const queue = new PriorityQueue({
      settings,
      starvationThresholdMs: 1,
      onStarvation: ({ tier, route }) => {
        priorityStarvationTotal.inc({ priority: tier, route });
      },
    });

    const blocker = queue.enqueue(PriorityTier.CRITICAL, work(20), "/vote");
    const waitingVote = queue.enqueue(PriorityTier.CRITICAL, work(1), "/vote");
    await Promise.all([blocker, waitingVote]);

    const after = await priorityStarvationTotal.get();
    const afterValue = after.values.reduce(
      (sum, value) => sum + value.value,
      0,
    );
    assert.equal(afterValue, beforeValue + 1);
  });

  it("increments the starvation metric when admin/dispute (HIGH) work waits too long", async () => {
    const before = await priorityStarvationTotal.get();
    const beforeValue = before.values.reduce(
      (sum, value) => sum + value.value,
      0,
    );
    const queue = new PriorityQueue({
      settings,
      starvationThresholdMs: 1,
      onStarvation: ({ tier, route }) => {
        priorityStarvationTotal.inc({ priority: tier, route });
      },
    });

    const blocker = queue.enqueue(
      PriorityTier.HIGH,
      work(20),
      "/admin/shutdown",
    );
    const waiting = queue.enqueue(
      PriorityTier.HIGH,
      work(1),
      "/disputes/1/resolve",
    );
    await Promise.all([blocker, waiting]);

    const after = await priorityStarvationTotal.get();
    const afterValue = after.values.reduce(
      (sum, value) => sum + value.value,
      0,
    );
    assert.equal(afterValue, beforeValue + 1);
  });

  it("reports queue depth and in-flight count per tier via onDepthChange", async () => {
    const snapshots: Array<{
      tier: PriorityTier;
      queued: number;
      inFlight: number;
    }> = [];
    const queue = new PriorityQueue({
      settings,
      onDepthChange: (snapshot) => {
        for (const s of snapshot) snapshots.push(s);
      },
    });

    await queue.enqueue(PriorityTier.NORMAL, work(1), "/pay");
    // The queue's own bookkeeping (inFlight decrement + final drain) runs
    // in a .finally() one microtask tick after the task settles, which can
    // land after this await returns; give it a tick to flush.
    await new Promise((resolve) => setImmediate(resolve));

    const sawInFlight = snapshots.some(
      (s) => s.tier === PriorityTier.NORMAL && s.inFlight === 1,
    );
    assert.ok(sawInFlight, "expected a snapshot while the task was running");

    const normalSnapshots = snapshots.filter(
      (s) => s.tier === PriorityTier.NORMAL,
    );
    const finalSnapshot = normalSnapshots[normalSnapshots.length - 1];
    assert.equal(finalSnapshot.inFlight, 0);
    assert.equal(finalSnapshot.queued, 0);
  });

  it("times out a queued request once it exceeds the tier's max wait", async () => {
    const queue = new PriorityQueue({
      settings: {
        ...settings,
        [PriorityTier.NORMAL]: { concurrency: 1, maxQueueWaitMs: 10 },
      },
    });

    const blocker = queue.enqueue(PriorityTier.NORMAL, work(100), "/pay");
    await assert.rejects(
      queue.enqueue(PriorityTier.NORMAL, work(1), "/pay"),
      /timed out/,
    );
    await blocker;
  });
});
