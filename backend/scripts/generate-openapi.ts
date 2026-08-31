/**
 * Generates backend/openapi.json from src/openapi.ts, and checks that
 * API.md documents exactly the same set of endpoints (no stale/missing
 * docs). Run with `npm run docs:generate`; add `--check` to fail instead of
 * write (used by CI to catch an openapi.json that's out of sync with the
 * code — commit the regenerated file when this fails locally).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildOpenApiDocument, ENDPOINTS } from "../src/openapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = path.join(__dirname, "..", "openapi.json");
const API_MD_PATH = path.join(__dirname, "..", "API.md");

function normalizePath(p: string): string {
  // API.md headers use Express-style :param, matching ENDPOINTS' `path` field.
  return p.replace(/\/+$/, "");
}

function checkApiMdCoverage(): string[] {
  const apiMd = fs.readFileSync(API_MD_PATH, "utf-8");
  const documented = new Set<string>();
  const headerRegex = /^### (GET|POST) (\S+)/gm;
  let match: RegExpExecArray | null;
  while ((match = headerRegex.exec(apiMd))) {
    documented.add(`${match[1]} ${normalizePath(match[2])}`);
  }

  const problems: string[] = [];
  for (const ep of ENDPOINTS) {
    const key = `${ep.method.toUpperCase()} ${normalizePath(ep.path)}`;
    if (!documented.has(key)) {
      problems.push(`API.md is missing a "### ${key}" section`);
    }
  }
  return problems;
}

function main(): void {
  const checkOnly = process.argv.includes("--check");
  const document = buildOpenApiDocument();
  const json = JSON.stringify(document, null, 2) + "\n";

  const existing = fs.existsSync(OPENAPI_PATH)
    ? fs.readFileSync(OPENAPI_PATH, "utf-8")
    : null;
  const upToDate = existing === json;

  const mdProblems = checkApiMdCoverage();

  if (checkOnly) {
    let failed = false;
    if (!upToDate) {
      console.error(
        "openapi.json is out of date — run `npm run docs:generate` and commit the result.",
      );
      failed = true;
    }
    if (mdProblems.length > 0) {
      console.error("API.md is out of sync with the implemented routes:");
      for (const p of mdProblems) console.error(`  - ${p}`);
      failed = true;
    }
    if (failed) process.exit(1);
    console.log(
      `openapi.json is up to date (${ENDPOINTS.length} endpoints) and API.md covers all of them.`,
    );
    process.exit(0);
  }

  fs.writeFileSync(OPENAPI_PATH, json);
  console.log(`Wrote ${OPENAPI_PATH} (${ENDPOINTS.length} endpoints).`);
  if (mdProblems.length > 0) {
    console.warn("API.md is missing documentation for:");
    for (const p of mdProblems) console.warn(`  - ${p}`);
  }
  process.exit(0);
}

main();
