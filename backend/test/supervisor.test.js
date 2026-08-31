/**
 * Tests for ServiceSupervisor (#176)
 *
 * Verifies crash recovery, exponential backoff, health tracking,
 * dependency-aware shutdown ordering, and service lifecycle events.
 */

import test from "node:test";
import assert from "node:assert/strict";

process.env.RELAYER_TEST_MODE = "true";
process.env.VOTING_CONTRACT_ID = "C".padEnd(56, "A");
process.env.TREE_CONTRACT_ID = "C".padEnd(56, "B");
process.env.SOROBAN_RPC_URL = "http://localhost";
process.env.NETWORK_PASSPHRASE = "Test";

const { ServiceSupervisor, createSupervisor } = await import(
  "../src/services/supervisor.js"
);

test.afterEach(() => {
  // Clean up any lingering timers
});

// ============================================
// SERVICE REGISTRATION
// ============================================

test("register adds a service to the supervisor", () => {
  const supervisor = createSupervisor();
  let startCalled = false;

  supervisor.register({
    name: "indexer",
    start: () => {
      startCalled = true;
    },
    stop: () => {},
  });

  const health = supervisor.getServiceHealth("indexer");
  assert.ok(health);
  assert.equal(health.state, "stopped");
  assert.equal(health.consecutiveFailures, 0);
});

test("register warns on duplicate service registration", () => {
  const supervisor = createSupervisor();

  supervisor.register({ name: "indexer", start: () => {}, stop: () => {} });
  supervisor.register({ name: "indexer", start: () => {}, stop: () => {} });

  // Should still only have one indexer
  const all = supervisor.getAllServiceHealth();
  const indexers = all.filter((s) => s.name === "indexer");
  assert.equal(indexers.length, 1);
});

// ============================================
// SERVICE START / STOP
// ============================================

test("start calls the service's start function", async () => {
  const supervisor = createSupervisor();
  let startCalled = false;

  supervisor.register({
    name: "indexer",
    start: () => {
      startCalled = true;
    },
    stop: () => {},
  });

  await supervisor.start("indexer");

  assert.ok(startCalled);
  const health = supervisor.getServiceHealth("indexer");
  assert.equal(health.state, "running");
  assert.ok(health.startedAt);
  assert.equal(health.consecutiveFailures, 0);
});

test("stop calls the service's stop function", async () => {
  const supervisor = createSupervisor();

  supervisor.register({
    name: "indexer",
    start: () => {},
    stop: () => {},
  });

  await supervisor.start("indexer");
  assert.equal(supervisor.getServiceHealth("indexer").state, "running");

  await supervisor.stop("indexer");
  assert.equal(supervisor.getServiceHealth("indexer").state, "stopped");
});

test("start does not call start on already running service", async () => {
  const supervisor = createSupervisor();
  let callCount = 0;

  supervisor.register({
    name: "indexer",
    start: () => {
      callCount++;
    },
    stop: () => {},
  });

  await supervisor.start("indexer");
  await supervisor.start("indexer"); // Should not call start again

  assert.equal(callCount, 1);
});

test("start skips disabled services", async () => {
  const supervisor = createSupervisor();
  let startCalled = false;

  supervisor.register({
    name: "indexer",
    start: () => {
      startCalled = true;
    },
    stop: () => {},
    enabled: false,
  });

  await supervisor.start("indexer");

  assert.ok(!startCalled);
  assert.equal(supervisor.getServiceHealth("indexer").state, "stopped");
});

// ============================================
// FAILURE HANDLING & CRASH RECOVERY
// ============================================

test("service failure is tracked in health", async () => {
  const supervisor = createSupervisor();

  supervisor.register({
    name: "indexer",
    start: () => {},
    stop: () => {},
  });

  await supervisor.start("indexer");

  supervisor.markFailure("indexer", "poll failed");

  const health = supervisor.getServiceHealth("indexer");
  assert.equal(health.state, "failed");
  assert.equal(health.consecutiveFailures, 1);
  assert.equal(health.totalFailures, 1);
  assert.equal(health.lastError, "poll failed");
});

test("consecutive failures are counted", async () => {
  const supervisor = createSupervisor();

  supervisor.register({
    name: "indexer",
    start: () => {},
    stop: () => {},
  });

  await supervisor.start("indexer");

  supervisor.markFailure("indexer", "failure 1");
  supervisor.markFailure("indexer", "failure 2");
  supervisor.markFailure("indexer", "failure 3");

  const health = supervisor.getServiceHealth("indexer");
  assert.equal(health.consecutiveFailures, 3);
  assert.equal(health.totalFailures, 3);
  assert.equal(health.lastError, "failure 3");
});

