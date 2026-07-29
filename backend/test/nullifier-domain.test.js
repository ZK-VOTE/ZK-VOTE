/**
 * Nullifier domain-separation route checks (issue #64).
 *
 * Ensures election IDs (daoId + proposalId) are required on nullifier queries
 * in the voting routes source (avoids booting the full relayer for this check).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("voting.ts registers election-scoped nullifier query route", () => {
  const votingRoutes = fs.readFileSync(
    path.join(__dirname, "../src/routes/voting.ts"),
    "utf8",
  );

  assert.match(
    votingRoutes,
    /\/nullifier\/:daoId\/:proposalId\/:nullifier/,
    "nullifier queries must include daoId and proposalId (election scope)",
  );
  assert.match(
    votingRoutes,
    /is_nullifier_used/,
    "route must call election-scoped is_nullifier_used on the voting contract",
  );
  assert.match(
    votingRoutes,
    /electionId/,
    "response should expose electionId = { daoId, proposalId }",
  );
});

test("index.ts advertises election-scoped nullifier endpoint", () => {
  const indexSrc = fs.readFileSync(
    path.join(__dirname, "../src/index.ts"),
    "utf8",
  );
  assert.match(indexSrc, /\/nullifier\/:daoId\/:proposalId\/:nullifier/);
});
