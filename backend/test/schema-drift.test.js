import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// #920 — drift guard. Reads source text rather than importing db.ts so the
// check has no database side effects.
const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, "..");
const repoRoot = path.resolve(backendRoot, "..");

const dbSource = fs.readFileSync(path.join(backendRoot, "src/services/db.ts"), "utf8");
const doc = fs.readFileSync(path.join(repoRoot, "docs/schema-versioning.md"), "utf8");
const migrationsDir = path.join(backendRoot, "src/migrations");

function codeSchemaVersion() {
  const match = dbSource.match(/const CURRENT_SCHEMA_VERSION = (\d+);/);
  assert.ok(match, "CURRENT_SCHEMA_VERSION not found in db.ts");
  return Number(match[1]);
}

function codeTableNames() {
  const start = dbSource.indexOf("const EXPECTED_SCHEMA");
  assert.ok(start >= 0, "EXPECTED_SCHEMA not found in db.ts");
  const end = dbSource.indexOf("\n};", start);
  const body = dbSource.slice(start, end);
  // Top-level keys are two-space indented: `  name: {`
  return [...body.matchAll(/^ {2}([a-z_]+): \{/gm)].map((m) => m[1]);
}

function docVersion() {
  const match = doc.match(/^## Current Version: (\d+)$/m);
  assert.ok(match, "'## Current Version: N' heading missing from schema doc");
  return Number(match[1]);
}

function docTableNames() {
  const block = doc.match(/<!-- schema-tables:start -->([\s\S]*?)<!-- schema-tables:end -->/);
  assert.ok(block, "schema-tables marker block missing from schema doc");
  return [...block[1].matchAll(/^- `([a-z_]+)`$/gm)].map((m) => m[1]);
}

test("schema doc version matches CURRENT_SCHEMA_VERSION", () => {
  assert.equal(
    docVersion(),
    codeSchemaVersion(),
    "docs/schema-versioning.md is stale: update 'Current Version' and the version history",
  );
});

test("schema doc table index matches EXPECTED_SCHEMA exactly", () => {
  assert.deepEqual(
    docTableNames(),
    codeTableNames(),
    "docs/schema-versioning.md table index is out of sync with EXPECTED_SCHEMA in db.ts",
  );
});

test("every sqlite migration has a matching down migration", () => {
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  const ups = files.filter((f) => f.endsWith(".up.sql")).map((f) => f.replace(/\.up\.sql$/, ""));
  const downs = new Set(
    files.filter((f) => f.endsWith(".down.sql")).map((f) => f.replace(/\.down\.sql$/, "")),
  );
  const missing = ups.filter((name) => !downs.has(name));
  assert.deepEqual(missing, [], `migrations missing a .down.sql pair: ${missing.join(", ")}`);
});
