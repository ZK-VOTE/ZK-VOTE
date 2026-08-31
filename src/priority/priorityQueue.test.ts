/**
 * priorityQueue.test.ts
 * -----------------------------------------------------------------------
 * Simulated load test for issue #188's acceptance criterion:
 * "Test priority behavior under simulated load."
 *
 * Run with: npx ts-node src/priority/priorityQueue.test.ts
 * -----------------------------------------------------------------------
 */

import assert from "assert";
import { PriorityQueue, RequestTimeoutError } from "./priorityQueue";
import { PriorityTier } from "./priorityConfig";

function fakeWork(ms: number) {
  return () => new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const queue = new PriorityQueue();

  // Flood LOW tier with 200 slow requests to simulate heavy read traffic.
  const lowPromises: Promise<void>[] = [];
  for (let i = 0; i < 200; i++) {
    lowPromises.push(
      queue.enqueue(PriorityTier.LOW, fakeWork(50)).catch((err) => {
        // Some LOW requests are expected to time out under this flood --
        // that's acceptable; CRITICAL must not be affected.
        if (!(err instanceof RequestTimeoutError)) throw err;
      })
    );
  }

  // Also flood MEDIUM tier moderately.
  const mediumPromises: Promise<void>[] = [];
  for (let i = 0; i < 80; i++) {
    mediumPromises.push(
      queue.enqueue(PriorityTier.MEDIUM, fakeWork(40)).catch((err) => {
        if (!(err instanceof RequestTimeoutError)) throw err;
      })
    );
  }

  // Interleave 50 CRITICAL vote submissions while the flood is in-flight.
  const criticalLatencies: number[] = [];
  const criticalPromises: Promise<void>[] = [];
  for (let i = 0; i < 50; i++) {
    const start = Date.now();
    const p = queue.enqueue(PriorityTier.CRITICAL, fakeWork(10)).then(() => {
      criticalLatencies.push(Date.now() - start);
    });
    criticalPromises.push(p);
    // stagger slightly, like real incoming traffic
    await new Promise((r) => setTimeout(r, 2));
  }

  const results = await Promise.allSettled([
    ...criticalPromises,
    ...lowPromises,
    ...mediumPromises,
  ]);

  const criticalResults = results.slice(0, criticalPromises.length);
  const criticalRejections = criticalResults.filter((r) => r.status === "rejected");

  console.log("=== Priority Queue Load Test ===");
  console.log(`CRITICAL requests: ${criticalPromises.length}, rejected: ${criticalRejections.length}`);
  console.log(
    `CRITICAL avg latency: ${(
      criticalLatencies.reduce((a, b) => a + b, 0) / criticalLatencies.length
    ).toFixed(1)}ms, max: ${Math.max(...criticalLatencies)}ms`
  );

  const lowRejections = results
    .slice(criticalPromises.length, criticalPromises.length + lowPromises.length)
    .filter((r) => r.status === "rejected").length;
  console.log(`LOW tier requests rejected/timed out under flood: ${lowRejections}/${lowPromises.length}`);

  // ---- Assertions ----
  assert.strictEqual(criticalRejections.length, 0, "no CRITICAL request should be rejected");
  assert.ok(
    Math.max(...criticalLatencies) < 500,
    "CRITICAL max latency should stay low despite LOW/MEDIUM flood"
  );

  console.log("\nAll assertions passed. CRITICAL tier was never blocked by lower-priority load. ✅");
}

run().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});
