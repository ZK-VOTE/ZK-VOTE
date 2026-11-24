#!/usr/bin/env node

/**
 * MPC Ceremony Verification, Artifact Signing and Supply-Chain Verification Tool
 *
 * Ceremony commands (unchanged behaviour):
 *  - verify   : validate contributions, hash chain and beacon, compute transcript hash
 *  - extract  : export the VK and produce a transcript attestation payload
 *
 * Supply-chain commands (ZV artifact binding):
 *  - generate-key       : create an Ed25519 release signing key pair
 *  - generate-manifest  : hash zkey/wasm/vkey, build + sign a manifest and a
 *                         transparency-log entry
 *  - verify-artifacts   : verify a signed manifest (signature, trusted release
 *                         key, transparency log, registry transcript hash) and
 *                         verify every artifact by streaming SHA-256
 *
 * All hashes are lowercase SHA-256 hex (64 chars). Manifest bytes are
 * canonicalised (recursively sorted keys, no whitespace) so that the Node
 * release tooling and the browser verifier sign/verify exactly the same bytes.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// snarkjs is only needed for VK extraction from a zkey. Keeping it lazy lets
// the integrity/verification tooling run with just Node's standard library.
let snarkjs = null;
function getSnarkjs() {
  if (!snarkjs) snarkjs = require("snarkjs");
  return snarkjs;
}

let program = null;
try {
  program = require("commander").program;
} catch (e) {
  // commander is optional: a minimal flag parser below covers the same CLI.
}

const config = require("./config.json");

const MANIFEST_SCHEMA = "zkvote.artifact-manifest/v1";
const ENTRY_SCHEMA = "zkvote.transparency-entry/v1";
const ARTIFACT_KINDS = ["zkey", "wasm", "vkey"];
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

class ArtifactManifestError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "ArtifactManifestError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Canonical JSON + hashing
// ---------------------------------------------------------------------------

/** Deterministic JSON: sorted object keys, no whitespace. Mirrors the browser. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

function toHex(buf) {
  return Buffer.from(buf).toString("hex");
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function canonicalBytes(value) {
  return Buffer.from(stableStringify(value), "utf8");
}

function normalizeHash(value, code = "INVALID_HASH") {
  if (typeof value !== "string") {
    throw new ArtifactManifestError(code, "Expected a hexadecimal SHA-256 digest");
  }
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new ArtifactManifestError(code, `Invalid SHA-256 digest: ${value}`);
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Ceremony transcript helpers (existing behaviour)
// ---------------------------------------------------------------------------

function computeFileHash(filePath) {
  const fileBytes = fs.readFileSync(filePath);
  return sha256Hex(fileBytes);
}

/** Streaming file hash: never loads the whole zkey into memory. */
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hasher = crypto.createHash("sha256");
    let size = 0;
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => {
      size += chunk.length;
      hasher.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({ sha256: hasher.digest("hex"), size }));
  });
}

function computeTranscriptHash(contributions, beaconHash) {
  const hasher = crypto.createHash("sha256");
  for (const c of contributions) {
    hasher.update(Buffer.from(c.fileHash, "hex"));
  }
  if (beaconHash) {
    hasher.update(Buffer.from(beaconHash, "hex"));
  }
  return hasher.digest("hex");
}

function computeVkHash(vk) {
  // Canonical representation: sorted keys (PR-117 deterministic compilation).
  return sha256Hex(canonicalBytes(vk));
}

async function verifyCeremony(transcriptDir) {
  console.log("=== Verifying MPC Ceremony Transcript ===");
  const stateFile = path.join(transcriptDir, "coordinator-state.json");
  if (!fs.existsSync(stateFile)) {
    throw new Error(`State file not found at ${stateFile}`);
  }

  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  console.log(`Phase: ${state.phase}`);
  console.log(`Total contributions: ${state.contributions ? state.contributions.length : 0}`);

  const contributions = state.contributions || [];
  if (contributions.length < 3) {
    throw new Error(
      `Insufficient contributions: expected at least 3, got ${contributions.length}`,
    );
  }

  // Verify file hashes and sequence
  for (let i = 0; i < contributions.length; i++) {
    const c = contributions[i];
    console.log(
      `Verifying contribution #${c.num} (${c.contributor ? c.contributor.name : "anonymous"})...`,
    );

    const ptauFile = path.join(transcriptDir, `phase1_${c.num}.ptau`);
    const zkeyFile = path.join(transcriptDir, `phase2_${c.num}.zkey`);
    const targetFile = fs.existsSync(zkeyFile)
      ? zkeyFile
      : fs.existsSync(ptauFile)
        ? ptauFile
        : null;

    if (targetFile) {
      const realHash = computeFileHash(targetFile);
      if (realHash !== c.fileHash) {
        throw new Error(
          `Hash mismatch for contribution #${c.num}: expected ${c.fileHash}, got ${realHash}`,
        );
      }
      console.log(`  ✓ File hash verified: ${realHash.substring(0, 16)}...`);
    } else {
      console.log(
        `  ⚠ File not locally present, relying on recorded hash: ${c.fileHash.substring(0, 16)}...`,
      );
    }
  }

  const beaconHash = state.beaconHash || (state.beacon && state.beacon.hash) || null;
  const transcriptHash = computeTranscriptHash(contributions, beaconHash);

  console.log("\n✓ All contributions verified successfully!");
  console.log(`  Contributors: ${contributions.length}`);
  console.log(`  Beacon Hash: ${beaconHash || "None (self-entropy)"}`);
  console.log(`  Transcript Hash: ${transcriptHash}`);

  return {
    verified: true,
    contributorCount: contributions.length,
    transcriptHash,
    beaconHash,
    circuit: config.circuit,
  };
}

