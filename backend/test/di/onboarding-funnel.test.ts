// Unit tests for the onboarding funnel metrics service (ZV-108).
//
// Exercises the service through its injected dependency surface
// (`initOnboardingFunnel`) with an in-memory SQLite database and a real
// Kysely builder over it. Pins down the privacy property: only a single
// aggregate counter per step is ever persisted (see the table schema
// assertion below), and drop-off is derived purely from counter deltas.

import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import {
  initOnboardingFunnel,
  recordFunnelStep,
  getFunnelSummary,
  isOnboardingFunnelStep,
  ONBOARDING_FUNNEL_STEPS,
} from "../../src/services/onboardingFunnel.js";
import type { DB } from "../../src/generated/db-types.js";

function makeDb() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE onboarding_funnel_counts (
      step TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
  const kysely = new Kysely<DB>({
    dialect: new SqliteDialect({ database }),
  });
  return { database, kysely };
}

test("isOnboardingFunnelStep rejects unknown values", () => {
  assert.equal(isOnboardingFunnelStep("secret_created"), true);
  assert.equal(isOnboardingFunnelStep("not_a_step"), false);
  assert.equal(isOnboardingFunnelStep(123), false);
});

test("recordFunnelStep only ever persists one row per step (aggregate, not per-event)", async () => {
  const { database, kysely } = makeDb();
  initOnboardingFunnel({ kysely });

  await recordFunnelStep("registration_started");
  await recordFunnelStep("registration_started");
  await recordFunnelStep("registration_started");

  const rows = database
    .prepare("SELECT step, count FROM onboarding_funnel_counts")
    .all();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { step: "registration_started", count: 3 });
});

test("getFunnelSummary reports every step, defaulting unseen steps to zero", async () => {
  const { kysely } = makeDb();
  initOnboardingFunnel({ kysely });

  const summary = await getFunnelSummary();
  assert.equal(summary.length, ONBOARDING_FUNNEL_STEPS.length);
  assert.ok(summary.every((s) => s.count === 0));
});

test("getFunnelSummary computes drop-off along the main chain", async () => {
  const { kysely } = makeDb();
  initOnboardingFunnel({ kysely });

  for (let i = 0; i < 10; i++) await recordFunnelStep("registration_started");
  for (let i = 0; i < 7; i++) await recordFunnelStep("secret_created");
  for (let i = 0; i < 7; i++) await recordFunnelStep("backup_viewed");
  for (let i = 0; i < 4; i++)
    await recordFunnelStep("backup_verification_started");
  for (let i = 0; i < 4; i++)
    await recordFunnelStep("backup_verification_passed");
  for (let i = 0; i < 3; i++) await recordFunnelStep("registration_completed");

  const summary = await getFunnelSummary();
  const byStep = Object.fromEntries(summary.map((s) => [s.step, s]));

  assert.equal(byStep.registration_started.count, 10);
  assert.equal(byStep.registration_started.droppedFromPrevious, null);

  assert.equal(byStep.secret_created.count, 7);
  assert.equal(byStep.secret_created.droppedFromPrevious, 3);

  assert.equal(byStep.backup_viewed.droppedFromPrevious, 0);
  assert.equal(byStep.backup_verification_started.droppedFromPrevious, 3);
  assert.equal(byStep.registration_completed.droppedFromPrevious, 1);
});

test("the parallel explore branch never reports drop-off and doesn't affect the main chain", async () => {
  const { kysely } = makeDb();
  initOnboardingFunnel({ kysely });

  for (let i = 0; i < 10; i++) await recordFunnelStep("registration_started");
  for (let i = 0; i < 5; i++)
    await recordFunnelStep("explore_readonly_selected");
  for (let i = 0; i < 4; i++) await recordFunnelStep("secret_created");

  const summary = await getFunnelSummary();
  const byStep = Object.fromEntries(summary.map((s) => [s.step, s]));

  assert.equal(byStep.explore_readonly_selected.count, 5);
  assert.equal(byStep.explore_readonly_selected.droppedFromPrevious, null);
  // secret_created drop-off is measured against registration_started (10),
  // not against the explore branch.
  assert.equal(byStep.secret_created.droppedFromPrevious, 6);
});
