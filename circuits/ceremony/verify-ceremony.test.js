#!/usr/bin/env node
/**
 * Focused tests for the signed artifact manifest pipeline.
 * Run with: node --test circuits/ceremony/verify-ceremony.test.js
 * Uses only Node built-ins; snarkjs is intentionally not required.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const tool = require("./verify-ceremony.js");

const TRANSCRIPT_HASH = "a1".repeat(32);

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zkvote-manifest-"));
  const artifacts = {};
  // Large enough to cross several fs.ReadStream chunk boundaries.
  for (const kind of tool.ARTIFACT_KINDS) {
    const filePath = path.join(dir, `${kind}.bin`);
    fs.writeFileSync(filePath, Buffer.alloc(200 * 1024, kind.charCodeAt(0)));
    artifacts[kind] = filePath;
  }
  const keys = tool.generateReleaseKeyPair();
  return { dir, artifacts, keys, trusted: [{ keyId: keys.keyId, publicKey: keys.publicKeyPem }] };
}

async function release(f, overrides = {}) {
  return tool.generateSignedManifest({
    artifacts: f.artifacts,
    circuitId: "vote_v2",
    version: 2,
    ceremonyTranscriptHash: TRANSCRIPT_HASH,
    privateKey: f.keys.privateKeyPem,
    output: path.join(f.dir, "manifest.json"),
    ...overrides,
  });
}

function verifyOptions(f, manifest, extra = {}) {
  return {
    manifest,
    trustedKeys: f.trusted,
    registryHash: TRANSCRIPT_HASH.toUpperCase(),
    logEntryPath: path.join(f.dir, "manifest.json.log.json"),
    artifactDir: f.dir,
    artifactPaths: f.artifacts,
    ...extra,
  };
}

test("signature covers manifest; unsigned and altered manifests are rejected", async () => {
  const f = fixture();
  const { manifest } = await release(f);

  assert.deepEqual(tool.verifyManifestSignature(manifest, f.trusted), {
    valid: true,
    keyId: f.keys.keyId,
  });

  const { signature, ...unsigned } = manifest;
  assert.throws(
    () => tool.verifyManifestSignature(unsigned, f.trusted),
    (e) => e.code === "MANIFEST_UNSIGNED",
  );
  assert.throws(
    () => tool.verifyManifestSignature({ ...manifest, version: 3 }, f.trusted),
    (e) => e.code === "SIGNATURE_INVALID",
  );
  assert.throws(
    () => tool.verifyManifestSignature(manifest, [{ keyId: "other", publicKey: f.keys.publicKeyPem }]),
    (e) => e.code === "KEY_NOT_TRUSTED",
  );
});

test("streaming verification accepts a valid multi-chunk artifact", async () => {
  const f = fixture();
  const { manifest } = await release(f);
  const result = await tool.verifyArtifactRelease(verifyOptions(f, manifest));
  assert.equal(result.ok, true);
  assert.equal(result.circuitId, "vote_v2");
  assert.equal(result.ceremonyTranscriptHash, TRANSCRIPT_HASH);
  for (const kind of tool.ARTIFACT_KINDS) {
    assert.equal(result.artifacts[kind].size, 200 * 1024);
  }
});

test("a same-size tampered artifact is rejected before return", async () => {
  const f = fixture();
  const { manifest } = await release(f);
  const bytes = fs.readFileSync(f.artifacts.zkey);
  bytes[12345] ^= 0xff; // same length: defeats naive size checks
  fs.writeFileSync(f.artifacts.zkey, bytes);

  await assert.rejects(
    tool.verifyArtifactRelease(verifyOptions(f, manifest)),
    (e) => e.code === "ARTIFACT_HASH_MISMATCH",
  );
});

test("registry ceremony hash mismatch is rejected", async () => {
  const f = fixture();
  const { manifest } = await release(f);
  await assert.rejects(
    tool.verifyArtifactRelease(verifyOptions(f, manifest, { registryHash: "b2".repeat(32) })),
    (e) => e.code === "CEREMONY_HASH_MISMATCH",
  );
});

test("transparency log entry binding detects an altered entry", async () => {
  const f = fixture();
  const { manifest, entry } = await release(f);
  assert.equal(tool.verifyTransparencyLogEntry(manifest, entry).ok, true);

  const altered = { ...entry, index: entry.index + 1 };
  assert.throws(
    () => tool.verifyTransparencyLogEntry(manifest, altered),
    (e) => e.code === "TRANSPARENCY_LOG_MISMATCH",
  );

  // A log entry for a different manifest must not satisfy this manifest.
  const { entry: other } = await release(f, { version: 3 });
  assert.throws(
    () => tool.verifyTransparencyLogEntry(manifest, other),
    (e) => e.code === "TRANSPARENCY_LOG_MISMATCH",
  );
});

test("canonical JSON is stable and matches WebCrypto-facing byte order", () => {
  const value = { b: 1, a: { z: [2, 1], y: "x" } };
  assert.equal(
    tool.stableStringify(value),
    '{"a":{"y":"x","z":[2,1]},"b":1}',
  );
  const digest = crypto.createHash("sha256").update(tool.stableStringify(value)).digest("hex");
  assert.equal(digest, crypto.createHash("sha256").update('{"a":{"y":"x","z":[2,1]},"b":1}').digest("hex"));
});
