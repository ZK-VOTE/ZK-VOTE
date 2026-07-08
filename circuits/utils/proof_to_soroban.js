const fs = require("fs");

// Convert proof from snarkjs format to Soroban format

function bigintToBytes(bigint, length) {
  const hex = bigint.toString(16).padStart(length * 2, "0");
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

function g1ToBytes(point) {
  // G1 point: [x, y] -> 64 bytes
  const x = BigInt(point[0]);
  const y = BigInt(point[1]);
  return [...bigintToBytes(x, 32), ...bigintToBytes(y, 32)];
}

function g2ToBytes(point) {
  // G2 point: [[x1, x2], [y1, y2]] -> 128 bytes
  const x = point[0];
  const y = point[1];

  // snarkjs uses reversed ordering
  const x1 = BigInt(x[1]);
  const x2 = BigInt(x[0]);
  const y1 = BigInt(y[1]);
  const y2 = BigInt(y[0]);

  return [
    ...bigintToBytes(x1, 32),
    ...bigintToBytes(x2, 32),
    ...bigintToBytes(y1, 32),
    ...bigintToBytes(y2, 32)
  ];
}

function convertProof(proofPath, publicPath) {
  const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  const publicSignals = JSON.parse(fs.readFileSync(publicPath, "utf8"));

  return {
    proof: {
      a: g1ToBytes(proof.pi_a),
      b: g2ToBytes(proof.pi_b),
      c: g1ToBytes(proof.pi_c)
    },
    publicSignals: publicSignals.map(s => BigInt(s).toString())
  };
}

function toHexString(bytes) {
  return bytes.map(b => b.toString(16).padStart(2, "0")).join("");
}

if (require.main === module) {
  const proofPath = process.argv[2] || "proof.json";
  const publicPath = process.argv[3] || "public.json";

  if (!fs.existsSync(proofPath) || !fs.existsSync(publicPath)) {
    console.error(`Error: Proof files not found`);
    console.error("Run ./generate_proof.sh first");
    process.exit(1);
  }

  console.log("Converting proof to Soroban format...\n");

  const { proof, publicSignals } = convertProof(proofPath, publicPath);

  console.log("=== Proof (Hex) ===");
  console.log(`A (G1, 64 bytes): ${toHexString(proof.a)}`);
  console.log(`B (G2, 128 bytes): ${toHexString(proof.b)}`);
  console.log(`C (G1, 64 bytes): ${toHexString(proof.c)}`);

  console.log("\n=== Public Signals ===");
  console.log(`[0] Root:        ${publicSignals[0]}`);
  console.log(`[1] Nullifier:   ${publicSignals[1]}`);
  console.log(`[2] DAO ID:      ${publicSignals[2]}`);
  console.log(`[3] Proposal ID: ${publicSignals[3]}`);
  console.log(`[4] Vote Choice: ${publicSignals[4]} (${publicSignals[4] === "1" ? "YES" : "NO"})`);

  // Save JSON format
  const outputPath = "proof_soroban.json";
  fs.writeFileSync(outputPath, JSON.stringify({
    proof: {
      a: toHexString(proof.a),
      b: toHexString(proof.b),
      c: toHexString(proof.c)
    },
    publicSignals
  }, null, 2));

  console.log(`\nSaved to ${outputPath}`);

  // Generate Stellar CLI command
  console.log("\n=== Stellar CLI Vote Command ===");
  console.log(`
stellar contract invoke \\
  --id <VOTING_CONTRACT_ID> \\
  --source-account relayer \\
  -- vote \\
  --dao_id ${publicSignals[2]} \\
  --proposal_id ${publicSignals[3]} \\
  --vote_choice ${publicSignals[4] === "1"} \\
  --nullifier ${publicSignals[1]} \\
  --root ${publicSignals[0]} \\
  --proof '{"a": "${toHexString(proof.a)}", "b": "${toHexString(proof.b)}", "c": "${toHexString(proof.c)}"}'
  `);
}

module.exports = { convertProof };
