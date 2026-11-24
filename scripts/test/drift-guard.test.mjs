/**
 * Tests for scripts/drift-guard.mjs.
 *
 * Each test runs the guard against an isolated fixture tree copied from the
 * real repo, so injecting drift never touches the working tree.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDriftGuard } from "../drift-guard.mjs";
import { renderTs } from "../generate-bindings.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function makeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zkvote-drift-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const copy = (rel) => {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(path.join(ROOT, rel), dest, { recursive: true });
  };
  copy("shared/protocol-manifest.json");
  copy("frontend/src");
  copy("backend/src/generated/zkv1.ts");
  copy("backend/src/services/proofSerialization.ts");
  copy("packages/sdk/src/generated/zkv1.ts");
  copy("contracts/zkvote-groth16/src/generated.rs");
  copy("contracts/zkvote-groth16/src/serialization.rs");
  copy("contracts/zkvote-groth16/src/lib.rs");
  copy("contracts/voting/src/lib.rs");
  copy("circuits/vote.circom");
  copy("docs/SIGNAL_REGISTRY.md");
  copy("docs/zk-voting-protocol.md");
  return dir;
}

function overwrite(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
}

test("drift guard passes on a clean tree with no uncaught errors", (t) => {
  const dir = makeFixture(t);
  const result = runDriftGuard({ root: dir });
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.equal(result.findings.length, 0);
});

test("an injected public-signal mismatch is reported precisely", (t) => {
  const dir = makeFixture(t);
  const circomRel = "circuits/vote.circom";
  const source = fs.readFileSync(path.join(dir, circomRel), "utf-8");
  overwrite(
    dir,
    circomRel,
    source.replace(
      /component\s+main\s*\{public\s*\[([^\]]*)\]/,
      "component main {public [" + "$1, extraSignal]",
    ),
  );

  const result = runDriftGuard({ root: dir });
  assert.equal(result.ok, false);
  const drift = result.findings.filter((f) => f.code === "public_signal_drift");
  assert.ok(drift.length >= 1, "expected a public_signal_drift finding");
  const message = drift.map((f) => f.message).join(" ");
  assert.match(message, /extraSignal/);
  assert.match(message, /declares \[root, nullifier, daoId, proposalId, voteChoice, numCandidates, extraSignal\]/);
  assert.match(message, /IC length must be 7/);
});

test("a stale generated binding is detected and --fix repairs it", (t) => {
  const dir = makeFixture(t);
  overwrite(dir, "backend/src/generated/zkv1.ts", "// deliberately stale\n");

  const before = runDriftGuard({ root: dir });
  assert.equal(before.ok, false);
  assert.ok(before.findings.some((f) => f.code === "generated_drift"));

  const after = runDriftGuard({ root: dir, fix: true });
  assert.equal(after.ok, true, JSON.stringify(after.findings, null, 2));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, "shared/protocol-manifest.json"), "utf-8"),
  );
  assert.equal(
    fs.readFileSync(path.join(dir, "backend/src/generated/zkv1.ts"), "utf-8"),
    renderTs(manifest),
  );
});

test("proof-format drift (hand-copied constants) is detected", (t) => {
  const dir = makeFixture(t);
  const rel = "backend/src/services/proofSerialization.ts";
  const source = fs.readFileSync(path.join(dir, rel), "utf-8");
  overwrite(dir, rel, source.replaceAll('from "../generated/zkv1.js"', 'from "../generated/legacy.js"'));

  const result = runDriftGuard({ root: dir });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.code === "proof_format_drift"));
});

test("contract ID drift is detected", (t) => {
  const dir = makeFixture(t);
  const rel = "frontend/src/config/contracts.ts";
  const source = fs.readFileSync(path.join(dir, rel), "utf-8");
  overwrite(
    dir,
    rel,
    source.replace(
      "CBGK5YFR5544QNHUNR4WKB5ECL75DAY3R4M5UNALA42ZBPKOFNL5RM43",
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ),
  );

  const result = runDriftGuard({ root: dir });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.code === "contract_id_drift"));
});
