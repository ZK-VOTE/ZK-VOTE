#!/usr/bin/env node
/**
 * Drift guard — verifies that every hand-maintained source agrees with the
 * canonical protocol manifest (shared/protocol-manifest.json).
 *
 * Checks: generated bindings, contract IDs, legacy client cleanup, URL config,
 * public-signal order/count (incl. circom + VK), ZKV1 proof format, error
 * codes and circuit IDs. All findings are accumulated and the process exits
 * exactly once, at the end, so a broken check can never make the guard silently
 * pass.
 *
 *   node scripts/drift-guard.mjs            # check (CI)
 *   node scripts/drift-guard.mjs --fix      # regenerate generated files, then check
 *   ZK_VOTE_ROOT=/tmp/fixture node ...      # test against a fixture tree
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateManifest,
  renderTs,
  renderRust,
} from "./generate-bindings.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const MANIFEST_REL = "shared/protocol-manifest.json";
const GENERATED_TS = [
  "frontend/src/generated/zkv1.ts",
  "backend/src/generated/zkv1.ts",
  "packages/sdk/src/generated/zkv1.ts",
];
const GENERATED_RS = "contracts/zkvote-groth16/src/generated.rs";

const FIX_HINT = "Fix: edit shared/protocol-manifest.json, then run `node scripts/generate-bindings.mjs`.";

function walk(dir, exts, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (["node_modules", ".git", "dist", "build", ".cache"].includes(entry.name)) continue;
      walk(path.join(dir, entry.name), exts, out);
    } else if (exts.includes(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function makeCtx(root) {
  const read = (rel) => {
    const abs = path.join(root, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null;
  };
  const rel = (abs) => path.relative(root, abs).split(path.sep).join("/");
  return { root, read, rel };
}

const finding = (code, message, file, fix = FIX_HINT) => ({
  code,
  message,
  file: file ?? null,
  fix,
});

// ── CHECKS ───────────────────────────────────────────────────────────────────

function checkGenerated(ctx, manifest, fix) {
  const findings = [];
  const expectedTs = renderTs(manifest);
  const expectedRs = renderRust(manifest);
  for (const target of GENERATED_TS) {
    const abs = path.join(ctx.root, target);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null;
    if (current !== expectedTs) {
      if (fix) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, expectedTs, "utf-8");
      } else {
        findings.push(
          finding("generated_drift", `${target} is stale or missing; it must be generated from ${MANIFEST_REL}.`, target),
        );
      }
    }
  }
  const rsAbs = path.join(ctx.root, GENERATED_RS);
  const rsCurrent = fs.existsSync(rsAbs) ? fs.readFileSync(rsAbs, "utf-8") : null;
  if (rsCurrent !== expectedRs) {
    if (fix) {
      fs.mkdirSync(path.dirname(rsAbs), { recursive: true });
      fs.writeFileSync(rsAbs, expectedRs, "utf-8");
    } else {
      findings.push(
        finding("generated_drift", `${GENERATED_RS} is stale or missing.`, GENERATED_RS),
      );
    }
  }
  return findings;
}

function checkContractIds(ctx, manifest) {
  const findings = [];
  const fromManifest = manifest.networks.testnet.contractIds;
  const source = ctx.read("frontend/src/config/contracts.ts") ?? "";
  const found = {};
  const regex = /(\w+_ID):\s*"(C[A-Z2-7]{55})"/g;
  let m;
  while ((m = regex.exec(source)) !== null) found[m[1]] = m[2];

  for (const [name, id] of Object.entries(fromManifest)) {
    if (found[name] === undefined) {
      findings.push(
        finding("contract_id_drift", `${name} from the manifest is missing in frontend/src/config/contracts.ts.`, "frontend/src/config/contracts.ts"),
      );
    } else if (found[name] !== id) {
      findings.push(
        finding("contract_id_drift", `${name} is ${found[name]} in frontend/src/config/contracts.ts but ${id} in the manifest.`, "frontend/src/config/contracts.ts"),
      );
    }
  }
  for (const [name, id] of Object.entries(found)) {
    if (!/^C[A-Z2-7]{55}$/.test(id)) {
      findings.push(
        finding("contract_id_drift", `Invalid Strkey address for ${name}: ${id}`, "frontend/src/config/contracts.ts"),
      );
    }
  }
  return findings;
}

function checkLegacy(ctx) {
  const findings = [];
  const files = walk(path.join(ctx.root, "frontend/src"), [".ts", ".tsx"]);
  const hits = [];
  for (const file of files) {
    try {
      if (fs.readFileSync(file, "utf-8").includes("initializeContractClients")) hits.push(ctx.rel(file));
    } catch {
      /* unreadable file handled by other checks */
    }
  }
  if (hits.length) {
    findings.push(finding("legacy_initializer", `Legacy initializer still referenced in: ${hits.join(", ")}`, hits[0], "Remove the legacy initializer references."));
  }
  const legacyPath = path.join(ctx.root, "frontend/src/lib/contracts.ts");
  const clientPath = path.join(ctx.root, "frontend/src/lib/client.ts");
  const queuePath = path.join(ctx.root, "frontend/src/lib/offlineQueue.ts");
  if (fs.existsSync(legacyPath)) {
    findings.push(finding("legacy_file", "frontend/src/lib/contracts.ts should be deleted.", "frontend/src/lib/contracts.ts", "Delete the legacy contracts module."));
  }
  if (!fs.existsSync(clientPath)) {
    findings.push(finding("client", "frontend/src/lib/client.ts (unified client) is missing.", "frontend/src/lib/client.ts", "Restore the unified client."));
  }
  if (!fs.existsSync(queuePath)) {
    findings.push(finding("queue", "frontend/src/lib/offlineQueue.ts is missing.", "frontend/src/lib/offlineQueue.ts", "Restore the offline queue."));
  }
  return findings;
}

