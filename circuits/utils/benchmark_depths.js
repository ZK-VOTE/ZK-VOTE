#!/usr/bin/env node
/**
 * Merkle-depth proving benchmark (#93).
 *
 * Runs a real Groth16 setup and proof for each supported Merkle depth and
 * reports witness-generation, proving and verification times alongside the
 * constraint count, so the depth chosen for an election can be justified with
 * measurements rather than an estimate.
 *
 * Requirements:
 *   - `circom` on PATH (the pinned version; see .circomversion)
 *   - a Powers of Tau file large enough for the biggest depth. Depth 25 needs
 *     ~6.9K constraints, so `powersOfTau28_hez_final_14.ptau` (2^14) is enough:
 *
 *       curl -sSL -o pot14_final.ptau \
 *         https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_14.ptau
 *
 * Usage:
 *   node utils/benchmark_depths.js [--ptau=pot14_final.ptau] [--depths=10,15,18,20,25]
 *                                  [--iterations=5] [--json] [--out=FILE]
 *
 * The setup phase is a throwaway ceremony for measurement only. It is not, and
 * must not be used as, a proving key for a real election.
 */

"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const gen = require("./gen_depth_circuits.js");

const CIRCUITS_DIR = path.join(__dirname, "..");

function parseArgs(argv) {
  const get = (name, fallback) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? fallback : hit.slice(name.length + 3);
  };
  return {
    ptau: get("ptau", path.join(CIRCUITS_DIR, "pot14_final.ptau")),
    depths: get("depths", gen.SUPPORTED_DEPTHS.join(","))
      .split(",")
      .map((d) => Number(d.trim()))
      .filter((d) => Number.isInteger(d)),
    iterations: Number(get("iterations", "5")),
    json: argv.includes("--json"),
    out: get("out", null),
  };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

async function buildInput(depth) {
  const { buildPoseidon } = require("circomlibjs");
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const hash = (xs) => F.toObject(poseidon(xs.map(BigInt)));

  const DOMAIN_TAG =
    19666041591797403834655481403982443037438503980743793537655983658411276515161n;
  const LEAF_DOMAIN = 1n;

  const secret = 12345n;
  const salt = 67890n;
  const blindingFactor = 424242n;
  const daoId = 7n;
  const proposalId = 3n;

  const commitment = hash([DOMAIN_TAG, secret, salt, blindingFactor]);

  const zeros = [0n];
  for (let i = 0; i < depth; i++) zeros.push(hash([zeros[i], zeros[i]]));

  const pathElements = [];
  const pathIndices = [];
  let current = hash([LEAF_DOMAIN, commitment]);
  for (let i = 0; i < depth; i++) {
    pathElements.push(zeros[i].toString());
    pathIndices.push(0);
    current = hash([current, zeros[i]]);
  }

  return {
    root: current.toString(),
    nullifier: hash([secret, daoId, proposalId]).toString(),
    daoId: daoId.toString(),
    proposalId: proposalId.toString(),
    voteChoice: "1",
    numCandidates: "4",
    secret: secret.toString(),
    salt: salt.toString(),
    blindingFactor: blindingFactor.toString(),
    pathElements,
    pathIndices,
  };
}

function compile(depth, workDir) {
  const name = depth === gen.DEFAULT_CIRCUIT_DEPTH ? "vote" : `vote_d${depth}`;
  const source = depth === gen.DEFAULT_CIRCUIT_DEPTH ? "vote.circom" : gen.circuitFileName(depth);
  const outDir = path.join(workDir, name);
  fs.mkdirSync(outDir, { recursive: true });
  execFileSync(
    "circom",
    [source, "--r1cs", "--wasm", "--sym", "-o", outDir, "-l", "node_modules"],
    { cwd: CIRCUITS_DIR, stdio: "pipe" },
  );
  return {
    name,
    r1cs: path.join(outDir, `${name}.r1cs`),
    wasm: path.join(outDir, `${name}_js`, `${name}.wasm`),
    outDir,
  };
}

