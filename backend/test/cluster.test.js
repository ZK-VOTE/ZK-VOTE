import test from "node:test";
import assert from "node:assert/strict";

test("Cluster configuration defaults and env parsing", async () => {
  const { config } = await import("../src/config.ts");
  assert.equal(typeof config.clusterEnabled, "boolean");
  assert.equal(typeof config.clusterWorkers, "number");
  assert.ok(config.clusterWorkers >= 1);
});

test("Cluster helper functions in non-cluster mode", async () => {
  const { isLeaderWorker, ClusterRateLimitStore, broadcastCacheInvalidation } = await import(
    "../src/services/cluster.ts"
  );

  // In non-cluster test environment, process is treated as leader
  assert.equal(isLeaderWorker(), true);

  // ClusterRateLimitStore returns fallback in non-cluster process
  const store = new ClusterRateLimitStore("test_limiter");
  store.init({ windowMs: 60000, max: 10 });
  const result = await store.increment("test_key");

  assert.equal(result.totalHits, 1);
  assert.ok(result.resetTime instanceof Date);

  // Broadcast cache invalidation does not throw in single process mode
  assert.doesNotThrow(() => {
    broadcastCacheInvalidation("test_channel", "key_1", { foo: "bar" });
  });
});
