#!/usr/bin/env node

/**
 * MPC Ceremony Coordinator Server
 *
 * Manages the trusted setup ceremony by:
 * - Maintaining contributor queue and queue order
 * - Verifying contributions in a sandboxed temp file before committing
 * - Enforcing explicit and validated state transitions (SETUP -> PHASE1 -> PHASE2 -> BEACON -> COMPLETED)
 * - Persisting state atomically across restarts
 * - Publishing canonical ceremony transcripts bound to the on-chain circuit registry
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let express;
try {
  express = require("express");
} catch {
  express = function () {
    return {
      use() {},
      get() {},
      post() {},
      listen() {},
    };
  };
  express.json = () => (_req, _res, next) => next && next();
  express.urlencoded = () => (_req, _res, next) => next && next();
  express.static = () => (_req, _res, next) => next && next();
}

let snarkjs;
try {
  snarkjs = require("snarkjs");
} catch {
  snarkjs = {};
}

let chalk;
try {
  chalk = require("chalk");
} catch {
  const identity = (str) => str;
  chalk = {
    blue: Object.assign(identity, { bold: identity }),
    green: Object.assign(identity, { bold: identity }),
    yellow: identity,
    red: identity,
    cyan: identity,
    white: identity,
    gray: identity,
  };
}

let multer;
try {
  multer = require("multer");
} catch {
  multer = function () {
    return {
      single: () => (_req, _res, next) => next && next(),
    };
  };
  multer.diskStorage = () => ({});
  multer.MulterError = class MulterError extends Error {};
}

const config = require("./config.json");

const app = express();
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ extended: true, limit: "500mb" }));
app.use(express.static("public"));

// Ensure transcript and temp directories exist
const transcriptDir = path.join(__dirname, config.transcriptDir || "./transcript");
if (!fs.existsSync(transcriptDir)) {
  fs.mkdirSync(transcriptDir, { recursive: true });
}

const tempUploadDir = path.join(transcriptDir, ".tmp_uploads");
if (!fs.existsSync(tempUploadDir)) {
  fs.mkdirSync(tempUploadDir, { recursive: true });
}

// Multer storage for secure upload handling
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, tempUploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    cb(null, `upload-${uniqueSuffix}.tmp`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500 MB limit
  },
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = [".ptau", ".zkey", ".tmp", ""];
    if (ext && !allowed.includes(ext)) {
      return cb(new Error("Invalid file extension: only .ptau and .zkey parameters are accepted"));
    }
    cb(null, true);
  },
});

// State machine definition
const VALID_PHASES = ["SETUP", "PHASE1", "PHASE2", "BEACON", "COMPLETED"];
const ALLOWED_TRANSITIONS = {
  SETUP: ["PHASE1"],
  PHASE1: ["PHASE2"],
  PHASE2: ["BEACON"],
  BEACON: ["COMPLETED"],
  COMPLETED: [],
};

// Initial state
const state = {
  phase: "SETUP", // SETUP, PHASE1, PHASE2, BEACON, COMPLETED
  currentContributor: null,
  contributionCount: 0,
  queue: [],
  contributions: [],
  startTime: Date.now(),
  beaconHash: null,
  finalZkeyHash: null,
  completedAt: null,
};

// State persistence (atomic write)
const stateFile = path.join(transcriptDir, "coordinator-state.json");

function saveState() {
  const tempStateFile = `${stateFile}.tmp`;
  fs.writeFileSync(tempStateFile, JSON.stringify(state, null, 2));
  fs.renameSync(tempStateFile, stateFile);
}

function transitionState(newPhase) {
  if (!VALID_PHASES.includes(newPhase)) {
    throw new Error(`Invalid phase name: ${newPhase}`);
  }
  const allowed = ALLOWED_TRANSITIONS[state.phase] || [];
  if (!allowed.includes(newPhase)) {
    throw new Error(`Invalid state transition: cannot transition from ${state.phase} to ${newPhase}`);
  }
  const oldPhase = state.phase;
  state.phase = newPhase;
  saveState();
  console.log(chalk.cyan(`\n🔄 State transition: ${oldPhase} ➔ ${newPhase}`));
}

// Load existing state if available, with validation
if (fs.existsSync(stateFile)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (loaded && VALID_PHASES.includes(loaded.phase)) {
      Object.assign(state, loaded);
      console.log(chalk.green(`✓ Loaded existing ceremony state (Phase: ${state.phase}, Contributions: ${state.contributionCount})`));
    } else {
      console.warn(chalk.yellow(`⚠ Existing state file contained invalid phase: ${loaded?.phase}; starting with default state`));
    }
  } catch (err) {
    console.error(chalk.red("✗ Failed to parse existing state file:"), err);
  }
}

// Operator Authentication Middleware
const OPERATOR_KEY = process.env.CEREMONY_OPERATOR_KEY || config.operatorKey || "operator-secret-ceremony-2026";

function authenticateOperator(req, res, next) {
  const authHeader = req.headers["x-operator-key"] || req.headers["authorization"];
  const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  if (!token || token !== OPERATOR_KEY) {
    return res.status(401).json({ error: "Unauthorized: valid operator key required" });
  }
  next();
}

// Canonical transcript hash computation
function computeTranscriptHash(contributions, beaconHash) {
  const hasher = crypto.createHash("sha256");
  for (const c of contributions || []) {
    if (c.fileHash) {
      hasher.update(Buffer.from(c.fileHash, "hex"));
    }
  }
  if (beaconHash) {
    hasher.update(Buffer.from(beaconHash, "hex"));
  }
  return hasher.digest("hex");
}

// ============================================
// API Endpoints
// ============================================

app.get("/ceremony/status", (req, res) => {
  res.json({
    phase: state.phase,
    contributionCount: state.contributionCount,
    minContributors: config.minContributors,
    queueLength: state.queue.length,
    currentContributor: state.currentContributor,
    ceremony: config.ceremony,
  });
});

app.post("/ceremony/join", (req, res) => {
  const { name, email, pgpKey } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: "Name and email required" });
  }

  const contributorId = crypto.randomBytes(16).toString("hex");

  const contributor = {
    id: contributorId,
    name,
    email,
    pgpKey: pgpKey || null,
    joinedAt: Date.now(),
    position: state.queue.length + 1,
  };

  state.queue.push(contributor);

  // If in active phase and no current contributor, assign immediately
  if ((state.phase === "PHASE1" || state.phase === "PHASE2") && !state.currentContributor) {
    state.currentContributor = contributorId;
  }

  saveState();

  console.log(chalk.blue(`➕ ${name} joined (position ${contributor.position})`));

  res.json({
    contributorId,
    position: contributor.position,
    estimatedWait: contributor.position * (config.contributionTimeout || 1800),
  });
});

// Explicit Operator Transition: SETUP -> PHASE1 with PTAU bootstrap
app.post("/ceremony/start-phase1", authenticateOperator, async (req, res) => {
  try {
    if (state.phase !== "SETUP") {
      return res.status(400).json({
        error: `Cannot start Phase 1 from phase ${state.phase}; expected SETUP`,
      });
    }

    const ptau0 = path.join(transcriptDir, "phase1_0.ptau");
    if (!fs.existsSync(ptau0)) {
      console.log(chalk.yellow("⏳ Bootstrapping Phase 1 Powers of Tau accumulator..."));
      const power = config.phase1PtauPower || 12;
      await snarkjs.powersOfTau.newAccumulator("bn128", power, ptau0);
      console.log(chalk.green(`✓ Created initial ptau file at ${ptau0}`));
    }

    transitionState("PHASE1");
    state.contributionCount = 0;
    if (state.queue.length > 0) {
      state.currentContributor = state.queue[0].id;
    }
    saveState();

    res.json({
      success: true,
      phase: state.phase,
      currentContributor: state.currentContributor,
      initialFile: "phase1_0.ptau",
    });
  } catch (error) {
    console.error(chalk.red("✗ Error starting Phase 1:"), error);
    res.status(500).json({ error: "Failed to start Phase 1", details: error.message });
  }
});

app.get("/ceremony/current-params", async (req, res) => {
  const { contributorId } = req.query;

  if (!contributorId) {
    return res.status(400).json({ error: "Contributor ID required" });
  }

  if (state.currentContributor !== contributorId) {
    const position = state.queue.findIndex((c) => c.id === contributorId);
    return res.status(403).json({
      error: "Not your turn",
      position: position >= 0 ? position + 1 : -1,
      currentContributor: state.currentContributor,
    });
  }

  try {
    let paramsFile;
    if (state.phase === "PHASE1" || state.phase === "SETUP") {
      paramsFile = path.join(transcriptDir, `phase1_${state.contributionCount}.ptau`);
    } else if (state.phase === "PHASE2") {
      paramsFile = path.join(transcriptDir, `phase2_${state.contributionCount}.zkey`);
    }

    if (!paramsFile || !fs.existsSync(paramsFile)) {
      return res.status(404).json({ error: "Parameters file not found on coordinator" });
    }

    res.download(paramsFile);
  } catch (error) {
    console.error(chalk.red("✗ Error sending parameters:"), error);
    res.status(500).json({ error: "Failed to send parameters" });
  }
});

// Contribution Handler with Multer Multipart Parsing and Sandboxed Temp Verification
app.post(
  "/ceremony/contribute",
  (req, res, next) => {
    upload.single("params")(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ error: "Contribution file exceeds maximum allowed size (500MB)" });
        }
        return res.status(400).json({ error: err.message || "Failed to parse multipart contribution" });
      }
      next();
    });
  },
  async (req, res) => {
    const { contributorId, contributorName, entropySource } = req.body;
    const uploadedFile = req.file;

    if (!contributorId || !uploadedFile) {
      if (uploadedFile && fs.existsSync(uploadedFile.path)) {
        fs.unlinkSync(uploadedFile.path);
      }
      return res.status(400).json({ error: "Missing contribution data or parameters file" });
    }

    if (state.phase !== "PHASE1" && state.phase !== "PHASE2") {
      if (fs.existsSync(uploadedFile.path)) {
        fs.unlinkSync(uploadedFile.path);
      }
      return res.status(400).json({ error: `Contributions not accepted in phase ${state.phase}` });
    }

    if (state.currentContributor !== contributorId) {
      if (fs.existsSync(uploadedFile.path)) {
        fs.unlinkSync(uploadedFile.path);
      }
      return res.status(403).json({ error: "Not your turn" });
    }

    const tempFilePath = uploadedFile.path;

    try {
      const contributionNum = state.contributionCount + 1;
      const isPhase1 = state.phase === "PHASE1";
      const ext = isPhase1 ? "ptau" : "zkey";
      const previousFile = path.join(
        transcriptDir,
        `${isPhase1 ? "phase1" : "phase2"}_${state.contributionCount}.${ext}`,
      );

      if (!fs.existsSync(previousFile)) {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        return res.status(500).json({ error: `Previous parameters file not found: ${path.basename(previousFile)}` });
      }

      console.log(
        chalk.yellow(
          `⏳ Verifying contribution ${contributionNum} from ${contributorName || "anonymous"} in sandbox temp file...`,
        ),
      );

      // Verify contribution in the temp file BEFORE committing to the transcript directory
      let verification = false;
      try {
        if (isPhase1) {
          verification = await snarkjs.powersOfTau.verify(tempFilePath);
        } else {
          const r1csPath = config.circuitPath.replace(".circom", ".r1cs");
          verification = await snarkjs.zKey.verifyFromR1cs(
            r1csPath,
            previousFile,
            tempFilePath,
          );
        }
      } catch (verifErr) {
        console.error(chalk.red("✗ Verification exception:"), verifErr.message);
        verification = false;
      }

      if (!verification) {
        console.log(chalk.red(`✗ Contribution verification failed`));
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
        return res.status(400).json({ error: "Contribution verification failed" });
      }

      // Compute sha256 hash of verified file
      const fileBytes = fs.readFileSync(tempFilePath);
      const fileHash = crypto.createHash("sha256").update(fileBytes).digest("hex");

      // Atomically commit verified file to transcript directory
      const finalFileName = `${isPhase1 ? "phase1" : "phase2"}_${contributionNum}.${ext}`;
      const finalPath = path.join(transcriptDir, finalFileName);
      fs.renameSync(tempFilePath, finalPath);

      // Record contribution
      const contribution = {
        num: contributionNum,
        phase: state.phase,
        contributor: {
          id: contributorId,
          name: contributorName || "Anonymous",
        },
        entropySource: entropySource || "unspecified",
        timestamp: Date.now(),
        fileHash,
        fileName: finalFileName,
      };

      state.contributions.push(contribution);
      state.contributionCount++;

      // Advance queue
      state.queue.shift();
      state.currentContributor = state.queue.length > 0 ? state.queue[0].id : null;

      saveState();

      console.log(chalk.green(`✓ Contribution ${contributionNum} verified and committed`));
      console.log(chalk.gray(`  Hash: ${fileHash}`));

      res.json({
        success: true,
        contributionNum,
        fileHash,
        nextContributor: state.currentContributor,
      });

      // Advance phase if target contributors reached
      if (state.contributionCount >= config.minContributors) {
        if (state.phase === "PHASE1") {
          console.log(chalk.green.bold("\n🎉 Phase 1 complete! Transitioning to Phase 2...\n"));
          await transitionToPhase2();
        } else if (state.phase === "PHASE2") {
          console.log(chalk.green.bold("\n🎉 Phase 2 complete! Ready for random beacon...\n"));
          transitionState("BEACON");
        }
      }
    } catch (error) {
      if (fs.existsSync(tempFilePath)) {
        try { fs.unlinkSync(tempFilePath); } catch {}
      }
      console.error(chalk.red("✗ Error processing contribution:"), error);
      res.status(500).json({ error: "Failed to process contribution", details: error.message });
    }
  },
);

async function transitionToPhase2() {
  try {
    console.log(chalk.yellow("⏳ Preparing Phase 2..."));

    // Apply beacon to Phase 1
    const phase1Final = path.join(
      transcriptDir,
      `phase1_${state.contributionCount}.ptau`,
    );
    const phase1Beacon = path.join(transcriptDir, "phase1_beacon.ptau");

    await snarkjs.powersOfTau.beacon(
      phase1Final,
      phase1Beacon,
      "ZK-VOTE",
      10,
      crypto.randomBytes(32).toString("hex"),
    );

    // Prepare Phase 2 initial zkey
    const phase2Initial = path.join(transcriptDir, "phase2_0.zkey");
    const r1csPath = config.circuitPath.replace(".circom", ".r1cs");
    await snarkjs.zKey.newZKey(
      r1csPath,
      phase1Beacon,
      phase2Initial,
    );

    transitionState("PHASE2");
    state.contributionCount = 0;
    state.currentContributor = state.queue.length > 0 ? state.queue[0].id : null;
    saveState();

    console.log(chalk.green("✓ Phase 2 ready for contributions"));
  } catch (error) {
    console.error(chalk.red("✗ Error transitioning to Phase 2:"), error);
    throw error;
  }
}

app.get("/ceremony/transcript", (req, res) => {
  const transcriptHash = computeTranscriptHash(
    state.contributions || [],
    state.beaconHash || null,
  );

  const transcript = {
    ceremony: config.ceremony,
    phase: state.phase,
    totalContributions: state.contributionCount,
    contributions: state.contributions,
    beaconHash: state.beaconHash || null,
    transcriptHash,
    circuitRegistryPayload: {
      ceremony_transcript_hash: transcriptHash,
      phase: state.phase,
      total_contributions: state.contributions ? state.contributions.length : 0,
    },
    startTime: state.startTime,
    completedTime: state.phase === "COMPLETED" ? state.completedAt || Date.now() : null,
  };

  res.json(transcript);
});

app.get("/ceremony/download/:filename", (req, res) => {
  const filename = req.params.filename;
  // Prevent directory traversal
  const safeFilename = path.basename(filename);
  const filepath = path.join(transcriptDir, safeFilename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: "File not found" });
  }

  res.download(filepath);
});

// Start server
const PORT = config.coordinatorPort || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(chalk.blue.bold("\n╔══════════════════════════════════════════╗"));
    console.log(chalk.blue.bold("║  ZK-VOTE MPC Ceremony Coordinator        ║"));
    console.log(chalk.blue.bold("╚══════════════════════════════════════════╝\n"));
    console.log(chalk.white(`Server running on port ${PORT}`));
    console.log(chalk.white(`Phase: ${state.phase}`));
    console.log(chalk.white(`Contributions: ${state.contributionCount}/${config.minContributors}`));
    console.log(chalk.white(`Queue: ${state.queue.length} contributors\n`));
    console.log(chalk.gray(`Transcript directory: ${transcriptDir}`));
    console.log(chalk.gray(`API: http://localhost:${PORT}/ceremony/\n`));
  });
}

module.exports = { app, state, saveState, transitionState, computeTranscriptHash };
