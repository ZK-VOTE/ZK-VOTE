#!/usr/bin/env node
/**
 * Copy compiled circuit artifacts into frontend/public/circuits.
 *
 * Production / Docker (CIRCUITS_BUILD or STRICT_CIRCUITS=1): fail hard when
 * vote.wasm / vote_final.zkey are missing (#645).
 *
 * Local / frontend-only CI: warn and continue so typecheck builds are not
 * blocked when circuits have not been compiled in this checkout.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..");
const buildRoot = path.resolve(
  process.env.CIRCUITS_BUILD || path.join(frontendRoot, "../circuits/build"),
);
const outRoot = path.join(frontendRoot, "public/circuits");
const strict =
  process.env.STRICT_CIRCUITS === "1" || Boolean(process.env.CIRCUITS_BUILD);

function copyRequired(srcRel, destRel) {
  const src = path.join(buildRoot, srcRel);
  const dest = path.join(outRoot, destRel);
  if (!fs.existsSync(src)) {
    const msg =
      `[sync:circuits] REQUIRED artifact missing: ${src}\n` +
      `  Compile circuits first (circuits/compile*.sh) or set CIRCUITS_BUILD.`;
    if (strict) {
      console.error(msg);
      process.exit(1);
    }
    console.warn(msg + "\n  (non-strict mode: continuing without it)");
    return false;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[sync:circuits] ${destRel}`);
  return true;
}

function copyOptional(srcRel, destRel) {
  const src = path.join(buildRoot, srcRel);
  const dest = path.join(outRoot, destRel);
  if (!fs.existsSync(src)) {
    console.warn(`[sync:circuits] optional missing: ${srcRel}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[sync:circuits] ${destRel}`);
}

fs.mkdirSync(path.join(outRoot, "comment"), { recursive: true });

const okWasm = copyRequired("vote_js/vote.wasm", "vote.wasm");
const okZkey = copyRequired("vote_final.zkey", "vote_final.zkey");

copyOptional("comment_js/comment.wasm", "comment/comment.wasm");
copyOptional("comment_final.zkey", "comment/comment_final.zkey");
copyOptional("verification_key.json", "verification_key.json");

for (const depth of [10, 15, 20, 25]) {
  const depthDir = path.join(buildRoot, `depth_${depth}`);
  if (!fs.existsSync(depthDir)) continue;
  const outDepth = path.join(outRoot, `depth_${depth}`);
  fs.mkdirSync(outDepth, { recursive: true });
  for (const name of ["vote.wasm", "vote_final.zkey", "verification_key.json"]) {
    const src = path.join(depthDir, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(outDepth, name));
      console.log(`[sync:circuits] depth_${depth}/${name}`);
    }
  }
}

if (okWasm && okZkey) {
  console.log("[sync:circuits] done (vote artifacts present)");
} else {
  console.log("[sync:circuits] done (vote artifacts incomplete — not for production)");
}