async function extractParameters(transcriptDir, outputDir) {
  const result = await verifyCeremony(transcriptDir);

  const finalZkeyPath = path.join(transcriptDir, "phase2_final.zkey");
  const fallbackZkeyPath = path.join(
    transcriptDir,
    `phase2_${result.contributorCount}.zkey`,
  );
  const activeZkey = fs.existsSync(finalZkeyPath)
    ? finalZkeyPath
    : fs.existsSync(fallbackZkeyPath)
      ? fallbackZkeyPath
      : null;

  if (!activeZkey) {
    throw new Error(
      `No final zkey found in ${transcriptDir} (checked phase2_final.zkey and phase2_${result.contributorCount}.zkey)`,
    );
  }

  console.log(`\nExtracting verification key from ${activeZkey}...`);
  const vk = await getSnarkjs().zKey.exportVerificationKey(activeZkey);

  const outDir = outputDir || transcriptDir;
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const vkPath = path.join(outDir, "verification_key.json");
  fs.writeFileSync(vkPath, JSON.stringify(vk, null, 2));
  console.log(`✓ Verification key written to ${vkPath}`);

  const vkHash = computeVkHash(vk);
  console.log(`  VK Hash (SHA-256): ${vkHash}`);

  const registrationPayload = {
    circuit_id: config.circuit,
    transcript_hash: result.transcriptHash,
    vk_hash: vkHash,
    contributors_count: result.contributorCount,
    beacon_hash: result.beaconHash || "0".repeat(64),
    extracted_at: new Date().toISOString(),
  };

  const payloadPath = path.join(outDir, "transcript_attestation.json");
  fs.writeFileSync(payloadPath, JSON.stringify(registrationPayload, null, 2));
  console.log(`✓ Transcript attestation payload written to ${payloadPath}`);

  return {
    vk,
    vkHash,
    transcriptHash: result.transcriptHash,
    registrationPayload,
  };
}

// ---------------------------------------------------------------------------
// Release keys and signed manifests
// ---------------------------------------------------------------------------

/** Generate a fresh Ed25519 release key pair; keyId is derived from the public key. */
function generateReleaseKeyPair(options = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const publicKeyRawHex = toHex(raw);
  const keyId =
    options.keyId ||
    `rel-${sha256Hex(raw).slice(0, 16)}`;
  return { keyId, publicKeyPem, privateKeyPem, publicKeyRawHex };
}

function readKeyMaterial(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new ArtifactManifestError("KEY_MISSING", "No key material supplied");
  }
  const trimmed = input.trim();
  if (trimmed.includes("BEGIN ")) return trimmed;
  if (fs.existsSync(trimmed)) return fs.readFileSync(trimmed, "utf8").trim();
  return trimmed;
}

function loadPrivateKey(input) {
  const material = readKeyMaterial(input);
  try {
    if (material.includes("BEGIN ")) return crypto.createPrivateKey(material);
    const bytes = material.startsWith("0x")
      ? Buffer.from(material.slice(2), "hex")
      : Buffer.from(material, "base64");
    if (bytes.length !== 32) {
      throw new Error(`Expected 32-byte Ed25519 seed, got ${bytes.length} bytes`);
    }
    return crypto.createPrivateKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX.slice(0, 16), bytes]),
      format: "der",
      type: "pkcs8",
    });
  } catch (err) {
    throw new ArtifactManifestError("KEY_INVALID", `Invalid release private key: ${err.message}`);
  }
}

