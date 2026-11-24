/**
 * Factory saga durability / idempotency / compensation / concurrency tests.
 * Uses a temporary SQLite file initialized exactly like production.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(tmpdir(), "zkvote-factory-saga-"));
const DB_PATH = path.join(TEST_DIR, "saga.db");

const { initDb } = await import("../src/services/db.js");
const db = initDb(DB_PATH) as never;

const {
  FactorySagaStore,
  createStepIdempotencyKey,
} = await import("../src/services/factory-saga-store.js");
const {
  FactoryOrchestrator,
  deterministicFactoryAdapter,
} = await import("../src/services/factory-orchestrator.js");

test.after(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function params() {
  return {
    name: "test_dao",
    description: "durable saga",
    creator: "GTEST",
    treasuryTier: "basic" as const,
    initialFunding: 100,
  };
}

async function waitForStatus(
  orchestrator: InstanceType<typeof FactoryOrchestrator>,
  ticketId: string,
  status: string,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const saga = await orchestrator.getStatus(ticketId);
    if (saga?.status === status) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`saga ${ticketId} never reached ${status}`);
}

test("saga state and step results survive a new store instance (restart)", () => {
  const store = new FactorySagaStore(db);
  store.createSaga({
    ticketId: "ticket-restart",
    creator: "GTEST",
    daoName: "test_dao",
    params: params(),
  });
  store.claimStep({
    ticketId: "ticket-restart",
    step: 2,
    name: "reserve_name",
  });
  store.completeStep({
    ticketId: "ticket-restart",
    step: 2,
    contractId: "reservation_1",
  });

  // A fresh store instance models a brand-new process reading the same DB.
  const restarted = new FactorySagaStore(db);
  assert.equal(restarted.getSaga("ticket-restart")?.daoName, "test_dao");
  assert.equal(
    restarted.getStep("ticket-restart", 2)?.contractId,
    "reservation_1",
  );
  assert.equal(restarted.getStep("ticket-restart", 2)?.status, "completed");
});

test("re-running a step with the same idempotency key reuses the stored result", () => {
  const store = new FactorySagaStore(db);
  store.createSaga({
    ticketId: "ticket-idempotent",
    creator: "GTEST",
    daoName: "test_dao",
    params: params(),
  });
  const input = {
    ticketId: "ticket-idempotent",
    step: 3,
    name: "create_registry",
  };
  const key = createStepIdempotencyKey(
    input.ticketId,
    input.step,
    input.name,
  );
  const first = store.claimStep(input);
  assert.equal(first.action, "run");
  assert.equal(first.idempotencyKey, key);
  store.completeStep({
    ticketId: input.ticketId,
    step: input.step,
    contractId: "registry_1",
  });

  const replay = store.claimStep(input);
  assert.equal(replay.action, "reuse");
  assert.deepEqual(replay.result, { contractId: "registry_1" });
  assert.equal(
    store.getStep(input.ticketId, input.step)?.idempotencyKey,
    key,
  );
});

test("two workers cannot both claim the same pending step", () => {
  const storeA = new FactorySagaStore(db);
  const storeB = new FactorySagaStore(db);
  const input = {
    ticketId: "ticket-concurrency",
    step: 4,
    name: "deploy_membership_sbt",
  };
  storeA.createSaga({
    ticketId: input.ticketId,
    creator: "GTEST",
    daoName: "test_dao",
    params: params(),
  });
  const a = storeA.claimStep(input);
  const b = storeB.claimStep(input);
  assert.equal([a.action, b.action].filter((x) => x === "run").length, 1);
  assert.equal(
    [a.action, b.action].filter((x) => x === "reuse").length,
    1,
  );
});

test("a failed saga produces a compensating plan and an audit event", async () => {
  const store = new FactorySagaStore(db);
  let deployments = 0;
  const failingAdapter = {
    ...deterministicFactoryAdapter,
    deploy: async (input: {
      stepName: string;
      idempotencyKey: string;
      params: ReturnType<typeof params>;
    }) => {
      deployments++;
      if (input.stepName === "create_registry") {
        throw new Error("simulated RPC failure");
      }
      return deterministicFactoryAdapter.deploy(input);
    },
  };
  const orchestrator = new FactoryOrchestrator(store, failingAdapter);
  const ticketId = await orchestrator.createDAO(params(), "failed-saga-key");
  await waitForStatus(orchestrator, ticketId, "failed");

  const plan = orchestrator.getCompensationPlan(ticketId);
  assert.ok(plan.length >= 2, "expected compensable steps in the plan");
  assert.ok(plan.some((p) => p.action === "release_name_reservation"));
  const events = store.listEvents(ticketId).map((e) => e.event);
  assert.ok(events.includes("saga_failed"));
  assert.ok(events.includes("compensation_plan_created"));
  assert.ok(deployments >= 1);
});

test("cancel executes compensation and transitions to compensated", async () => {
  const store = new FactorySagaStore(db);
  const orchestrator = new FactoryOrchestrator(
    store,
    deterministicFactoryAdapter,
  );
  const ticketId = await orchestrator.createDAO(params(), "cancel-saga-key");
  await waitForStatus(orchestrator, ticketId, "completed");
  // Completed sagas are terminal; create a fresh failed one to cancel.
  const failedStore = new FactorySagaStore(db);
  const failing = new FactoryOrchestrator(failedStore, {
    ...deterministicFactoryAdapter,
    deploy: async () => {
      throw new Error("failure before cancel");
    },
  });
  const failedTicket = await failing.createDAO(params(), "cancel-me-key");
  await waitForStatus(failing, failedTicket, "failed");
  const plan = await orchestrator.cancel(failedTicket);
  assert.ok(Array.isArray(plan));
  assert.equal((await orchestrator.getStatus(failedTicket))?.status, "compensated");
  assert.ok(
    store
      .listEvents(failedTicket)
      .some((e) => e.event === "compensation_executed"),
  );
});
