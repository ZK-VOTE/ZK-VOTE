#!/usr/bin/env node
// Convert Soroban VK JSON to Stellar CLI JSON format
const fs = require("fs");

if (process.argv.length < 3) {
  console.error("Usage: node vkey_to_cli_json.js <vkey_soroban.json>");
  process.exit(1);
}

const vkeyPath = process.argv[2];

if (!fs.existsSync(vkeyPath)) {
  console.error(`Error: ${vkeyPath} not found`);
  console.error("Run: node utils/vkey_to_soroban.js first");
  process.exit(1);
}

const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));

// Convert to CLI JSON format
// BytesN are passed as hex strings, Vec as arrays
const cliFormat = {
  alpha: vkey.alpha,
  beta: vkey.beta,
  gamma: vkey.gamma,
  delta: vkey.delta,
  ic: vkey.ic
};

// Output as compact JSON (no newlines for CLI)
console.log(JSON.stringify(cliFormat));