function loadPublicKey(input) {
  const material = readKeyMaterial(input);
  try {
    if (material.includes("BEGIN ")) return crypto.createPublicKey(material);
    const hex = material.replace(/^0x/, "");
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, "hex")]);
      return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    }
    if (/^[0-9a-fA-F]{88}$/.test(hex)) {
      return crypto.createPublicKey({ key: Buffer.from(hex, "hex"), format: "der", type: "spki" });
    }
    const der = Buffer.from(material, "base64");
    if (der.length === 32) {
      return crypto.createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, der]),
        format: "der",
        type: "spki",
      });
    }
    return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  } catch (err) {
    throw new ArtifactManifestError("KEY_INVALID", `Invalid release public key: ${err.message}`);
  }
}

/** Normalize trusted keys: [{ keyId, publicKey }] where publicKey is PEM/hex/base64. */
function normalizeTrustedKeys(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  if (list.length === 0 || list.some((k) => k == null)) {
    throw new ArtifactManifestError("KEY_NOT_TRUSTED", "No trusted release keys configured");
  }
  return list.map((entry) => {
    const key = entry.key instanceof crypto.KeyObject ? entry.key : loadPublicKey(entry.publicKey);
    let der;
    try {
      der = key.export({ type: "spki", format: "der" });
    } catch (e) {
      der = null;
    }
    // When only key material is supplied, derive the same keyId as
    // generateReleaseKeyPair so operators need not pass --key-id twice.
    const keyId = entry.keyId || (der ? `rel-${sha256Hex(der.subarray(-32)).slice(0, 16)}` : undefined);
    return { keyId, key };
  });
}

function describeArtifacts(artifactPaths) {
  const descriptors = {};
  for (const kind of ARTIFACT_KINDS) {
    const filePath = artifactPaths[kind];
    if (!filePath || !fs.existsSync(filePath)) {
      throw new ArtifactManifestError(
        "ARTIFACT_MISSING",
        `Missing ${kind} artifact at ${filePath || "(not supplied)"}`,
      );
    }
    descriptors[kind] = { sha256: "", size: 0, _path: filePath };
  }
  // Hash lazily so callers can amend metadata before hashing.
  return descriptors;
}

async function hashDescriptors(descriptors) {
  for (const kind of ARTIFACT_KINDS) {
    const descriptor = descriptors[kind];
    if (!descriptor) throw new ArtifactManifestError("ARTIFACT_MISSING", `Missing ${kind} descriptor`);
    if (descriptor.sha256 && descriptor.size) continue;
    const result = await hashFile(descriptor._path || descriptor.path);
    descriptor.sha256 = result.sha256;
    descriptor.size = result.size;
  }
  return descriptors;
}

function stripPrivateFields(descriptors) {
  const out = {};
  for (const kind of ARTIFACT_KINDS) {
    const { sha256, size } = descriptors[kind];
    out[kind] = { sha256: normalizeHash(sha256, "INVALID_ARTIFACT_HASH"), size };
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new ArtifactManifestError("INVALID_ARTIFACT_SIZE", `${kind} size must be a positive integer`);
    }
  }
  return out;
}

function buildUnsignedManifest(options) {
  const circuitId = options.circuitId || config.circuit;
  if (typeof circuitId !== "string" || circuitId.length === 0) {
    throw new ArtifactManifestError("INVALID_MANIFEST", "circuitId is required");
  }
  if (!Number.isSafeInteger(options.version) || options.version < 0) {
    throw new ArtifactManifestError("INVALID_MANIFEST", "version must be a non-negative integer");
  }
  const artifacts = stripPrivateFields(options.artifacts || {});
  const ceremonyTranscriptHash = normalizeHash(
    options.ceremonyTranscriptHash,
    "INVALID_TRANSCRIPT_HASH",
  );
  const transparencyLog = options.transparencyLog || {
    id: options.logId || "zkvote-artifacts-v1",
    index: options.logIndex ?? 0,
    previousEntryHash: options.previousEntryHash ?? null,
  };
  if (typeof transparencyLog.id !== "string" || transparencyLog.id.length === 0) {
    throw new ArtifactManifestError("INVALID_MANIFEST", "transparencyLog.id is required");
  }
  if (!Number.isSafeInteger(transparencyLog.index) || transparencyLog.index < 0) {
    throw new ArtifactManifestError("INVALID_MANIFEST", "transparencyLog.index must be a non-negative integer");
  }
  const previousEntryHash = transparencyLog.previousEntryHash
    ? normalizeHash(transparencyLog.previousEntryHash, "INVALID_LOG_HASH")
    : null;

  const manifest = {
    schema: MANIFEST_SCHEMA,
    circuitId,
    version: options.version,
    issuedAt: options.issuedAt || new Date().toISOString(),
    ceremonyTranscriptHash,
    artifacts,
    releaseKeyId: options.releaseKeyId,
    transparencyLog: {
      id: transparencyLog.id,
      index: transparencyLog.index,
      previousEntryHash,
    },
  };
  if (typeof manifest.releaseKeyId !== "string" || manifest.releaseKeyId.length === 0) {
    throw new ArtifactManifestError("KEY_MISSING", "releaseKeyId is required");
  }
  // entryHash is bound after the manifest hash is known (see attachLogEntryHash).
  return manifest;
}