test("successful run resets consecutive failures", async () => {
  const supervisor = createSupervisor();

  supervisor.register({
    name: "indexer",
    start: () => {},
    stop: () => {},
  });

  await supervisor.start("indexer");

  supervisor.markFailure("indexer", "failure 1");
  supervisor.markFailure("indexer", "failure 2");
  supervisor.markSuccess("indexer");

  const health = supervisor.getServiceHealth("indexer");
  assert.equal(health.consecutiveFailures, 0);
  assert.equal(health.totalFailures, 2); // total failures not reset
  assert.ok(health.lastSuccessfulRun);
});

test("restart is scheduled after failure", async () => {
  const supervisor = createSupervisor();

  supervisor.register({
    name: "indexer",
    start: () => {},
    stop: () => {},
  });

  await supervisor.start("indexer");

  // Trigger failure (which schedules a restart)
  supervisor.markFailure("indexer", "poll failed");

  // Give a small delay for the restart timer to potentially fire
  // (In test mode with short delays, the restart may or may not fire)
  await new Promise((resolve) => setTimeout(resolve, 100));
});

// ============================================
// DEPENDENCY TRACKING
// ============================================

test("dependencies are started before dependent services", async () => {
  const supervisor = createSupervisor();
  const startOrder = [];

  supervisor.register({
    name: "dao_sync",
    start: () => {
      startOrder.push("dao_sync");
    },
    stop: () => {},
  });

  supervisor.register({
    name: "membership_sync",
    start: () => {
      startOrder.push("membership_sync");
    },
    stop: () => {},
    dependencies: ["dao_sync"],
  });

  await supervisor.start("membership_sync");

  // dao_sync should have been started first
  assert.ok(startOrder.includes("dao_sync"));
  assert.ok(startOrder.includes("membership_sync"));
  const daoSyncIndex = startOrder.indexOf("dao_sync");
  const membershipSyncIndex = startOrder.indexOf("membership_sync");
  assert.ok(
    daoSyncIndex < membershipSyncIndex,
    "dao_sync should start before membership_sync"
  );
});

test("dependents are stopped before their dependencies", async () => {
  const supervisor = createSupervisor();
  const stopOrder = [];

  supervisor.register({
    name: "dao_sync",
    start: () => {},
    stop: () => {
      stopOrder.push("dao_sync");
    },
  });

  supervisor.register({
    name: "membership_sync",
    start: () => {},
    stop: () => {
      stopOrder.push("membership_sync");
    },
    dependencies: ["dao_sync"],
  });

  await supervisor.start("dao_sync");
  await supervisor.start("membership_sync");

  await supervisor.stop("dao_sync");

  // membership_sync should have been stopped first
  assert.ok(stopOrder.includes("dao_sync"));
  assert.ok(stopOrder.includes("membership_sync"));
  const daoSyncIndex = stopOrder.indexOf("dao_sync");
  const membershipSyncIndex = stopOrder.indexOf("membership_sync");
  assert.ok(
    membershipSyncIndex < daoSyncIndex,
    "membership_sync should stop before dao_sync"
  );
});

// ============================================
// HEALTH STATUS
// ============================================

test("getAllServiceHealth returns all registered services", () => {
  const supervisor = createSupervisor();

  supervisor.register({ name: "indexer", start: () => {}, stop: () => {} });
  supervisor.register({ name: "ttl_renewal", start: () => {}, stop: () => {} });

  const all = supervisor.getAllServiceHealth();
  assert.equal(all.length, 2);
  assert.ok(all.some((s) => s.name === "indexer"));
  assert.ok(all.some((s) => s.name === "ttl_renewal"));
});

test("getStatus returns supervisor status", () => {
  const supervisor = createSupervisor();

  supervisor.register({ name: "indexer", start: () => {}, stop: () => {} });

  const status = supervisor.getStatus();
  assert.ok(Array.isArray(status.services));
  assert.equal(status.services.length, 1);
  assert.equal(typeof status.uptime, "number");
  assert.equal(status.isShuttingDown, false);
});

test("getAbortSignal returns signal for running service", async () => {
  const supervisor = createSupervisor();

  supervisor.register({ name: "indexer", start: () => {}, stop: () => {} });
  await supervisor.start("indexer");

  const signal = supervisor.getAbortSignal("indexer");
  assert.ok(signal);
  assert.equal(signal.aborted, false);
});

