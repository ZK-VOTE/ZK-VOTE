const fs = require("fs");

// Convert verification key from snarkjs format to Soroban format
// Soroban uses compressed G1 (64 bytes) and G2 (128 bytes) points

function bigintToBytes(bigint, length) {
  const hex = bigint.toString(16).padStart(length * 2, "0");
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

function g1ToBytes(point) {
  // G1 point: [x, y] -> 64 bytes (32 for x, 32 for y)
  const x = BigInt(point[0]);
  const y = BigInt(point[1]);
  return [...bigintToBytes(x, 32), ...bigintToBytes(y, 32)];
}

function g2ToBytes(point) {
  // G2 point: [[x1, x2], [y1, y2]] -> 128 bytes
  // Note: snarkjs uses [x2, x1], [y2, y1] ordering
  const x = point[0];
  const y = point[1];

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

function convertVerificationKey(vkeyPath) {
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));

  const sorobanVkey = {
    protocol: vkey.protocol,
    curve: vkey.curve,
    nPublic: vkey.nPublic,

    // G1 points (64 bytes each)
    alpha: g1ToBytes(vkey.vk_alpha_1),

    // G2 points (128 bytes each)
    beta: g2ToBytes(vkey.vk_beta_2),
    gamma: g2ToBytes(vkey.vk_gamma_2),
    delta: g2ToBytes(vkey.vk_delta_2),

    // IC array (G1 points)
    ic: vkey.IC.map(g1ToBytes)
  };

  return sorobanVkey;
}

function toHexString(bytes) {
  return bytes.map(b => b.toString(16).padStart(2, "0")).join("");
}

function toRustBytes(bytes) {
  // Format for Rust BytesN initialization
  return `[${bytes.join(", ")}]`;
}

if (require.main === module) {
  const vkeyPath = process.argv[2] || "build/verification_key.json";

  if (!fs.existsSync(vkeyPath)) {
    console.error(`Error: Verification key not found at ${vkeyPath}`);
    console.error("Run ./compile.sh first to generate the verification key");
    process.exit(1);
  }

  console.log("Converting verification key to Soroban format...\n");

  const sorobanVkey = convertVerificationKey(vkeyPath);

  console.log("=== Verification Key (Hex) ===");
  console.log(`Alpha (G1, 64 bytes): ${toHexString(sorobanVkey.alpha)}`);
  console.log(`Beta  (G2, 128 bytes): ${toHexString(sorobanVkey.beta)}`);
  console.log(`Gamma (G2, 128 bytes): ${toHexString(sorobanVkey.gamma)}`);
  console.log(`Delta (G2, 128 bytes): ${toHexString(sorobanVkey.delta)}`);
  console.log(`IC (${sorobanVkey.ic.length} G1 points):`);
  sorobanVkey.ic.forEach((ic, i) => {
    console.log(`  IC[${i}]: ${toHexString(ic)}`);
  });

  // Save JSON format
  const outputPath = vkeyPath.replace(".json", "_soroban.json");
  fs.writeFileSync(outputPath, JSON.stringify({
    alpha: toHexString(sorobanVkey.alpha),
    beta: toHexString(sorobanVkey.beta),
    gamma: toHexString(sorobanVkey.gamma),
    delta: toHexString(sorobanVkey.delta),
    ic: sorobanVkey.ic.map(toHexString)
  }, null, 2));

  console.log(`\nSaved to ${outputPath}`);

  // Generate Rust code snippet
  console.log("\n=== Rust Code Snippet ===");
  console.log(`
// In your Soroban contract:
let vk = VerificationKey {
    alpha: BytesN::from_array(&env, &hex::decode("${toHexString(sorobanVkey.alpha)}").unwrap().try_into().unwrap()),
    beta: BytesN::from_array(&env, &hex::decode("${toHexString(sorobanVkey.beta)}").unwrap().try_into().unwrap()),
    gamma: BytesN::from_array(&env, &hex::decode("${toHexString(sorobanVkey.gamma)}").unwrap().try_into().unwrap()),
    delta: BytesN::from_array(&env, &hex::decode("${toHexString(sorobanVkey.delta)}").unwrap().try_into().unwrap()),
    ic: vec![&env,
        ${sorobanVkey.ic.map((ic, i) =>
          `BytesN::from_array(&env, &hex::decode("${toHexString(ic)}").unwrap().try_into().unwrap())`
        ).join(",\n        ")}
    ],
};
  `);
}

module.exports = { convertVerificationKey, g1ToBytes, g2ToBytes };