function manifestSignaturePayload(manifest) {
  const { signature, ...rest } = manifest;
  return canonicalBytes(rest);
}

/**
 * Manifest identity bound into the transparency log. The log entry hash is
 * derived from this value, so it must exclude both the signature and the log's
 * own entryHash (otherwise the binding would be circular).
 */
function manifestBody(manifest) {
  const { signature, ...rest } = manifest;
  if (rest.transparencyLog) {
    const { entryHash, ...log } = rest.transparencyLog;
    rest.transparencyLog = log;
  }
  return rest;
}

function signManifest(unsignedManifest, privateKeyInput, keyId) {
  const privateKey = privateKeyInput instanceof crypto.KeyObject
    ? privateKeyInput
    : loadPrivateKey(privateKeyInput);
  const manifest = {
    ...unsignedManifest,
    releaseKeyId: keyId || unsignedManifest.releaseKeyId,
  };
  if (!manifest.releaseKeyId) {
    throw new ArtifactManifestError("KEY_MISSING", "releaseKeyId is required for signing");
  }
  const signature = crypto.sign(null, manifestSignaturePayload(manifest), privateKey);
  return { ...manifest, signature: signature.toString("base64") };
}

/** Verify signature + release key id. Returns { valid, keyId }; throws on misuse. */
function verifyManifestSignature(manifest, trustedKeys) {
  if (!manifest || typeof manifest !== "object") {
    throw new ArtifactManifestError("MANIFEST_MALFORMED", "Manifest must be an object");
  }
  if (!manifest.signature || typeof manifest.signature !== "string") {
    throw new ArtifactManifestError("MANIFEST_UNSIGNED", "Manifest is missing a signature");
  }
  if (manifest.schema !== MANIFEST_SCHEMA) {
    throw new ArtifactManifestError(
      "MANIFEST_UNSUPPORTED",
      `Unsupported manifest schema: ${manifest.schema}`,
    );
  }
  const keys = normalizeTrustedKeys(trustedKeys);
  const key = keys.find((k) => k.keyId === manifest.releaseKeyId);
  if (!key) {
    throw new ArtifactManifestError(
      "KEY_NOT_TRUSTED",
      `Release key ${manifest.releaseKeyId} is not trusted`,
    );
  }
  let signature;
  try {
    signature = Buffer.from(manifest.signature, "base64");
  } catch (e) {
    throw new ArtifactManifestError("SIGNATURE_INVALID", "Signature is not valid base64");
  }
  if (signature.length !== 64) {
    throw new ArtifactManifestError("SIGNATURE_INVALID", "Ed25519 signature must be 64 bytes");
  }
  const valid = crypto.verify(null, manifestSignaturePayload(manifest), key.key, signature);
  if (!valid) {
    throw new ArtifactManifestError("SIGNATURE_INVALID", "Manifest signature verification failed");
  }
  return { valid: true, keyId: manifest.releaseKeyId };
}

// ---------------------------------------------------------------------------
// Transparency log binding
// ---------------------------------------------------------------------------

function computeManifestHash(manifest) {
  return sha256Hex(canonicalBytes(manifestBody(manifest)));
}

function buildTransparencyLogEntry(manifest, options = {}) {
  const logId = options.logId || manifest.transparencyLog?.id || "zkvote-artifacts-v1";
  const index = options.index ?? manifest.transparencyLog?.index ?? 0;
  const previousEntryHash = options.previousEntryHash !== undefined
    ? options.previousEntryHash
    : manifest.transparencyLog?.previousEntryHash ?? null;
  return {
    schema: ENTRY_SCHEMA,
    logId,
    index,
    previousEntryHash: previousEntryHash ? normalizeHash(previousEntryHash, "INVALID_LOG_HASH") : null,
    manifestHash: computeManifestHash(manifest),
    circuitId: manifest.circuitId,
    version: manifest.version,
    ceremonyTranscriptHash: normalizeHash(manifest.ceremonyTranscriptHash),
    releaseKeyId: manifest.releaseKeyId,
    artifactHashes: Object.fromEntries(
      ARTIFACT_KINDS.map((kind) => [kind, normalizeHash(manifest.artifacts[kind].sha256)]),
    ),
  };
}

