/**
 * Tests for the protocol upgrade coordinator.
 * Run with: node --experimental-strip-types --test backend/test/upgrade-coordinator.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  UpgradeCoordinator,
  checkCompatibility,
  manifestHash,
  validateManifest,
} from "../src/services/upgradeCoordinator.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = validateManifest(
  JSON.parse(fs.readFileSync(path.join(ROOT, "releases/compatibility-manifest.json"), "utf-8")),
);

function healthySnapshot() {
  const chain = {};
  for (const [name, req] of Object.entries(manifest.contracts)) {
    chain[name] = {
      version: req.version,
      storageVersion: req.storageVersion,
      ...(req.circuitId ? { circuitId: req.circuitId } : {}),
    };
  }
  return {
    chain,
    backend: { schemaVersion: manifest.backendSchemaVersion, migrationChecksumsMatch: true },
    haltedTiers: [],
    circuitMigrationOverlap: false,
    blackoutActive: false,
  };
}

function harness(snapshot = healthySnapshot()) {
  const calls = [];
  const events = [];
  const windows = [];
  const coordinator = new UpgradeCoordinator(manifest, {
    async getSnapshot() {
      return snapshot;
    },
    emit(event) {
      events.push(event);
    },
    setMigrationWindow(open) {
      windows.push(open);
    },
    applyContract(contract, phase, hash) {
      calls.push({ contract, phase, hash });
    },
  });
  return { coordinator, calls, events, windows };
}

test("manifest hash is deterministic and order-independent", () => {
  assert.match(manifestHash(manifest), /^[0-9a-f]{64}$/);
  assert.equal(manifestHash(manifest), manifestHash(structuredClone(manifest)));
});

test("an incompatible dependent contract is rejected before commit", async () => {
  const snapshot = healthySnapshot();
  snapshot.chain.voting.version = 1;
  const findings = checkCompatibility(manifest, snapshot);
  assert.ok(findings.some((f) => f.code === "below_min_version" && f.contract === "voting"));
  const h = harness(snapshot);
  await assert.rejects(() => h.coordinator.verify(), /upgrade rejected/);
});

test("verify opens the migration barrier and emits an UpgradeVerified event", async () => {
  const h = harness();
  await h.coordinator.verify();
  assert.deepEqual(h.windows, [true]);
  assert.equal(h.events.at(-1).type, "UpgradeVerified");
  assert.equal(h.calls.length, manifest.upgradeOrder.length);
});

test("commit refuses to proceed if a dependency drifted and leaves the barrier closed", async () => {
  const snap = healthySnapshot();
  snap.backend.schemaVersion = 1;
  const drifted = harness(snap);
  await assert.rejects(() => drifted.coordinator.commit(), /commit rejected/);
  assert.deepEqual(drifted.windows, []);
  assert.equal(drifted.calls.length, 0);
});

test("rollback plan is the exact reverse of the upgrade order", () => {
  const h = harness();
  const plan = h.coordinator.rollbackPlan();
  assert.deepEqual(
    plan.map((s) => s.contract),
    manifest.rollbackOrder,
  );
  const voting = plan.find((s) => s.contract === "voting");
  assert.match(voting.restore, /STORAGE_VERSION_KEY/);
  const registry = plan.find((s) => s.contract === "circuit-registry");
  assert.match(registry.restore, /restore_current_circuit/);
});