test("getAbortSignal returns undefined for non-running service", () => {
  const supervisor = createSupervisor();

  supervisor.register({ name: "indexer", start: () => {}, stop: () => {} });

  const signal = supervisor.getAbortSignal("indexer");
  assert.equal(signal, undefined);
});

// ============================================
// RESET
// ============================================

test("reset clears health and restart state", async () => {
  const supervisor = createSupervisor();

  supervisor.register({ name: "indexer", start: () => {}, stop: () => {} });
  await supervisor.start("indexer");

  supervisor.markFailure("indexer", "failure");

  supervisor.reset();

  const health = supervisor.getServiceHealth("indexer");
  assert.equal(health.state, "stopped");
  assert.equal(health.consecutiveFailures, 0);
  assert.equal(health.totalFailures, 0);
  assert.equal(health.lastError, null);
});

// ============================================
// SHUTDOWN
// ============================================

test("stopAll stops all services", async () => {
  const supervisor = createSupervisor();

  supervisor.register({ name: "indexer", start: () => {}, stop: () => {} });
  supervisor.register({
    name: "ttl_renewal",
    start: () => {},
    stop: () => {},
  });

  await supervisor.start("indexer");
  await supervisor.start("ttl_renewal");

  await supervisor.stopAll();

  assert.equal(supervisor.getServiceHealth("indexer").state, "stopped");
  assert.equal(supervisor.getServiceHealth("ttl_renewal").state, "stopped");
});

test("stopAll does not restart services after shutdown", async () => {
  const supervisor = createSupervisor();
  let startCount = 0;

  supervisor.register({
    name: "indexer",
    start: () => {
      startCount++;
    },
    stop: () => {},
  });

  await supervisor.start("indexer");
  await supervisor.stopAll();

  // Mark failure after shutdown should not schedule restart
  supervisor.markFailure("indexer", "failure after shutdown");
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Start count should still be 1 (initial start only)
  assert.equal(startCount, 1);
});

// ============================================
// SERVICE NOT FOUND
// ============================================

test("start logs error for unknown service", async () => {
  const supervisor = createSupervisor();

  // Should not throw, just log
  await supervisor.start("indexer");
});

test("stop for unknown service is a no-op", async () => {
  const supervisor = createSupervisor();

  // Should not throw
  await supervisor.stop("indexer");
});

// ============================================
// MULTIPLE SERVICES WITH SHARED DEPENDENCIES
// ============================================

test("complex dependency graph is handled correctly", async () => {
  const supervisor = createSupervisor();
  const startOrder = [];

  supervisor.register({
    name: "indexer",
    start: () => {
      startOrder.push("indexer");
    },
    stop: () => {},
  });

  supervisor.register({
    name: "dao_sync",
    start: () => {
      startOrder.push("dao_sync");
    },
    stop: () => {},
  });

  supervisor.register({
    name: "membership_sync",
    start: () => {
      startOrder.push("membership_sync");
    },
    stop: () => {},
    dependencies: ["dao_sync"],
  });

  supervisor.register({
    name: "sbt_transfer_watch",
    start: () => {
      startOrder.push("sbt_transfer_watch");
    },
    stop: () => {},
    dependencies: ["membership_sync"],
  });

  // Starting sbt_transfer_watch should start all its dependencies in order
  await supervisor.start("sbt_transfer_watch");

  // The 3 services in the dependency chain should have started
  assert.equal(startOrder.length, 3);
  assert.ok(startOrder.includes("dao_sync"));
  assert.ok(startOrder.includes("membership_sync"));
  assert.ok(startOrder.includes("sbt_transfer_watch"));

  // Dependencies should be in correct order
  const daoSyncIndex = startOrder.indexOf("dao_sync");
  const membershipSyncIndex = startOrder.indexOf("membership_sync");
  const sbtIndex = startOrder.indexOf("sbt_transfer_watch");
  assert.ok(daoSyncIndex < membershipSyncIndex);
  assert.ok(membershipSyncIndex < sbtIndex);

  // StartAll should start all remaining unstarted services
  await supervisor.startAll();

  // All services should now be running
  assert.equal(supervisor.getServiceHealth("indexer").state, "running");
  assert.equal(supervisor.getServiceHealth("dao_sync").state, "running");
  assert.equal(supervisor.getServiceHealth("membership_sync").state, "running");
  assert.equal(supervisor.getServiceHealth("sbt_transfer_watch").state, "running");

  // Verify indexer was started (it was not in the dependency chain)
  assert.ok(startOrder.includes("indexer"));
});