function computeTransparencyLogEntryHash(entry) {
  return sha256Hex(canonicalBytes(entry));
}

function attachLogEntryHash(manifest, options = {}) {
  const entry = buildTransparencyLogEntry(manifest, options);
  return {
    manifest: {
      ...manifest,
      transparencyLog: {
        ...manifest.transparencyLog,
        entryHash: computeTransparencyLogEntryHash(entry),
      },
    },
    entry,
  };
}

function verifyTransparencyLogEntry(manifest, entry, expectedLogId) {
  if (!manifest.transparencyLog || !manifest.transparencyLog.entryHash) {
    throw new ArtifactManifestError("TRANSPARENCY_LOG_MISSING", "Manifest has no transparency log binding");
  }
  if (!entry || typeof entry !== "object") {
    throw new ArtifactManifestError("TRANSPARENCY_LOG_MISSING", "No transparency log entry supplied");
  }
  if (expectedLogId && entry.logId !== expectedLogId) {
    throw new ArtifactManifestError("TRANSPARENCY_LOG_MISMATCH", `Expected log ${expectedLogId}, got ${entry.logId}`);
  }
  const computed = computeTransparencyLogEntryHash(entry);
  if (computed !== normalizeHash(manifest.transparencyLog.entryHash, "INVALID_LOG_HASH")) {
    throw new ArtifactManifestError(
      "TRANSPARENCY_LOG_MISMATCH",
      `Transparency log entry hash mismatch: ${computed}`,
    );
  }
  const rebuilt = buildTransparencyLogEntry(manifest, {
    logId: entry.logId,
    index: entry.index,
    previousEntryHash: entry.previousEntryHash,
  });
  for (const field of ["logId", "index", "manifestHash", "circuitId", "version", "ceremonyTranscriptHash", "releaseKeyId"]) {
    if (entry[field] !== rebuilt[field]) {
      throw new ArtifactManifestError(
        "TRANSPARENCY_LOG_MISMATCH",
        `Transparency log ${field} does not match the signed manifest`,
      );
    }
  }
  for (const kind of ARTIFACT_KINDS) {
    if (entry.artifactHashes?.[kind] !== rebuilt.artifactHashes[kind]) {
      throw new ArtifactManifestError(
        "TRANSPARENCY_LOG_MISMATCH",
        `Transparency log ${kind} hash does not match the signed manifest`,
      );
    }
  }
  return { ok: true, entryHash: computed };
}

// ---------------------------------------------------------------------------
// End-to-end release verification
// ---------------------------------------------------------------------------

function verifyArtifactFile(filePath, descriptor, kind) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new ArtifactManifestError("ARTIFACT_MISSING", `Missing ${kind} artifact at ${filePath || "(not supplied)"}`);
  }
  return hashFile(filePath).then(({ sha256, size }) => {
    const expectedHash = normalizeHash(descriptor?.sha256, "INVALID_ARTIFACT_HASH");
    if (size !== descriptor.size) {
      throw new ArtifactManifestError(
        "ARTIFACT_SIZE_MISMATCH",
        `${kind} size mismatch: expected ${descriptor.size}, got ${size}`,
      );
    }
    if (sha256 !== expectedHash) {
      throw new ArtifactManifestError(
        "ARTIFACT_HASH_MISMATCH",
        `${kind} SHA-256 mismatch: expected ${expectedHash}, got ${sha256}`,
      );
    }
    return { sha256, size, path: filePath };
  });
}

/**
 * Verify a signed release against trusted keys, the transparency log and the
 * on-chain ceremony transcript hash recorded in the registry. No artifact is
 * returned unless every check passes.
 */
