import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, sign, createHash, webcrypto } from "node:crypto";
import {
  ARTIFACT_KINDS,
  ArtifactVerificationError,
  InMemoryArtifactCache,
  Sha256Stream,
  buildTransparencyLogEntry,
  canonicalJson,
  computeTransparencyLogEntryHash,
  loadVerifiedArtifacts,
  manifestSignatureBytes,
  verifyTransparencyLogEntry,
  type ArtifactKind,
  type SignedArtifactManifest,
  type TransparencyLogEntry,
  type TrustedReleaseKey,
} from "./zkproof.vkcache";

// Node's WebCrypto, injected explicitly so the tests do not depend on jsdom.
const subtle = (globalThis.crypto?.subtle ?? webcrypto.subtle) as SubtleCrypto;

const CEREMONY_HASH = "a1".repeat(32);

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactBytes(kind: ArtifactKind, size = 4096): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (kind.charCodeAt(0) + i) & 0xff;
  return out;
}

interface Fixture {
  manifest: SignedArtifactManifest;
  entry: TransparencyLogEntry;
  keys: TrustedReleaseKey[];
  artifacts: Record<ArtifactKind, Uint8Array>;
  urls: Record<ArtifactKind, string>;
}

function makeFixture(issuedAt = new Date().toISOString()): Fixture {
  const artifacts: Record<ArtifactKind, Uint8Array> = {
    zkey: artifactBytes("zkey", 70000), // crosses many 64-byte SHA-256 blocks
    wasm: artifactBytes("wasm", 130),
    vkey: new TextEncoder().encode(
      JSON.stringify({ alpha: ["1", "2"], beta: ["3", "4"], gamma: ["5", "6"], delta: ["7", "8"], ic: [] }),
    ),
  };
  const fingerprints = Object.fromEntries(
    ARTIFACT_KINDS.map((kind) => [
      kind,
      { sha256: sha256Hex(artifacts[kind]), size: artifacts[kind].byteLength },
    ]),
  ) as SignedArtifactManifest["artifacts"];

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublic = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const keyId = "test-release-key";
  const trusted: TrustedReleaseKey = {
    keyId,
    publicKey: Array.from(rawPublic)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  };

  const unsigned = {
    schema: "zkvote.artifact-manifest/v1",
    circuitId: "vote_v2",
    version: 2,
    issuedAt,
    ceremonyTranscriptHash: CEREMONY_HASH,
    artifacts: fingerprints,
    releaseKeyId: keyId,
    transparencyLog: {
      id: "zkvote-artifacts-v1",
      index: 7,
      previousEntryHash: null,
      entryHash: "0".repeat(64), // replaced below; excluded from manifestHash
    },
    signature: "",
  } as SignedArtifactManifest;

  const entry = buildTransparencyLogEntry(unsigned);
  unsigned.transparencyLog.entryHash = computeTransparencyLogEntryHash(entry);
  unsigned.signature = sign(null, manifestSignatureBytes(unsigned), privateKey).toString("base64");

  const urls = Object.fromEntries(
    ARTIFACT_KINDS.map((kind) => [kind, `https://cdn.test/${kind}`]),
  ) as Record<ArtifactKind, string>;
  return { manifest: unsigned, entry, keys: [trusted], artifacts, urls };
}

/** Chunked body: an async iterable (as produced by fetch Response streams). */
function chunkedBody(bytes: Uint8Array, sizes: number[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      let offset = 0;
      let i = 0;
      while (offset < bytes.byteLength) {
        const end = Math.min(bytes.byteLength, offset + sizes[i++ % sizes.length]);
        yield bytes.slice(offset, end);
        offset = end;
      }
    },
  };
}

function responseFor(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    body,
    headers: { get: () => null },
  } as unknown as Response;
}

function baseOptions(f: Fixture, overrides: Partial<Parameters<typeof loadVerifiedArtifacts>[0]> = {}) {
  const fetchFn = vi.fn(async (url: string) => {
    const kind = ARTIFACT_KINDS.find((k) => f.urls[k] === url);
    if (kind) {
      return responseFor(chunkedBody(f.artifacts[kind], [7, 13, 64, 101]));
    }
    return responseFor(f.manifest);
  }) as unknown as typeof fetch;

  return {
    circuitId: f.manifest.circuitId,
    version: f.manifest.version,
    manifest: f.manifest,
    manifestUrl: "https://cdn.test/manifest.json",
    artifactUrls: f.urls,
    registryReader: () => CEREMONY_HASH.toUpperCase(),
    trustedKeys: f.keys,
    subtle,
    cache: new InMemoryArtifactCache(),
    fetchFn,
    ...overrides,
  };
}

