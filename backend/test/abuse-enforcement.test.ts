// Abuse-detection enforcement & dispute-case linkage tests (ZV-111).
//
// Exercises the enforcement hook end to end against a real (temp-file)
// SQLite database with migrations applied, which is what the "advisory
// only, no enforcement hook" gap in docs/abuse-detection-policy.md was
// about. Also carries the policy doc's labelled red-team drills as
// regression fixtures, and a privacy-boundary check that evidence bundles
// can never carry vote/membership linkage.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(tmpdir(), "zkvote-abuse-enforcement-"));

test.after(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

test("determineAction maps confidence to graduated flag/hold/block tiers", async () => {
  const { determineAction, AbuseAction, ABUSE_THRESHOLDS } = await import(
    "../src/services/abuseDetection.ts"
  );

  assert.equal(determineAction(false, 0), AbuseAction.NONE);
  assert.equal(determineAction(true, 0.2), AbuseAction.FLAG);
  assert.equal(determineAction(true, ABUSE_THRESHOLDS.HOLD_CONFIDENCE), AbuseAction.HOLD);
  assert.equal(determineAction(true, 0.75), AbuseAction.HOLD);
  assert.equal(determineAction(true, ABUSE_THRESHOLDS.BLOCK_CONFIDENCE), AbuseAction.BLOCK);
  assert.equal(determineAction(true, 0.99), AbuseAction.BLOCK);
});

test("assertNoVoteLinkage rejects nullifier/membership/dao/proposal fields at any depth", async () => {
  const { assertNoVoteLinkage } = await import("../src/services/abuseDetection.ts");

  assert.doesNotThrow(() =>
    assertNoVoteLinkage({ opsCount: 3, uniqueDestinations: 2, structuring: { nearThresholdCount: 5 } })
  );

  for (const bad of [
    { voteNullifier: "abc" },
    { nested: { membershipProof: "xyz" } },
    { list: [{ daoId: 1 }] },
    { proposal_id: 42 },
  ]) {
    assert.throws(() => assertNoVoteLinkage(bad), /Privacy violation/);
  }
});

test("placeOnHold opens a linked dispute case with a privacy-clean evidence bundle, and rejects tainted evidence", async () => {
  const { initDb } = await import("../src/services/db.ts");
  const { placeOnHold, getHold, AbuseAction, AbusePattern, ABUSE_THRESHOLDS_VERSION } =
    await import("../src/services/abuseDetection.ts");

  const dbPath = path.join(TEST_DIR, "holds.db");
  const db = initDb(dbPath);

  const result = placeOnHold({
    tenantId: "tenant-1",
    paymentRef: "batch:1",
    action: AbuseAction.HOLD,
    patterns: [AbusePattern.STRUCTURING],
    confidence: 0.75,
    evidence: { opsCount: 6, uniqueDestinations: 1 },
  });

  assert.ok(result?.holdId);
  assert.ok(result?.disputeCaseId);

  const hold = getHold(result!.holdId);
  assert.equal(hold?.status, "held");
  assert.equal(hold?.action, AbuseAction.HOLD);
  assert.equal(hold?.reasonCode, "STRUCTURING_THRESHOLD_EVASION");
  assert.equal(hold?.thresholdsVersion, ABUSE_THRESHOLDS_VERSION);
  assert.equal(hold?.disputeCaseId, result!.disputeCaseId);

  const caseRow = db
    .prepare("SELECT * FROM dispute_cases WHERE id = ?")
    .get(result!.disputeCaseId) as any;
  assert.equal(caseRow.class, "payment");
  assert.equal(caseRow.status, "open");
  assert.equal(caseRow.hold_id, result!.holdId);
  // Metadata-only: parsing the stored bundle must never reveal nullifier/membership keys.
  const bundle = JSON.parse(caseRow.evidence_bundle);
  assert.equal(bundle.voteNullifier, undefined);
  assert.equal(bundle.membershipProof, undefined);

  assert.throws(
    () =>
      placeOnHold({
        tenantId: "tenant-1",
        paymentRef: "batch:2",
        action: AbuseAction.BLOCK,
        patterns: [AbusePattern.WASH_PAYMENT],
        confidence: 0.95,
        evidence: { voteNullifier: "should-never-be-here" },
      }),
    /Privacy violation/
  );

  // FLAG/NONE never create a hold or case (log-only tiers).
  assert.equal(
    placeOnHold({
      tenantId: "tenant-1",
      paymentRef: "batch:3",
      action: AbuseAction.FLAG,
      patterns: [],
      confidence: 0.2,
      evidence: {},
    }),
    null
  );
});

test("reviewHold enforces dual control: a reviewer cannot release their own hold", async () => {
  const { initDb } = await import("../src/services/db.ts");
  const { placeOnHold, reviewHold, getHold, AbuseAction, AbusePattern } = await import(
    "../src/services/abuseDetection.ts"
  );

  const dbPath = path.join(TEST_DIR, "dual-control.db");
  initDb(dbPath);

  const { holdId, disputeCaseId } = placeOnHold({
    tenantId: "tenant-2",
    paymentRef: "batch:dual",
    action: AbuseAction.BLOCK,
    patterns: [AbusePattern.MULE_CONVERGENCE],
    confidence: 0.95,
    evidence: { opsCount: 1 },
  })!;

  // Same reviewer twice: rejected.
  reviewHold(holdId, "analyst-a", "looks like a known payroll hub");
  assert.throws(
    () => reviewHold(holdId, "analyst-a", "trying to confirm myself"),
    /Dual control violation/
  );

  // A second, distinct reviewer completes the release.
  const released = reviewHold(holdId, "analyst-b", "confirmed allowlisted hub");
  assert.equal(released.status, "released");
  assert.equal(released.releasedBy, "analyst-b");

  const hold = getHold(holdId);
  assert.equal(hold?.status, "released");

  const { getDb } = await import("../src/services/db.ts");
  const caseRow = getDb()
    .prepare("SELECT status, resolution FROM dispute_cases WHERE id = ?")
    .get(disputeCaseId) as any;
  assert.equal(caseRow.status, "resolved");
  assert.equal(caseRow.resolution, "confirmed allowlisted hub");

  // Already-released holds cannot be re-reviewed.
  assert.throws(() => reviewHold(holdId, "analyst-c", "noop"), /already released/);
});

// --- Labelled red-team drills from docs/abuse-detection-policy.md -----

test("red-team drill: structuring campaign is held/blocked, not just logged", async () => {
  const { detectStructuring, determineAction, AbuseAction, ABUSE_THRESHOLDS } = await import(
    "../src/services/abuseDetection.ts"
  );

  const justBelow = (ABUSE_THRESHOLDS.STRUCTURING_AMOUNT * BigInt(99)) / BigInt(100);
  const payments = Array.from({ length: 10 }, (_, i) => ({
    hash: `drill-${i}`,
    tenantId: "drill-tenant",
    amount: justBelow,
    destinations: ["GDEST..."],
    timestamp: Date.now() - i * 60 * 1000,
  }));

  const result = detectStructuring(payments);
  assert.ok(result.confidence >= 0.8, "structuring drill must reach >=0.8 confidence");
  const action = determineAction(result.suspicious, result.confidence);
  assert.notEqual(action, AbuseAction.NONE);
  assert.notEqual(action, AbuseAction.FLAG, "a drill-strength campaign must not stay at flag-only");
});

test("red-team drill: legitimate payroll batch is never held or blocked (false-positive check)", async () => {
  const { detectStructuring, detectWashPayments, determineAction, AbuseAction } = await import(
    "../src/services/abuseDetection.ts"
  );

  const now = Date.now();
  const payroll = Array.from({ length: 50 }, (_, i) => ({
    hash: `payroll-${i}`,
    tenantId: "company",
    amount: BigInt(5000 * 1e7),
    destinations: [`GEMP${i}...`],
    timestamp: now,
  }));

  const structuring = detectStructuring(payroll);
  const wash = detectWashPayments(payroll);
  const confidence = Math.max(structuring.confidence, wash.confidence);
  const suspicious = structuring.suspicious || wash.suspicious;

  const action = determineAction(suspicious, confidence);
  assert.notEqual(action, AbuseAction.HOLD);
  assert.notEqual(action, AbuseAction.BLOCK);
});