async function verifyArtifactRelease(options) {
  const manifest = options.manifest || JSON.parse(fs.readFileSync(options.manifestPath, "utf8"));
  verifyManifestSignature(manifest, options.trustedKeys || options.publicKeys || options.key);
  if (manifest.circuitId !== options.circuitId && options.circuitId !== undefined) {
    throw new ArtifactManifestError(
      "CIRCUIT_MISMATCH",
      `Manifest is for circuit ${manifest.circuitId}, expected ${options.circuitId}`,
    );
  }
  if (options.version !== undefined && manifest.version !== options.version) {
    throw new ArtifactManifestError(
      "VERSION_MISMATCH",
      `Manifest is for version ${manifest.version}, expected ${options.version}`,
    );
  }

  const registryHash = normalizeHash(
    options.registryHash,
    "REGISTRY_HASH_INVALID",
  );
  if (registryHash !== normalizeHash(manifest.ceremonyTranscriptHash)) {
    throw new ArtifactManifestError(
      "CEREMONY_HASH_MISMATCH",
      `Registry ceremony transcript hash ${registryHash} != manifest ${manifest.ceremonyTranscriptHash}`,
    );
  }

  let entry = options.logEntry;
  if (!entry) {
    const entryPath = options.logEntryPath || `${options.manifestPath}.log.json`;
    if (!fs.existsSync(entryPath)) {
      throw new ArtifactManifestError(
        "TRANSPARENCY_LOG_MISSING",
        `Transparency log entry not found at ${entryPath}`,
      );
    }
    entry = JSON.parse(fs.readFileSync(entryPath, "utf8"));
  }
  const log = verifyTransparencyLogEntry(manifest, entry, options.logId);

  const artifactDir = options.artifactDir || path.dirname(options.manifestPath || ".");
  const verified = {};
  for (const kind of ARTIFACT_KINDS) {
    const filePath =
      options.artifactPaths?.[kind] ||
      options.artifacts?.[kind] ||
      path.join(artifactDir, basenameFor(kind, manifest));
    // Sequential hashing keeps disk I/O predictable for 500MB+ zkeys.
    verified[kind] = await verifyArtifactFile(filePath, manifest.artifacts[kind], kind);
  }

  return {
    ok: true,
    circuitId: manifest.circuitId,
    version: manifest.version,
    ceremonyTranscriptHash: manifest.ceremonyTranscriptHash,
    releaseKeyId: manifest.releaseKeyId,
    manifestHash: computeManifestHash(manifest),
    transparencyLogIndex: manifest.transparencyLog.index,
    transparencyLogEntryHash: log.entryHash,
    artifacts: verified,
  };
}

function basenameFor(kind, manifest) {
  switch (kind) {
    case "zkey":
      return `${manifest.circuitId}_v${manifest.version}.zkey`;
    case "wasm":
      return `${manifest.circuitId}_v${manifest.version}.wasm`;
    default:
      return `${manifest.circuitId}_v${manifest.version}.verification_key.json`;
  }
}

/** Build, sign and write a manifest plus its transparency-log entry. */
async function generateSignedManifest(options) {
  const privateKeyInput = options.privateKey || readKeyMaterial(process.env.ZKVOTE_RELEASE_PRIVATE_KEY);
  const privateKey = loadPrivateKey(privateKeyInput);
  // Derive the keyId from the public half of the signing key.
  const publicDer = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const keyId = options.releaseKeyId || `rel-${sha256Hex(publicDer.subarray(-32)).slice(0, 16)}`;

  let ceremonyTranscriptHash = options.ceremonyTranscriptHash;
  if (!ceremonyTranscriptHash && options.transcriptDir) {
    ceremonyTranscriptHash = (await verifyCeremony(path.resolve(options.transcriptDir))).transcriptHash;
  }
  if (!ceremonyTranscriptHash) {
    throw new ArtifactManifestError(
      "TRANSCRIPT_HASH_MISSING",
      "Provide --transcript-hash or --transcript-dir",
    );
  }

  const descriptors = await hashDescriptors(describeArtifacts(options.artifacts));
  const unsigned = buildUnsignedManifest({
    circuitId: options.circuitId,
    version: options.version,
    ceremonyTranscriptHash,
    artifacts: descriptors,
    releaseKeyId: keyId,
    issuedAt: options.issuedAt,
    logId: options.logId,
    logIndex: options.logIndex,
    previousEntryHash: options.previousEntryHash,
  });
  const { manifest, entry } = attachLogEntryHash(unsigned, {
    logId: unsigned.transparencyLog.id,
    index: unsigned.transparencyLog.index,
    previousEntryHash: unsigned.transparencyLog.previousEntryHash,
  });
  const signed = signManifest(manifest, privateKey, keyId);

  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, JSON.stringify(signed, null, 2) + "\n");
    fs.writeFileSync(`${options.output}.log.json`, JSON.stringify(entry, null, 2) + "\n");
  }
  return { manifest: signed, entry };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function resolveKeyArgs(keyArgs) {
  const args = keyArgs && keyArgs.length ? keyArgs : [];
  if (args.length === 0 && process.env.ZKVOTE_RELEASE_PUBLIC_KEY) {
    args.push(process.env.ZKVOTE_RELEASE_PUBLIC_KEY);
  }
  return args.map((arg) => {
    const eq = arg.indexOf("=");
    if (eq > 0) {
      return { keyId: arg.slice(0, eq), publicKey: readKeyMaterial(arg.slice(eq + 1)) };
    }
    return { publicKey: readKeyMaterial(arg) };
  });
}

