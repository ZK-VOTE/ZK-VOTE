#!/usr/bin/env tsx
/**
 * Generate .env.example from configuration schema.
 *
 * Usage:
 *   npx tsx scripts/generate-env-example.ts
 *   npm run config:generate
 */

import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateEnvExample, configSchema } from "../src/config-schema.js";

const EXAMPLE_PATH = resolve(import.meta.dirname ?? ".", "..", ".env.example");

function main() {
  console.log("🔧 Generating .env.example from config schema...\n");

  // Generate example content
  const content = generateEnvExample();

  // Read existing file for diff
  let existing = "";
  try {
    existing = readFileSync(EXAMPLE_PATH, "utf-8");
  } catch {
    // File doesn't exist yet
  }

  if (existing === content) {
    console.log("✅ .env.example is already up to date.\n");
    return;
  }

  writeFileSync(EXAMPLE_PATH, content, "utf-8");
  console.log(`✅ Written to ${EXAMPLE_PATH}`);
  console.log(`   (${content.split("\n").length} lines)\n`);

  // Also log schema summary
  const shape = configSchema.shape;
  const keys = Object.keys(shape);
  console.log(`📋 Schema defines ${keys.length} configuration variables:`);
  console.log(`   Required: ${keys.filter((k) => {
    const field = shape[k];
    return !field.isOptional();
  }).length}`);
  console.log(`   Optional: ${keys.filter((k) => {
    const field = shape[k];
    return field.isOptional();
  }).length}`);
}

main();
