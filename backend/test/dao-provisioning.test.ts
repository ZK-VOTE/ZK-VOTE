import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  DaoProvisioningService,
  ProvisioningError,
  type ExecutorMap,
} from "../src/services/dao-provisioning.js";

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "zkvote-saga-"));
  dirs.push(dir);
  return dir;
}

describe("DAO bootstrap saga", () => {
  it("resumes after a failed step and never re-runs completed steps", async () => {
    const stateDir = await tempDir();
    const calls: string[] = [];
    let failOnce = true;
    const executors: ExecutorMap = {
      registry: {
        async execute() {
          calls.push("registry");
          return { daoId: 9, detail: { created: true } };
        },
      },
      "membership-sbt": {
        async execute({ daoId }) {
          calls.push(`sbt:${daoId}`);
          return { detail: { minted: true } };
        },
      },
      "membership-tree": {
        async execute() {
          calls.push("tree");
          if (failOnce) {
            failOnce = false;
            throw new Error("simulated tree outage");
          }
          return { detail: { initialized: true } };
        },
      },
      commitment: {
        async execute() {
          calls.push("commitment");
          return { detail: { committed: true } };
        },
      },
      "voting-vk": {
        async execute() {
          calls.push("vk");
          return { detail: { registered: true } };
        },
      },
    };

    const service = new DaoProvisioningService(executors, { stateDir });
    const key = "ab".repeat(32);
    const failed = await service.start(key, {
      name: "Test DAO",
      creator: "GAAA",
      membershipOpen: true,
      membersCanPropose: true,
    });

    assert.equal(failed.status, "failed");
    assert.equal(failed.daoId, 9);
    assert.deepEqual(calls, ["registry", "sbt:9", "tree"]);
    assert.equal(
      failed.steps.find((s) => s.id === "registry")?.status,
      "done",
    );
    assert.equal(
      failed.steps.find((s) => s.id === "membership-tree")?.status,
      "failed",
    );

    const resumed = await service.retry(key);
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.daoId, 9);
    assert.deepEqual(calls, [
      "registry",
      "sbt:9",
      "tree",
      "tree",
      "commitment",
      "vk",
    ]);

    const again = await service.retry(key);
    assert.equal(again.status, "completed");
    assert.equal(calls.length, 6, "completed saga must not execute steps again");

    const persisted = await service.get(key);
    assert.equal(persisted?.status, "completed");
    assert.equal(persisted?.steps.every((s) => s.status === "done"), true);
  });

  it("deduplicates concurrent starts for the same idempotency key", async () => {
    const stateDir = await tempDir();
    let registryCalls = 0;
    const executors: ExecutorMap = {
      registry: {
        async execute() {
          registryCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { daoId: 3 };
        },
      },
      "membership-sbt": { async execute() { return {}; } },
      "membership-tree": { async execute() { return {}; } },
      commitment: { async execute() { return {}; } },
      "voting-vk": { async execute() { return {}; } },
    };
    const service = new DaoProvisioningService(executors, { stateDir });
    const key = "cd".repeat(32);
    const params = {
      name: "Concurrent",
      creator: "GAAA",
      membershipOpen: false,
      membersCanPropose: false,
    };
    const [a, b] = await Promise.all([
      service.start(key, params),
      service.start(key, params),
    ]);
    assert.equal(a.status, "completed");
    assert.equal(b.status, "completed");
    assert.equal(registryCalls, 1);
  });

  it("abandons a failed saga and compensates completed steps in reverse", async () => {
    const stateDir = await tempDir();
    const compensated: string[] = [];
    const executors: ExecutorMap = {
      registry: {
        async execute() { return { daoId: 5 }; },
        async compensate() { compensated.push("registry"); },
      },
      "membership-sbt": {
        async execute() { return {}; },
        async compensate() { compensated.push("sbt"); },
      },
      "membership-tree": {
        async execute() { throw new Error("boom"); },
      },
      commitment: { async execute() { return {}; } },
      "voting-vk": { async execute() { return {}; } },
    };
    const service = new DaoProvisioningService(executors, { stateDir });
    const key = "ef".repeat(32);
    await service.start(key, {
      name: "Abandon",
      creator: "GAAA",
      membershipOpen: true,
      membersCanPropose: true,
    });
    const record = await service.abandon(key);
    assert.equal(record.status, "abandoned");
    assert.deepEqual(compensated, ["sbt", "registry"]);
  });

  it("rejects malformed idempotency keys", async () => {
    const service = new DaoProvisioningService({}, { stateDir: await tempDir() });
    await assert.rejects(
      service.start("not-a-key", {
        name: "x",
        creator: "GAAA",
        membershipOpen: true,
        membersCanPropose: true,
      }),
      /32 bytes of hex/,
    );
  });

  it("rejects a DAO name that mixes Latin and confusable Cyrillic letters (ZV-109)", async () => {
    const service = new DaoProvisioningService({}, { stateDir: await tempDir() });
    const key = "cd".repeat(32);
    await assert.rejects(
      service.start(key, {
        name: "Stellаr DAO", // Cyrillic а in place of Latin 'a'
        creator: "GAAA",
        membershipOpen: true,
        membersCanPropose: true,
      }),
      (err: unknown) => {
        assert.ok(err instanceof ProvisioningError);
        assert.equal(err.code, "INVALID_NAME");
        return true;
      },
    );
    // The rejected attempt must not have created a checkpoint.
    assert.equal(await service.get(key), null);
  });

  it("allows a single-script (all-Cyrillic) DAO name", async () => {
    const service = new DaoProvisioningService(
      {
        registry: {
          async execute() {
            return { daoId: 1, detail: {} };
          },
        },
      },
      { stateDir: await tempDir() },
    );
    const key = "11".repeat(32);
    const record = await service.start(key, {
      name: "Привет ДАО",
      creator: "GAAA",
      membershipOpen: true,
      membersCanPropose: true,
    });
    assert.notEqual(record.status, undefined);
  });
});