function checkUrls(ctx) {
  const findings = [];
  const envConfig = "frontend/src/config/env.ts";
  if (!ctx.read(envConfig)) {
    findings.push(finding("url_config_source", `${envConfig} (single URL config source) is missing.`, envConfig, "Restore the single URL config source."));
  }
  const patterns = [
    /VITE_RELAYER_URL\s*\|\|\s*["']http:\/\/localhost:3001["']/,
    /const RELAYER_URL\s*=\s*import\.meta\.env\.VITE_RELAYER_URL/,
    /rpcUrl\s*:\s*["']https:\/\/soroban-testnet\.stellar\.org["']/,
    /["']https:\/\/horizon-testnet\.stellar\.org["']/,
  ];
  const envAbs = path.join(ctx.root, envConfig);
  const offenders = [];
  for (const file of walk(path.join(ctx.root, "frontend/src"), [".ts", ".tsx"])) {
    if (file === envAbs) continue;
    const content = fs.readFileSync(file, "utf-8");
    if (patterns.some((p) => p.test(content))) offenders.push(ctx.rel(file));
  }
  if (offenders.length) {
    findings.push(
      finding("hardcoded_urls", `Hardcoded service URLs outside ${envConfig}: ${offenders.join(", ")}`, offenders[0], `Import the URL from ${envConfig} instead of hardcoding it.`),
    );
  }
  return findings;
}

/** Parse `component main {public [a, b, c]} = ...` from a circom source. */
function circomPublicSignals(source) {
  const m = source.match(/component\s+main\s*\{public\s*\[([^\]]*)\]/);
  if (!m) return null;
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}

function parseRegistryVoteSignals(source) {
  const section = source.split("### 1.1")[1]?.split("---")[0] ?? "";
  const rows = [...section.matchAll(/\|\s*`(\d+)`\s*\|\s*`([A-Za-z0-9_]+)`\s*\|/g)];
  return rows.map((r) => r[2]);
}

function checkSignals(ctx, manifest) {
  const findings = [];
  const vote = manifest.circuits.vote_v1.publicSignals;
  const circom = ctx.read("circuits/vote.circom");
  if (circom === null) {
    findings.push(finding("public_signal_drift", "circuits/vote.circom is missing.", "circuits/vote.circom"));
  } else {
    const parsed = circomPublicSignals(circom);
    if (!parsed) {
      findings.push(finding("public_signal_drift", "Could not parse the public signal list from circuits/vote.circom.", "circuits/vote.circom"));
    } else if (parsed.join(",") !== vote.join(",")) {
      findings.push(
        finding("public_signal_drift", `circuits/vote.circom declares [${parsed.join(", ")}] but the manifest requires [${vote.join(", ")}]. A VK for the wrong signal order can never register (IC length must be ${vote.length + 1}).`, "circuits/vote.circom"),
      );
    }
  }

  const rust = ctx.read("contracts/voting/src/lib.rs") ?? "";
  // Anchor on the plain constant; variants such as ENCRYPTED_NUM_PUBLIC_SIGNALS
  // must not satisfy the check.
  const rustMatch = rust.match(/(?:^|\n)\s*(?:pub\s+)?const NUM_PUBLIC_SIGNALS:\s*u32\s*=\s*(\d+)\s*;/);
  if (!rustMatch) {
    findings.push(finding("public_signal_drift", "Could not parse NUM_PUBLIC_SIGNALS from contracts/voting/src/lib.rs.", "contracts/voting/src/lib.rs"));
  } else if (Number(rustMatch[1]) !== vote.length) {
    findings.push(
      finding("public_signal_drift", `contracts/voting/src/lib.rs declares NUM_PUBLIC_SIGNALS=${rustMatch[1]} but the manifest requires ${vote.length}.`, "contracts/voting/src/lib.rs"),
    );
  }

  const ts = ctx.read("frontend/src/types/index.ts") ?? "";
  const tsMatch = ts.match(/(?:^|\n)\s*export const NUM_PUBLIC_SIGNALS\s*=\s*(\d+)\s*;/);
  if (!tsMatch) {
    findings.push(finding("public_signal_drift", "Could not parse NUM_PUBLIC_SIGNALS from frontend/src/types/index.ts.", "frontend/src/types/index.ts"));
  } else if (Number(tsMatch[1]) !== vote.length) {
    findings.push(
      finding("public_signal_drift", `frontend/src/types/index.ts declares NUM_PUBLIC_SIGNALS=${tsMatch[1]} but the manifest requires ${vote.length}.`, "frontend/src/types/index.ts"),
    );
  }

  const registry = ctx.read("docs/SIGNAL_REGISTRY.md");
  if (registry !== null) {
    const parsed = parseRegistryVoteSignals(registry);
    if (parsed.length && parsed.join(",") !== vote.join(",")) {
      findings.push(
        finding("public_signal_drift", `docs/SIGNAL_REGISTRY.md vote family lists [${parsed.join(", ")}] but the manifest requires [${vote.join(", ")}].`, "docs/SIGNAL_REGISTRY.md"),
      );
    }
  }

  // The checked-in VK must be able to verify what the circuit produces.
  const vkeyRel = "frontend/public/circuits/verification_key.json";
  const vkeyRaw = ctx.read(vkeyRel);
  if (vkeyRaw === null) {
    // The trusted-setup key is intentionally not committed. Pipelines that do
    // produce a key must set ZK_VOTE_REQUIRE_VKEY=1 to make its absence fatal.
    if (process.env.ZK_VOTE_REQUIRE_VKEY === "1") {
      findings.push(
        finding("public_signal_drift", "Checked-in verification_key.json is missing and ZK_VOTE_REQUIRE_VKEY=1. It must contain nPublic=" + vote.length + " and " + (vote.length + 1) + " IC points; see frontend/public/circuits/README.md.", vkeyRel),
      );
    } else {
      console.log("⚠ " + vkeyRel + " is absent (trusted setup artifact); a key with " + (vote.length + 1) + " IC points is required before voting works.");
    }
  } else {
    try {
      const vkey = JSON.parse(vkeyRaw);
      if (typeof vkey.nPublic === "number" && vkey.nPublic !== vote.length) {
        findings.push(
          finding("public_signal_drift", `verification_key.json has nPublic=${vkey.nPublic}, expected ${vote.length}. Regenerate it from the current r1cs.`, vkeyRel),
        );
      }
      if (Array.isArray(vkey.IC) && vkey.IC.length !== vote.length + 1) {
        findings.push(
          finding("public_signal_drift", `verification_key.json has ${vkey.IC.length} IC points, expected ${vote.length + 1}.`, vkeyRel),
        );
      }
    } catch (e) {
      findings.push(finding("public_signal_drift", `verification_key.json is invalid JSON: ${e.message}`, vkeyRel));
    }
  }
  return findings;
}

function checkProofFormat(ctx, manifest) {
  const findings = [];
  const pf = manifest.proofFormat;
  const rustSer = ctx.read("contracts/zkvote-groth16/src/serialization.rs") ?? "";
  // Constants must come from the generated binding, never be restated by hand.
  if (!/pub const PROOF_FORMAT_VERSION:\s*u8\s*=\s*crate::generated::PROOF_FORMAT_VERSION\s*;/.test(rustSer)) {
    findings.push(finding("proof_format_drift", "contracts/zkvote-groth16/src/serialization.rs must source PROOF_FORMAT_VERSION from the generated binding.", "contracts/zkvote-groth16/src/serialization.rs"));
  }
  if (!/pub const SERIALIZED_PROOF_LEN:\s*usize\s*=\s*crate::generated::SERIALIZED_PROOF_LEN\s*;/.test(rustSer)) {
    findings.push(finding("proof_format_drift", "contracts/zkvote-groth16/src/serialization.rs must source SERIALIZED_PROOF_LEN from the generated binding.", "contracts/zkvote-groth16/src/serialization.rs"));
  }
  const backend = ctx.read("backend/src/services/proofSerialization.ts") ?? "";
  if (!backend.includes('from "../generated/zkv1.js"')) {
    findings.push(finding("proof_format_drift", "backend/src/services/proofSerialization.ts must import constants from the generated ZKV1 binding.", "backend/src/services/proofSerialization.ts"));
  }
  const doc = ctx.read("docs/zk-voting-protocol.md") ?? "";
  if (!doc.includes(String(pf.version)) || !doc.includes(String(pf.totalBytes))) {
    findings.push(finding("proof_format_drift", `docs/zk-voting-protocol.md must document ZKV${pf.version} and the ${pf.totalBytes}-byte layout.`, "docs/zk-voting-protocol.md"));
  }
  return findings;
}

function checkErrorCodes(ctx, manifest) {
  const findings = [];
  const sources = {
    Groth16Error: "contracts/zkvote-groth16/src/lib.rs",
    VotingError: "contracts/voting/src/lib.rs",
  };
  for (const [enumName, codes] of Object.entries(manifest.errorCodes)) {
    const rel = sources[enumName];
    if (!rel) continue;
    const source = ctx.read(rel) ?? "";
    for (const [name, code] of Object.entries(codes)) {
      const re = new RegExp("\\b" + name + "\\s*=\\s*" + code + "\\b");
      if (!re.test(source)) {
        findings.push(
          finding("error_code_drift", `${enumName}::${name} is ${code} in the manifest but was not found in ${rel}.`, rel),
        );
      }
    }
  }
  return findings;
}

function checkCircuitIds(ctx, manifest) {
  const findings = [];
  const generated = ctx.read(GENERATED_TS[0]) ?? "";
  for (const circuit of Object.keys(manifest.circuits)) {
    if (!generated.includes('"' + circuit + '"')) {
      findings.push(
        finding("circuit_id_drift", `Circuit ${circuit} from the manifest is absent from the generated binding.`, GENERATED_TS),
      );
    }
  }
  return findings;
}

const CHECKS = [
  ["generated bindings", checkGenerated],
  ["contract IDs", checkContractIds],
  ["legacy client", checkLegacy],
  ["URL config", checkUrls],
  ["public signals", checkSignals],
  ["ZKV1 proof format", checkProofFormat],
  ["error codes", checkErrorCodes],
  ["circuit IDs", checkCircuitIds],
];

/**
 * Run every check and return a structured result. Never calls process.exit, so
 * it can be imported by tests with a fixture root.
 */
export function runDriftGuard({ root = DEFAULT_ROOT, fix = false } = {}) {
  const ctx = makeCtx(root);
  let manifest;
  try {
    manifest = validateManifest(JSON.parse(ctx.read(MANIFEST_REL) ?? "null"));
  } catch (e) {
    return { ok: false, findings: [finding("manifest_invalid", e.message, MANIFEST_REL)], checks: [] };
  }

  const findings = [];
  const checks = [];
  for (const [label, check] of CHECKS) {
    let found;
    try {
      found = check(ctx, manifest, fix);
    } catch (e) {
      found = [finding("check_error", `${label} check threw: ${e.message}`, MANIFEST_REL)];
    }
    for (const f of found) f.check = label;
    findings.push(...found);
    checks.push({ label, findings: found.length });
  }
  return { ok: findings.length === 0, findings, checks };
}

function main() {
  const argv = process.argv.slice(2);
  const fix = argv.includes("--fix");
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex >= 0 ? path.resolve(argv[rootIndex + 1]) : DEFAULT_ROOT;
  const result = runDriftGuard({ root, fix });

  console.log("🔍 Drift guard: checking canonical protocol manifest...");
  for (const c of result.checks) {
    console.log(`   ${c.findings === 0 ? "✓" : "✗"} ${c.label}`);
  }
  for (const f of result.findings) {
    const location = f.file ? ` file=${f.file}` : "";
    console.error(`::error${location}::${f.code}: ${f.message} ${f.fix}`);
  }
  if (!result.ok) {
    console.error(`\n❌ Drift guard FAILED: ${result.findings.map((f) => f.code).join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("\n✅ Drift guard PASSED — no drift");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