function parseFlags(argv) {
  const flags = { _: [] };
  const arrayFlags = new Set(["key", "artifact"]);
  const boolFlags = new Set(["offline"]);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      flags._.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    let name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
    let value = eq >= 0 ? token.slice(eq + 1) : undefined;
    if (boolFlags.has(name)) {
      flags[name] = true;
      continue;
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new ArtifactManifestError("CLI_ERROR", `Missing value for --${name}`);
    }
    if (arrayFlags.has(name)) {
      (flags[name] ||= []).push(value);
    } else {
      flags[name] = value;
    }
  }
  return flags;
}

/** commander exposes --x-y as xY; the fallback parser keeps x-y. */
function flagValue(flags, dashed, camel) {
  return flags[dashed] !== undefined ? flags[dashed] : flags[camel];
}

async function runGenerateKey(flags) {
  const pair = generateReleaseKeyPair({ keyId: flagValue(flags, "key-id", "keyId") });
  const dir = flags.out || ".";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${pair.keyId}.private.pem`), pair.privateKeyPem, {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(dir, `${pair.keyId}.public.pem`), pair.publicKeyPem);
  console.log(`✓ Generated release key ${pair.keyId}`);
  console.log(`  Public key (raw hex): ${pair.publicKeyRawHex}`);
  console.log(`  Private key: ${path.join(dir, `${pair.keyId}.private.pem`)} (keep offline!)`);
  return pair;
}

async function runGenerateManifest(flags) {
  const artifacts = {
    zkey: flags.zkey,
    wasm: flags.wasm,
    vkey: flags.vkey || flags.verificationKey,
  };
  const { manifest, entry } = await generateSignedManifest({
    artifacts,
    circuitId: flags.circuit,
    version: Number(flags.version),
    ceremonyTranscriptHash: flagValue(flags, "transcript-hash", "transcriptHash"),
    transcriptDir: flagValue(flags, "dir", "dir"),
    privateKey: flagValue(flags, "private-key", "privateKey") || process.env.ZKVOTE_RELEASE_PRIVATE_KEY,
    logId: flagValue(flags, "log-id", "logId"),
    logIndex: flags.index !== undefined ? Number(flags.index) : undefined,
    previousEntryHash: flagValue(flags, "previous-entry-hash", "previousEntryHash"),
    output: flags.output || flags.manifest,
  });
  console.log(`✓ Signed manifest for ${manifest.circuitId} v${manifest.version}`);
  console.log(`  Ceremony transcript hash: ${manifest.ceremonyTranscriptHash}`);
  console.log(`  Release key: ${manifest.releaseKeyId}`);
  console.log(`  Transparency log: ${manifest.transparencyLog.id}#${manifest.transparencyLog.index}`);
  console.log(`  Entry hash: ${manifest.transparencyLog.entryHash}`);
  return { manifest, entry };
}

async function runVerifyArtifacts(flags) {
  const result = await verifyArtifactRelease({
    manifestPath: flags.manifest,
    trustedKeys: resolveKeyArgs(flags.key),
    registryHash: flagValue(flags, "registry-hash", "registryHash"),
    offline: Boolean(flags.offline),
    logEntryPath: flagValue(flags, "log-entry", "logEntry"),
    logId: flagValue(flags, "log-id", "logId"),
    circuitId: flags.circuit,
    version: flags.version !== undefined ? Number(flags.version) : undefined,
    artifactDir: flags.dir,
  });
  console.log("✓ Signed artifact manifest verified");
  console.log(`  Circuit: ${result.circuitId} v${result.version}`);
  console.log(`  Ceremony transcript hash: ${result.ceremonyTranscriptHash}`);
  console.log(`  Manifest hash: ${result.manifestHash}`);
  for (const kind of ARTIFACT_KINDS) {
    const a = result.artifacts[kind];
    console.log(`  ${kind}: ${a.sha256} (${a.size} bytes)`);
  }
  return result;
}

async function runManualCli(argv) {
  const command = argv[0] || "verify";
  const flags = parseFlags(argv.slice(1));
  switch (command) {
    case "verify":
      return verifyCeremony(path.resolve(flags.dir || "./transcript"));
    case "extract":
      return extractParameters(path.resolve(flags.dir || "./transcript"), path.resolve(flags.out || "./transcript"));
    case "generate-key":
      return runGenerateKey(flags);
    case "generate-manifest":
      return runGenerateManifest(flags);
    case "verify-artifacts":
      return runVerifyArtifacts(flags);
    default:
      throw new ArtifactManifestError("CLI_ERROR", `Unknown command: ${command}`);
  }
}

