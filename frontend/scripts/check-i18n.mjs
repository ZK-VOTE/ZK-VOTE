#!/usr/bin/env node
/**
 * CI check: all locale files must have every key present in en.json.
 * Missing keys cause a non-zero exit so CI fails early.
 *
 * Usage:
 *   node frontend/scripts/check-i18n.mjs
 */

import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, "../src/i18n/locales");

function flattenKeys(obj, prefix = "") {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...flattenKeys(v, full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

const en = JSON.parse(readFileSync(join(LOCALES_DIR, "en.json"), "utf8"));
const referenceKeys = new Set(flattenKeys(en));

const localeFiles = readdirSync(LOCALES_DIR).filter(
  (f) => f.endsWith(".json") && f !== "en.json"
);

let failed = false;

for (const file of localeFiles) {
  const locale = file.replace(".json", "");
  const data = JSON.parse(readFileSync(join(LOCALES_DIR, file), "utf8"));
  const localeKeys = new Set(flattenKeys(data));

  const missing = [...referenceKeys].filter((k) => !localeKeys.has(k));
  const extra = [...localeKeys].filter((k) => !referenceKeys.has(k));

  if (missing.length > 0) {
    console.error(`\n[${locale}] Missing ${missing.length} key(s):`);
    missing.forEach((k) => console.error(`  - ${k}`));
    failed = true;
  }

  if (extra.length > 0) {
    // Extra keys are warnings, not failures — they may be locale-specific plural forms.
    console.warn(`\n[${locale}] Extra ${extra.length} key(s) not in en.json (may be locale-specific plurals):`);
    extra.forEach((k) => console.warn(`  + ${k}`));
  }

  if (missing.length === 0) {
    console.log(`[${locale}] OK — all ${referenceKeys.size} keys present`);
  }
}

if (failed) {
  console.error("\ncheck-i18n: FAILED — fix missing keys before merging.");
  process.exit(1);
} else {
  console.log("\ncheck-i18n: all locales complete.");
}
