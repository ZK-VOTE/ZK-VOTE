#!/usr/bin/env node
/**
 * Poseidon KAT Verification
 *
 * Computes what the Merkle root should be when we register a known commitment,
 * then compares with actual on-chain result.
 */

const path = require("path");
// Use circomlibjs from circuits directory
const { buildPoseidon } = require(path.join(__dirname, "../circuits/node_modules/circomlibjs"));
const { execSync } = require("child_process");
try {
    require("dotenv").config({ path: path.join(__dirname, "../backend/.env") });
} catch (e) {
    // dotenv optional
}

const TREE_DEPTH = 18;

async function verifyPoseidonKAT() {
    console.log("Poseidon KAT - Merkle Root Verification");
    console.log("========================================\n");

    const poseidon = await buildPoseidon();
    const F = poseidon.F;

    // Compute zero hashes for all levels (must match contract)
    // IMPORTANT: Contract uses zero_value = 0 (not Poseidon([0]))
    console.log("Computing zero hashes (circomlib)...");
    console.log("NOTE: Using zero_value = 0 to match contract implementation");
    console.log("");
    const zeroHashes = [];
    let current = 0n; // Contract uses 0, not Poseidon([0])
    zeroHashes.push(current);

    for (let i = 0; i < TREE_DEPTH; i++) {
        current = F.toObject(poseidon([F.e(current), F.e(current)]));
        zeroHashes.push(current);
    }

    console.log(`Zero value (level 0): 0x${zeroHashes[0].toString(16).padStart(64, '0')}`);
    console.log(`Zero hash (level 1) = Poseidon(0, 0): 0x${zeroHashes[1].toString(16).padStart(64, '0')}`);
    console.log(`...`);
    console.log(`Empty root (level ${TREE_DEPTH}): 0x${zeroHashes[TREE_DEPTH].toString(16).padStart(64, '0')}`);
    console.log("");

    // Now compute what root should be if we insert a single known commitment
    const testSecret = 12345n;
    const testSalt = 67890n;
    const commitment = F.toObject(poseidon([F.e(testSecret), F.e(testSalt)]));

    console.log("Test commitment generation:");
    console.log(`  Secret: ${testSecret}`);
    console.log(`  Salt: ${testSalt}`);
    console.log(`  Commitment = Poseidon(secret, salt): 0x${commitment.toString(16).padStart(64, '0')}`);
    console.log("");

    // Compute expected root after inserting this commitment at index 0
    let currentHash = commitment;
    let index = 0;

    for (let level = 0; level < TREE_DEPTH; level++) {
        const isLeft = (index % 2) === 0;
        const sibling = zeroHashes[level];

        if (isLeft) {
            currentHash = F.toObject(poseidon([F.e(currentHash), F.e(sibling)]));
        } else {
            currentHash = F.toObject(poseidon([F.e(sibling), F.e(currentHash)]));
        }
        index = Math.floor(index / 2);
    }

    console.log("Expected Merkle root after inserting commitment at index 0:");
    console.log(`  0x${currentHash.toString(16).padStart(64, '0')}`);
    console.log("");

    // Output as test data
    console.log("=== Test Data for On-Chain Verification ===");
    console.log("");
    console.log("1. Initialize tree with depth 20");
    console.log("2. Register commitment with member address");
    console.log("");
    console.log(`   Commitment (hex): 0x${commitment.toString(16).padStart(64, '0')}`);
    console.log(`   Commitment (U256 parts):`);
    const commitHex = commitment.toString(16).padStart(64, '0');
    console.log(`     hi_hi: 0x${commitHex.slice(0, 16)}`);
    console.log(`     hi_lo: 0x${commitHex.slice(16, 32)}`);
    console.log(`     lo_hi: 0x${commitHex.slice(32, 48)}`);
    console.log(`     lo_lo: 0x${commitHex.slice(48, 64)}`);
    console.log("");

    console.log("3. Call current_root() and compare:");
    console.log(`   Expected: 0x${currentHash.toString(16).padStart(64, '0')}`);
    const rootHex = currentHash.toString(16).padStart(64, '0');
    console.log(`   Expected U256 parts:`);
    console.log(`     hi_hi: 0x${rootHex.slice(0, 16)}`);
    console.log(`     hi_lo: 0x${rootHex.slice(16, 32)}`);
    console.log(`     lo_hi: 0x${rootHex.slice(32, 48)}`);
    console.log(`     lo_lo: 0x${rootHex.slice(48, 64)}`);
    console.log("");

    console.log("If the actual on-chain root matches, Poseidon implementations are COMPATIBLE!");
    console.log("If they differ, there's a parameter mismatch - DO NOT DEPLOY.");
    console.log("");

    // Save test vectors
    const testVector = {
        tree_depth: TREE_DEPTH,
        test_input: {
            secret: testSecret.toString(),
            salt: testSalt.toString()
        },
        commitment: "0x" + commitment.toString(16).padStart(64, '0'),
        expected_root_after_first_insert: "0x" + currentHash.toString(16).padStart(64, '0'),
        zero_hashes: zeroHashes.slice(0, 5).map((h, i) => ({
            level: i,
            hash: "0x" + h.toString(16).padStart(64, '0')
        }))
    };

    const fs = require("fs");
    const outputPath = path.join(__dirname, "../circuits/utils/poseidon_merkle_kat.json");
    fs.writeFileSync(outputPath, JSON.stringify(testVector, null, 2));
    console.log(`Test vector saved to: ${outputPath}`);

    // Check if contracts are deployed
    if (process.env.TREE_CONTRACT_ID) {
        console.log("\n=== Live Verification (requires P25 testnet) ===\n");
        console.log(`Tree contract detected: ${process.env.TREE_CONTRACT_ID}`);
        console.log("To verify on-chain:");
        console.log("1. Create a DAO");
        console.log("2. Mint SBT to test member");
        console.log("3. Register the commitment above");
        console.log("4. Call current_root() and compare with expected");
        console.log("");
        console.log("Example Stellar CLI commands:");
        console.log(`stellar contract invoke --id ${process.env.TREE_CONTRACT_ID} --source mykey --network local -- current_root --dao_id 0`);
    }
}

verifyPoseidonKAT().catch(err => {
    console.error("Error:", err);
    process.exit(1);
});