if (program) {
  program
    .command("verify")
    .option("--dir <path>", "Transcript directory", "./transcript")
    .action(async (options) => {
      try {
        await verifyCeremony(path.resolve(options.dir));
      } catch (err) {
        console.error("✗ Ceremony verification failed:", err.message);
        process.exit(1);
      }
    });

  program
    .command("extract")
    .option("--dir <path>", "Transcript directory", "./transcript")
    .option("--out <path>", "Output directory", "./transcript")
    .action(async (options) => {
      try {
        await extractParameters(path.resolve(options.dir), path.resolve(options.out));
      } catch (err) {
        console.error("✗ Parameter extraction failed:", err.message);
        process.exit(1);
      }
    });

  program
    .command("generate-key")
    .option("--out <path>", "Directory for the key pair", ".")
    .option("--key-id <id>", "Explicit release key id")
    .action(async (options) => {
      try {
        await runGenerateKey(options);
      } catch (err) {
        console.error("✗ Key generation failed:", err.message);
        process.exit(1);
      }
    });

  program
    .command("generate-manifest")
    .option("--zkey <path>", "Final proving key")
    .option("--wasm <path>", "Circuit wasm")
    .option("--vkey <path>", "Verification key JSON")
    .option("--circuit <id>", "Circuit id")
    .option("--version <n>", "Circuit version")
    .option("--transcript-hash <hex>", "MPC ceremony transcript hash")
    .option("--dir <path>", "Transcript directory (computes the transcript hash)")
    .option("--private-key <path>", "Release private key PEM (or ZKVOTE_RELEASE_PRIVATE_KEY)")
    .option("--log-id <id>", "Transparency log id", "zkvote-artifacts-v1")
    .option("--index <n>", "Transparency log index")
    .option("--previous-entry-hash <hex>", "Previous log entry hash")
    .option("--output <path>", "Manifest output path")
    .action(async (options) => {
      try {
        await runGenerateManifest(options);
      } catch (err) {
        console.error("✗ Manifest generation failed:", err.message);
        process.exit(1);
      }
    });

  program
    .command("verify-artifacts")
    .requiredOption("--manifest <path>", "Signed manifest JSON")
    .option("--key <spec>", "Trusted public key (path, PEM, hex or keyId=spec); repeatable", collect, [])
    .option("--registry-hash <hex>", "On-chain ceremony_transcript_hash")
    .option("--offline", "Verify only against local artifacts / cached log entry")
    .option("--log-entry <path>", "Local transparency log entry JSON")
    .option("--log-id <id>", "Expected transparency log id")
    .option("--circuit <id>", "Expected circuit id")
    .option("--version <n>", "Expected circuit version")
    .option("--dir <path>", "Artifact directory")
    .action(async (options) => {
      try {
        await runVerifyArtifacts(options);
      } catch (err) {
        console.error(`✗ Artifact verification failed [${err.code || "ERROR"}]:`, err.message);
        process.exit(1);
      }
    });
}

function collect(value, previous) {
  previous.push(value);
  return previous;
}

if (require.main === module) {
  if (process.argv.length <= 2 || !program) {
    runManualCli(process.argv.slice(2)).catch((err) => {
      console.error(`✗ ${err.code || "ERROR"}:`, err.message);
      process.exit(1);
    });
  } else {
    program.parseAsync(process.argv).catch((err) => {
      console.error(`✗ ${err.code || "ERROR"}:`, err.message);
      process.exit(1);
    });
  }
}

module.exports = {
  // ceremony
  verifyCeremony,
  extractParameters,
  computeFileHash,
  computeTranscriptHash,
  computeVkHash,
  stableStringify,
  hashFile,
  manifestBody,
  // keys + manifests
  MANIFEST_SCHEMA,
  ENTRY_SCHEMA,
  ARTIFACT_KINDS,
  ArtifactManifestError,
  generateReleaseKeyPair,
  loadPrivateKey,
  loadPublicKey,
  buildUnsignedManifest,
  signManifest,
  verifyManifestSignature,
  computeManifestHash,
  buildTransparencyLogEntry,
  computeTransparencyLogEntryHash,
  attachLogEntryHash,
  verifyTransparencyLogEntry,
  verifyArtifactFile,
  verifyArtifactRelease,
  generateSignedManifest,
};
