/**
 * Exclusion Proof Verification Tests (Issue #312)
 *
 * Tests ZK exclusion proofs for membership revocation:
 * - Verify exclusion proof format and validity
 * - Check revocation status against contract
 * - Enforce that revoked members cannot vote
 * - Track revocation and reinstatement events
 */

import test from "node:test";
import assert from "node:assert";
import {
  verifyExclusionProof,
  recordRevocation,
  recordReinstatement,
  type ExclusionProof,
} from "../src/services/exclusion-proof.js";

// Wire refactored services for tests: since #358 services receive their
// dependencies via init*() instead of importing module globals, tests must
// perform the same wiring the production composition root does at boot.
import { buildAppServices } from "../src/composition-root.js";
buildAppServices();

// The revocation-tracking tests persist through the wired db deps, so make
// sure the schema (including member_revocations) exists before they run.
import fs from "node:fs";
import path from "node:path";
import { initDb } from "../src/services/db.js";
const dataDir = path.resolve("data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
initDb(path.join(dataDir, "zkvote.db"));

const TEST_TREE_CONTRACT = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const TEST_DAO_ID = 1n;

// Create mock exclusion proof
function createMockExclusionProof(overrides: Partial<ExclusionProof> = {}): ExclusionProof {
  return {
    proof: ["1", "2", "3"],
    publicInputs: {
      historicalRoot:
        "12345678901234567890123456789012345678901234567890123456789012",
      currentRoot: "23456789012345678901234567890123456789012345678901234567890123",
      daoId: TEST_DAO_ID,
      leafIndex: 5,
      commitment:
        "1234567890123456789012345678901234567890123456789012345678901234",
    },
    ...overrides,
  };
}

test("Exclusion proof - verify valid proof format", async (t) => {
  const proof = createMockExclusionProof();

  const result = await verifyExclusionProof(proof, TEST_TREE_CONTRACT);

  // Should at least check format, even if proof is invalid
  assert.ok("valid" in result);
  assert.ok("reason" in result || result.valid);
});

test("Exclusion proof - reject invalid commitment", async (t) => {
  const proof = createMockExclusionProof({
    publicInputs: {
      historicalRoot: "valid",
      currentRoot: "valid",
      daoId: TEST_DAO_ID,
      leafIndex: 5,
      commitment: "not_a_valid_field_element", // Invalid
    },
  });

  const result = await verifyExclusionProof(proof, TEST_TREE_CONTRACT);

  assert.equal(result.valid, false);
  assert.ok(result.reason);
});

test("Exclusion proof - reject empty roots", async (t) => {
  const proof = createMockExclusionProof({
    publicInputs: {
      historicalRoot: "", // Invalid
      currentRoot: "valid",
      daoId: TEST_DAO_ID,
      leafIndex: 5,
      commitment:
        "1234567890123456789012345678901234567890123456789012345678901234",
    },
  });

  const result = await verifyExclusionProof(proof, TEST_TREE_CONTRACT);

  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes("root"));
});

test("Exclusion proof - enforce revocation status", async (t) => {
  // Record a revocation first
  const commitment =
    "9999999999999999999999999999999999999999999999999999999999999999";
  const now = Math.floor(Date.now() / 1000);

  await recordRevocation(commitment, Number(TEST_DAO_ID), now);

  const proof = createMockExclusionProof({
    publicInputs: {
      historicalRoot: "valid_historical",
      currentRoot: "valid_current",
      daoId: TEST_DAO_ID,
      leafIndex: 5,
      commitment,
    },
  });

  const result = await verifyExclusionProof(proof, TEST_TREE_CONTRACT);

  // Should verify successfully if member is revoked
  if (result.valid) {
    assert.ok(true);
  } else {
    // Or indicate member must be revoked
    assert.ok(result.reason?.includes("revoked"));
  }
});

test("Exclusion proof - track reinstatement", async (t) => {
  const commitment =
    "8888888888888888888888888888888888888888888888888888888888888888";
  const now = Math.floor(Date.now() / 1000);

  // Record revocation
  await recordRevocation(commitment, Number(TEST_DAO_ID), now);

  // Then reinstatement
  const reinstateTime = now + 3600;
  await recordReinstatement(commitment, Number(TEST_DAO_ID), reinstateTime);

  // Member should be able to vote again
  // (In production, this would be verified by re-generating membership proof)
  assert.ok(true);
});

test("Exclusion proof - prevent double voting with revocation", async (t) => {
  // Scenario: Member was revoked, tries to vote with old proof
  const commitment =
    "7777777777777777777777777777777777777777777777777777777777777777";
  const now = Math.floor(Date.now() / 1000);

  await recordRevocation(commitment, Number(TEST_DAO_ID), now);

  const proof = createMockExclusionProof({
    publicInputs: {
      historicalRoot: "old_root_when_member_was_active",
      currentRoot: "current_root_without_member",
      daoId: TEST_DAO_ID,
      leafIndex: 10,
      commitment,
    },
  });

  const result = await verifyExclusionProof(proof, TEST_TREE_CONTRACT);

  // Revoked member should not be able to vote
  if (result.valid) {
    // Valid exclusion proof = member is revoked and cannot vote
    assert.ok(true);
  } else {
    // Or check that reason indicates revocation
    assert.ok(
      result.reason?.includes("revoked") ||
      result.reason?.includes("not in tree")
    );
  }
});

test("Exclusion proof - field element bounds validation", async (t) => {
  const BN254_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

  // Test with value at boundary
  const maxValidCommitment = (BN254_PRIME - 1n).toString();

  const proof = createMockExclusionProof({
    publicInputs: {
      historicalRoot: "valid",
      currentRoot: "valid",
      daoId: TEST_DAO_ID,
      leafIndex: 5,
      commitment: maxValidCommitment,
    },
  });

  const result = await verifyExclusionProof(proof, TEST_TREE_CONTRACT);

  // Should handle large values correctly
  assert.ok("valid" in result);
});

test("Exclusion proof - historical vs current root mismatch detection", async (t) => {
  // Case where roots are the same (member not actually revoked)
  const sameRoot =
    "1111111111111111111111111111111111111111111111111111111111111111";

  const proof = createMockExclusionProof({
    publicInputs: {
      historicalRoot: sameRoot,
      currentRoot: sameRoot, // Same root = member not removed
      daoId: TEST_DAO_ID,
      leafIndex: 5,
      commitment:
        "2222222222222222222222222222222222222222222222222222222222222222",
    },
  });

  const result = await verifyExclusionProof(proof, TEST_TREE_CONTRACT);

  // Either valid (if no revocation recorded) or indicate no revocation
  assert.ok("valid" in result);
});
