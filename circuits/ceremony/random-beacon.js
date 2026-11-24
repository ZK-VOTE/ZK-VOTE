#!/usr/bin/env node

/**
 * Random Beacon Tool for MPC Ceremony Finalization
 *
 * Implements final Groth16 setup finalization using an unpredictable public
 * random beacon (e.g. Bitcoin block hash, Drand round, or high-entropy seed).
 *
 * This guarantees that even if all MPC participants colluded, the final
 * toxic waste cannot be reconstructed once the beacon entropy is applied.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const snarkjs = require("snarkjs");
const axios = require("axios");
const { program } = require("commander");

const config = require("./config.json");

/**
 * Fetch latest Bitcoin block hash or hash at specific height as entropy
 */
async function fetchBitcoinBlockHash(blockHeight, allowSystemEntropy = false) {
  try {
    if (blockHeight) {
      const resp = await axios.get(`https://blockchain.info/block-height/${blockHeight}?format=json`, { timeout: 10000 });
      if (resp.data && resp.data.blocks && resp.data.blocks[0]) {
        return resp.data.blocks[0].hash;
      }
    } else {
      const resp = await axios.get("https://blockchain.info/q/latesthash", { timeout: 10000 });
      if (resp.data) {
        return resp.data.trim();
      }
    }
  } catch (err) {
    console.warn(`[Beacon] Could not reach blockchain.info (${err.message}), trying drand fallback...`);
  }

  // Fallback to drand
  try {
    const drandResp = await axios.get("https://api.drand.sh/public/latest", { timeout: 10000 });
    if (drandResp.data && drandResp.data.randomness) {
      return drandResp.data.randomness;
    }
  } catch (err) {
    console.warn(`[Beacon] Could not reach drand (${err.message}).`);
  }

  if (allowSystemEntropy) {
    console.warn("[Beacon] Explicit fallback to system entropy (--allow-system-entropy active).");
    return crypto.randomBytes(32).toString("hex");
  }

  throw new Error(
    "External beacon entropy sources unavailable (blockchain.info and drand unreachable). " +
    "A public verifiable beacon is required for production finalization. " +
    "For local testing only, supply an explicit beacon hash or pass --allow-system-entropy."
  );
}

/**
 * Apply random beacon to the final contribution zkey
 */
async function applyBeacon(transcriptDir, customBeaconHash, numIterations = 10, allowSystemEntropy = false) {
  const stateFile = path.join(transcriptDir, "coordinator-state.json");
  let state = {};
  if (fs.existsSync(stateFile)) {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  }

  const lastContributionNum = state.contributionCount || 3;
  const inputZkey = path.join(transcriptDir, `phase2_${lastContributionNum}.zkey`);
  const outputZkey = path.join(transcriptDir, "phase2_final.zkey");

  if (!fs.existsSync(inputZkey)) {
    throw new Error(`Input zkey not found at ${inputZkey}`);
  }

  let beaconHash = customBeaconHash;
  if (!beaconHash) {
    console.log("Fetching external random beacon...");
    beaconHash = await fetchBitcoinBlockHash(config.bitcoinBeaconBlock, allowSystemEntropy);
  }

  console.log(`Applying random beacon:`);
  console.log(`  Beacon Hash: ${beaconHash}`);
  console.log(`  Iterations: 2^${numIterations}`);
  console.log(`  Input: ${inputZkey}`);
  console.log(`  Output: ${outputZkey}`);

  await snarkjs.zKey.beacon(
    inputZkey,
    outputZkey,
    "ZK-VOTE Random Beacon",
    beaconHash,
    numIterations
  );

  const fileBytes = fs.readFileSync(outputZkey);
  const finalFileHash = crypto.createHash("sha256").update(fileBytes).digest("hex");

  state.phase = "COMPLETED";
  state.beaconHash = beaconHash;
  state.beaconIterations = numIterations;
  state.finalZkeyHash = finalFileHash;
  state.completedAt = Date.now();

  const tempStateFile = `${stateFile}.tmp`;
  fs.writeFileSync(tempStateFile, JSON.stringify(state, null, 2));
  fs.renameSync(tempStateFile, stateFile);

  console.log("✓ Random beacon successfully applied!");
  console.log(`  Final zkey SHA-256: ${finalFileHash}`);

  return {
    outputZkey,
    beaconHash,
    finalFileHash,
  };
}

program
  .command("apply")
  .option("--dir <path>", "Transcript directory", "./transcript")
  .option("--beacon <hash>", "Custom beacon hash (e.g. BTC block hash)")
  .option("--iter <number>", "Number of iterations (exponent)", 10)
  .option("--allow-system-entropy", "Explicitly allow local entropy fallback if external sources fail")
  .action(async (options) => {
    try {
      await applyBeacon(
        path.resolve(options.dir),
        options.beacon,
        parseInt(options.iter, 10),
        Boolean(options.allowSystemEntropy)
      );
    } catch (err) {
      console.error("✗ Failed to apply random beacon:", err.message);
      process.exit(1);
    }
  });

if (require.main === module) {
  if (process.argv.length <= 2) {
    applyBeacon(path.resolve("./transcript"), null, 10).catch((err) => {
      console.error("✗ Failed to apply random beacon:", err.message);
      process.exit(1);
    });
  } else {
    program.parse(process.argv);
  }
}

module.exports = {
  fetchBitcoinBlockHash,
  applyBeacon,
};
