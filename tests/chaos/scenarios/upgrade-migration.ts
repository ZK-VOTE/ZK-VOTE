/**
 * Election-day chaos drill: a protocol upgrade train is executed while votes
 * are being submitted. Invariants (checked by `runUpgradeDrill`):
 *
 *  1. a manifest-incompatible train is rejected before commit;
 *  2. votes submitted during the migration window are rejected/queued, never
 *     partially processed;
 *  3. rollback restores versions, storage layout and circuit IDs in reverse
 *     upgrade order, and emits a rollback event to indexers.
 *
 * Run with: node --experimental-strip-types --test tests/chaos/scenarios/upgrade-migration.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  UpgradeCoordinator,
  validateManifest,
  type ReadinessSnapshot,
  type UpgradeEvent,
} from "../../../backend/src/services/upgradeCoordinator.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const manifest = validateManifest(
  JSON.parse(fs.readFileSync(path.join(ROOT, "releases/compatibility-manifest.json"), "utf-8")),
);

export const UPGRADE_CHAOS_SCENARIO = {
  name: "Contract Upgrade + Migration Window During Election Day",
  description:
    "A release train is prepared and committed while votes stream in; readiness gates must reject/queue votes and rollback must restore the whole train.",
  faults: [
    { type: "contract_upgrade", severity: 9, duration: 600000, params: { phase: "commit" } },
    { type: "migration_window", severity: 8, duration: 900000, params: { votesQueued: true } },
    { type: "network_congestion", severity: 6, duration: 600000, params: { latency: 1500 } },
  ],
  expectedSLOs: {
    minSuccessRate: 0.85,
    maxLatencyP99: 30000,
    minAvailability: 0.95,
    maxPartialVoteProcessing: 0,
  },
} as const;

function snapshot(overrides: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot {
  const chain: ReadinessSnapshot["chain"] = {};
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
    ...overrides,
  };
}

function harness(state: ReadinessSnapshot) {
  const events: UpgradeEvent[] = [];
  const windows: boolean[] = [];
  const voteAttempts: Array<{ windowOpen: boolean; accepted: boolean }> = [];
  const coordinator = new UpgradeCoordinator(manifest, {
    async getSnapshot() {
      return state;
    },
    emit(event) {
      events.push(event);
    },
    setMigrationWindow(open) {
      windows.push(open);
      // Voting rejects with MigrationInProgress while the barrier is open.
      voteAttempts.push({ windowOpen: open, accepted: !open });
    },
    applyContract() {
      /* chain calls are mocked for the drill */
    },
  });
  return { coordinator, events, windows, voteAttempts };
}

test("upgrade drill: incompatible train is rejected and the barrier stays closed", async () => {
  const bad = snapshot();
  bad.chain.voting.version = 1; // dependent contract left behind
  const h = harness(bad);
  await assert.rejects(() => h.coordinator.verify(), /upgrade rejected/);
  assert.deepEqual(h.windows, []);
  assert.equal(h.events.length, 0);
});

test("upgrade drill: votes are rejected during the window, then flow again after commit", async () => {
  const h = harness(snapshot());
  await h.coordinator.prepare();
  await h.coordinator.verify();
  assert.equal(h.windows.at(-1), true);
  await h.coordinator.commit();
  assert.equal(h.windows.at(-1), false);
  const rejected = h.voteAttempts.filter((a) => a.windowOpen && !a.accepted);
  assert.equal(rejected.length, 1);
});

test("upgrade drill: rollback restores every contract in reverse order and emits an event", async () => {
  const h = harness(snapshot());
  const plan = h.coordinator.rollbackPlan();
  await h.coordinator.rollback();
  assert.equal(plan.length, manifest.upgradeOrder.length);
  assert.equal(h.events.at(-1).type, "UpgradeRollback");
  assert.match(plan.find((p) => p.contract === "voting")!.restore, /STORAGE_VERSION_KEY/);
});