describe("verified VK/artifact cache", () => {
  it("incremental SHA-256 matches one-shot hashing across arbitrary chunk sizes", () => {
    const bytes = artifactBytes("z", 20000);
    for (const chunkSize of [1, 7, 31, 64, 65, 4096, 20000]) {
      const stream = new Sha256Stream();
      for (let i = 0; i < bytes.byteLength; i += chunkSize) {
        stream.update(bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength)));
      }
      expect(stream.hex()).toBe(sha256Hex(bytes));
      expect(stream.size).toBe(bytes.byteLength);
    }
    expect(canonicalJson({ b: 1, a: { z: [2], y: "x" } })).toBe('{"a":{"y":"x","z":[2]},"b":1}');
  });

  it("accepts a valid chunked download and verifies the transparency binding", async () => {
    const f = makeFixture();
    const result = await loadVerifiedArtifacts(baseOptions(f));
    expect(result.circuitId).toBe("vote_v2");
    expect(result.ceremonyTranscriptHash).toBe(CEREMONY_HASH);
    expect(result.artifacts.zkey).toEqual(f.artifacts.zkey);
    expect(result.artifacts.verificationKey).toHaveProperty("alpha");
    expect(result.transparencyLogEntryHash).toBe(f.manifest.transparencyLog.entryHash);
    expect(result.fromCache).toEqual({ zkey: false, wasm: false, vkey: false });
    expect(verifyTransparencyLogEntry(f.manifest, f.entry)).toBe(
      f.manifest.transparencyLog.entryHash,
    );
  });

  it("rejects a same-size tampered artifact before returning bytes", async () => {
    const f = makeFixture();
    const tampered = new Uint8Array(f.artifacts.zkey);
    tampered[123] ^= 0xff;
    const options = baseOptions(f, {
      fetchFn: vi.fn(async (url: string) => {
        const body =
          url === f.urls.zkey
            ? chunkedBody(tampered, [7, 13, 64])
            : url === f.urls.wasm
              ? chunkedBody(f.artifacts.wasm, [13])
              : url === f.urls.vkey
                ? chunkedBody(f.artifacts.vkey, [64])
                : responseFor(f.manifest);
        return responseFor(body);
      }) as unknown as typeof fetch,
    });
    await expect(loadVerifiedArtifacts(options)).rejects.toMatchObject({
      code: "ARTIFACT_HASH_MISMATCH",
      name: "ArtifactVerificationError",
    });
  });

  it("rejects an unsigned or badly signed manifest", async () => {
    const f = makeFixture();
    const { signature, ...unsigned } = f.manifest;
    await expect(
      loadVerifiedArtifacts(baseOptions(f, { manifest: unsigned as SignedArtifactManifest })),
    ).rejects.toMatchObject({ code: "MANIFEST_UNSIGNED" });

    const badBytes = Buffer.from(f.manifest.signature, "base64");
    badBytes[0] ^= 0x01;
    await expect(
      loadVerifiedArtifacts(
        baseOptions(f, {
          manifest: { ...f.manifest, signature: badBytes.toString("base64") },
        }),
      ),
    ).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
  });

  it("rejects a registry ceremony hash mismatch", async () => {
    const f = makeFixture();
    await expect(
      loadVerifiedArtifacts(baseOptions(f, { registryReader: () => "b2".repeat(32) })),
    ).rejects.toMatchObject({ code: "CEREMONY_HASH_MISMATCH" });
    await expect(
      loadVerifiedArtifacts(baseOptions(f, { registryReader: undefined })),
    ).rejects.toMatchObject({ code: "REGISTRY_UNAVAILABLE" });
  });

  it("fails closed on a tampered transparency-log entry", async () => {
    const f = makeFixture();
    expect(() =>
      verifyTransparencyLogEntry(f.manifest, { ...f.entry, version: 99 }),
    ).toThrow(ArtifactVerificationError);
    expect(() =>
      verifyTransparencyLogEntry(
        { ...f.manifest, transparencyLog: { ...f.manifest.transparencyLog, entryHash: "c3".repeat(32) } },
        f.entry,
      ),
    ).toThrow(ArtifactVerificationError);
  });

  it("supports offline cached copies with the same verification, and evicts tampered caches", async () => {
    const f = makeFixture();
    const cache = new InMemoryArtifactCache();
    const first = await loadVerifiedArtifacts(baseOptions(f, { cache }));
    expect(first.artifacts.zkey).toEqual(f.artifacts.zkey);

    const offlineOptions = baseOptions(f, {
      cache,
      offline: true,
      fetchFn: vi.fn(() => {
        throw new Error("offline mode must not fetch");
      }) as unknown as typeof fetch,
    });
    const offline = await loadVerifiedArtifacts(offlineOptions);
    expect(offline.artifacts.zkey).toEqual(f.artifacts.zkey);
    expect(offline.fromCache).toEqual({ zkey: true, wasm: true, vkey: true });

    const cacheKey = `zkvote-vkcache/v1/${f.manifest.circuitId}/${f.manifest.version}/zkey`;
    const poisoned = new Uint8Array(f.artifacts.zkey);
    poisoned[5] ^= 0xff;
    await cache.set(cacheKey, poisoned);
    await expect(loadVerifiedArtifacts(offlineOptions)).rejects.toMatchObject({
      code: "ARTIFACT_HASH_MISMATCH",
    });
    expect(await cache.get(cacheKey)).toBeNull();
  });

  it("enforces release-key rotation and revocation policy", async () => {
    const past = makeFixture("2020-01-01T00:00:00.000Z");
    await expect(
      loadVerifiedArtifacts(
        baseOptions(past, {
          trustedKeys: [{ ...past.keys[0], status: "retired", retiredAt: "2021-01-01T00:00:00.000Z" }],
          now: () => Date.parse("2026-01-01T00:00:00.000Z"),
        }),
      ),
    ).resolves.toMatchObject({ circuitId: "vote_v2" });

    const rotated = makeFixture("2026-01-01T00:00:00.000Z");
    await expect(
      loadVerifiedArtifacts(
        baseOptions(rotated, {
          trustedKeys: [{ ...rotated.keys[0], status: "retired", retiredAt: "2025-01-01T00:00:00.000Z" }],
          now: () => Date.parse("2026-06-01T00:00:00.000Z"),
        }),
      ),
    ).rejects.toMatchObject({ code: "KEY_RETIRED" });

    await expect(
      loadVerifiedArtifacts(
        baseOptions(rotated, {
          trustedKeys: [{ ...rotated.keys[0], status: "revoked" }],
        }),
      ),
    ).rejects.toMatchObject({ code: "KEY_REVOKED" });
  });
});