async function benchmarkDepth(depth, { ptau, iterations, workDir }) {
  const snarkjs = require("snarkjs");
  const artifacts = compile(depth, workDir);

  const info = await snarkjs.r1cs.info(artifacts.r1cs);
  const constraints = info.nConstraints;

  const zkey0 = path.join(artifacts.outDir, "setup_0000.zkey");
  const zkey = path.join(artifacts.outDir, "setup_final.zkey");
  const vkeyPath = path.join(artifacts.outDir, "verification_key.json");

  const setupStart = performance.now();
  await snarkjs.zKey.newZKey(artifacts.r1cs, ptau, zkey0);
  // Benchmark-only entropy: this ceremony is never used for a real election.
  await snarkjs.zKey.contribute(zkey0, zkey, "benchmark", "depth-benchmark-entropy");
  const setupMs = performance.now() - setupStart;

  const vkey = await snarkjs.zKey.exportVerificationKey(zkey);
  fs.writeFileSync(vkeyPath, JSON.stringify(vkey, null, 2));

  const input = await buildInput(depth);

  const witnessMs = [];
  const proveMs = [];
  const verifyMs = [];
  let verified = true;

  for (let i = 0; i < iterations; i++) {
    // fullProve does witness generation and proving together; timing them
    // separately keeps the circuit-size effect visible in both phases.
    const witnessFile = path.join(artifacts.outDir, `witness_${i}.wtns`);
    const wStart = performance.now();
    await snarkjs.wtns.calculate(input, artifacts.wasm, witnessFile);
    witnessMs.push(performance.now() - wStart);

    const pStart = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.prove(zkey, witnessFile);
    proveMs.push(performance.now() - pStart);

    const vStart = performance.now();
    const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    verifyMs.push(performance.now() - vStart);
    verified = verified && ok;

    fs.rmSync(witnessFile, { force: true });
  }

  return {
    depth,
    capacity: 2 ** depth,
    constraints,
    verified,
    setup_ms: Math.round(setupMs),
    witness_ms: Number(median(witnessMs).toFixed(1)),
    prove_ms: Number(median(proveMs).toFixed(1)),
    verify_ms: Number(median(verifyMs).toFixed(1)),
    total_ms: Number((median(witnessMs) + median(proveMs)).toFixed(1)),
  };
}

/** snarkjs restricts "exports", so read its version from the package root. */
function snarkjsVersion() {
  try {
    let dir = path.dirname(require.resolve("snarkjs"));
    for (let i = 0; i < 5; i++) {
      const manifest = path.join(dir, "package.json");
      if (fs.existsSync(manifest)) return JSON.parse(fs.readFileSync(manifest, "utf8")).version;
      dir = path.dirname(dir);
    }
  } catch {
    /* fall through */
  }
  return "unknown";
}

function renderMarkdown(results, meta) {
  const baseline = results.find((r) => r.depth === gen.DEFAULT_CIRCUIT_DEPTH) ?? results[0];
  const lines = [];
  lines.push("| Depth | Capacity | Constraints | Witness (ms) | Prove (ms) | Total (ms) | vs depth 18 |");
  lines.push("|------:|---------:|------------:|-------------:|-----------:|-----------:|------------:|");
  for (const r of results) {
    const delta = ((r.total_ms / baseline.total_ms - 1) * 100).toFixed(0);
    const sign = Number(delta) > 0 ? "+" : "";
    lines.push(
      `| ${r.depth} | ${r.capacity.toLocaleString("en-US")} | ${r.constraints} | ` +
        `${r.witness_ms} | ${r.prove_ms} | ${r.total_ms} | ${sign}${delta}% |`,
    );
  }
  lines.push("");
  lines.push(
    `Measured on ${meta.platform}, ${meta.cpu}, Node ${meta.node}, ` +
      `snarkjs ${meta.snarkjs}, median of ${meta.iterations} runs.`,
  );
  return lines.join("\n");
}

async function main(argv) {
  const args = parseArgs(argv);

  if (!fs.existsSync(args.ptau)) {
    console.error(
      `Powers of Tau file not found: ${args.ptau}\n` +
        "Download it with:\n" +
        "  curl -sSL -o pot14_final.ptau \\\n" +
        "    https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_14.ptau",
    );
    return 1;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "zkvote-depth-bench-"));
  const results = [];
  try {
    for (const depth of args.depths) {
      process.stderr.write(`benchmarking depth ${depth}...\n`);
      results.push(await benchmarkDepth(depth, { ...args, workDir }));
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const meta = {
    platform: `${os.type()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    node: process.version,
    snarkjs: snarkjsVersion(),
    iterations: args.iterations,
    generated_at: new Date().toISOString(),
  };

  const output = args.json
    ? `${JSON.stringify({ meta, results }, null, 2)}\n`
    : `${renderMarkdown(results, meta)}\n`;

  if (args.out) fs.writeFileSync(args.out, output);
  else process.stdout.write(output);

  const failed = results.filter((r) => !r.verified);
  if (failed.length > 0) {
    console.error(`verification failed for depths: ${failed.map((r) => r.depth).join(", ")}`);
    return 1;
  }
  return 0;
}

module.exports = { benchmarkDepth, buildInput, renderMarkdown };

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
