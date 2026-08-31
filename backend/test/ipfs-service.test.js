import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.RELAYER_TEST_MODE = "true";

const ipfs = await import("../src/services/ipfs.js");

const cidV0 = `Qm${"1".repeat(44)}`;
const cidV1 =
  "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

test("IPFS operations reject use before client initialization", async () => {
  await assert.rejects(
    ipfs.pinJSON({ version: 1, body: "test" }),
    /Pinata client not initialized/,
  );

  await assert.rejects(
    ipfs.pinFile(
      Buffer.from("image"),
      "test.png",
      "image/png",
    ),
    /Pinata client not initialized/,
  );

  assert.equal(await ipfs.isHealthy(), false);
});

test("sanitizeString removes executable HTML content", () => {
  const unsafe = [
    '<script>alert("x")</script>',
    '<img src="x" onclick="run()" onerror=fail()>',
    '<a href="javascript:alert(1)">link</a>',
    '<iframe src="data:text/html;base64,abc"></iframe>',
    "data:text/html in plain text",
  ].join("");

  const sanitized = ipfs.sanitizeString(unsafe);

  assert.doesNotMatch(sanitized, /<script/i);
  assert.doesNotMatch(sanitized, /onclick/i);
  assert.doesNotMatch(sanitized, /onerror/i);
  assert.doesNotMatch(sanitized, /javascript:/i);
  assert.doesNotMatch(sanitized, /data:\s*text\/html/i);
  // Active-markup containers (iframe & friends) are removed whole,
  // attributes included; scriptable data: URLs left in text are blocked.
  assert.doesNotMatch(sanitized, /<iframe/i);
  assert.match(sanitized, /data:blocked/i);
});

test("sanitizeMetadata recursively sanitizes keys and values", () => {
  const result = ipfs.sanitizeMetadata({
    '<script>bad</script>title': '<script>x</script>Hello',
    nested: [
      {
        body: '<img onclick="run()" src="javascript:test">',
      },
      "data:text/html payload",
    ],
    count: 2,
    enabled: true,
  });

  const serialized = JSON.stringify(result);

  assert.doesNotMatch(serialized, /<script/i);
  assert.doesNotMatch(serialized, /onclick/i);
  assert.doesNotMatch(serialized, /javascript:/i);
  assert.match(serialized, /data:blocked/i);
  assert.equal(result.count, 2);
  assert.equal(result.enabled, true);
});

test("proposal metadata schema covers all validation outcomes", () => {
  let result = ipfs.validateMetadataSchema(
    null,
    ipfs.PROPOSAL_METADATA_SCHEMA,
  );

  assert.deepEqual(result, {
    valid: false,
    error: "Metadata must be an object",
  });

  result = ipfs.validateMetadataSchema(
    { version: 1 },
    ipfs.PROPOSAL_METADATA_SCHEMA,
  );
  assert.equal(result.valid, false);
  assert.match(result.error, /Missing required field: body/);

  result = ipfs.validateMetadataSchema(
    { version: 2, body: "text" },
    ipfs.PROPOSAL_METADATA_SCHEMA,
  );
  assert.equal(result.valid, false);
  assert.match(result.error, /Invalid version/);

  result = ipfs.validateMetadataSchema(
    { version: 1, body: 123 },
    ipfs.PROPOSAL_METADATA_SCHEMA,
  );
  assert.equal(result.valid, false);
  assert.match(result.error, /Body must be a string/);

  result = ipfs.validateMetadataSchema(
    {
      version: 1,
      body: "x".repeat(
        ipfs.PROPOSAL_METADATA_SCHEMA.maxBodyLength + 1,
      ),
    },
    ipfs.PROPOSAL_METADATA_SCHEMA,
  );
  assert.equal(result.valid, false);
  assert.match(result.error, /maximum length/);

  result = ipfs.validateMetadataSchema(
    {
      version: 1,
      body: "valid",
      createdAt: "not-a-date",
    },
    ipfs.PROPOSAL_METADATA_SCHEMA,
  );
  assert.equal(result.valid, false);
  assert.match(result.error, /Invalid createdAt/);

  result = ipfs.validateMetadataSchema(
    {
      version: 1,
      body: "valid",
      createdAt: new Date().toISOString(),
    },
    ipfs.PROPOSAL_METADATA_SCHEMA,
  );
  assert.deepEqual(result, { valid: true });
});

test("comment metadata schema requires its additional fields", () => {
  let result = ipfs.validateMetadataSchema(
    {
      version: 1,
      body: "comment",
    },
    ipfs.COMMENT_METADATA_SCHEMA,
  );

  assert.equal(result.valid, false);
  assert.match(result.error, /createdAt/);

  result = ipfs.validateMetadataSchema(
    {
      version: 1,
      body: "comment",
      createdAt: new Date().toISOString(),
    },
    ipfs.COMMENT_METADATA_SCHEMA,
  );

  assert.deepEqual(result, { valid: true });
});

test("CID validation accepts supported formats and rejects invalid lengths", () => {
  assert.equal(ipfs.isValidCid(cidV0), true);
  assert.equal(ipfs.isValidCid(cidV1), true);

  assert.equal(ipfs.isValidCid(""), false);
  assert.equal(ipfs.isValidCid("not-a-cid"), false);
  assert.equal(ipfs.isValidCid("Qm123"), false);
  assert.equal(ipfs.isValidCid("bafy123"), false);
});

test("fetch operations reject use before client initialization", async () => {
  await assert.rejects(
    ipfs.fetchContent("invalid-cid"),
    /Pinata client not initialized/,
  );

  await assert.rejects(
    ipfs.fetchRawContent("invalid-cid"),
    /Pinata client not initialized/,
  );
});

test("public URLs include the requested CID", () => {
  const urls = ipfs.getPublicUrls(cidV1);

  assert.equal(typeof urls.primary, "string");
  assert.match(urls.primary, new RegExp(cidV1));
  assert.ok(Array.isArray(urls.fallbacks));
  assert.ok(urls.fallbacks.length > 0);

  for (const url of urls.fallbacks) {
    assert.match(url, new RegExp(cidV1));
  }
});

test("initialization requires a JWT", () => {
  assert.throws(
    () => ipfs.initPinata(""),
    /PINATA_JWT is required/,
  );
});

// Issue #379: primary Pinata gateway failure should fail over to the public
// gateway chain instead of surfacing an error immediately. These two tests
// initialize Pinata (with a fake JWT — init only sets local state, no
// network call) and mock global fetch, so they run last: nothing after them
// depends on the module's pre-initialization "not initialized" behavior.

test("fetchContent falls back to a public gateway when the primary fails", async () => {
  ipfs.initPinata("fake-jwt-for-test");

  // Build a CIDv1 for the content we'll serve, so verifyCidContent passes.
  const fallbackContent = Buffer.from(JSON.stringify({ hello: "world" }));
  const fallbackCid = makeCIDv1(fallbackContent);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("gateway.pinata.cloud")) {
      throw new Error("primary gateway unreachable");
    }
    if (href.startsWith("https://ipfs.io/ipfs/")) {
      return {
        ok: true,
        headers: { get: () => "application/json" },
        arrayBuffer: async () => bufToArrayBuffer(fallbackContent),
      };
    }
    throw new Error(`unexpected fetch to ${href}`);
  };

  try {
    const result = await ipfs.fetchContent(fallbackCid);
    assert.deepEqual(result.data, { hello: "world" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchRawContent throws the original error when every gateway fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("gateway unreachable");
  };

  try {
    await assert.rejects(
      ipfs.fetchRawContent(cidV1),
      /gateway unreachable/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================
// Issue #344: CID content integrity
// ============================================

/**
 * Build a valid CIDv1 (base32lower, sha2-256, raw codec 0x55) for `content`.
 * Returns the CID string with "b" multibase prefix.
 */
function makeCIDv1(content) {
  const digest = crypto.createHash("sha256").update(content).digest();
  // CIDv1 bytes: [version=0x01][codec=0x55 raw][hashfn=0x12][len=0x20][32-byte digest]
  const cidBytes = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, value = 0, b32 = "";
  for (const byte of cidBytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { b32 += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) b32 += alphabet[(value << (5 - bits)) & 31];
  return "b" + b32;
}

/**
 * Build a valid CIDv0 (base58btc, sha2-256 multihash) for `content`.
 * Returns the CID string starting with "Qm".
 */
function makeCIDv0(content) {
  const digest = crypto.createHash("sha256").update(content).digest();
  const multihash = Buffer.concat([Buffer.from([0x12, 0x20]), digest]);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = BigInt("0x" + multihash.toString("hex"));
  let encoded = "";
  while (num > 0n) {
    const rem = num % 58n;
    num = num / 58n;
    encoded = alphabet[Number(rem)] + encoded;
  }
  for (let i = 0; i < multihash.length && multihash[i] === 0; i++) {
    encoded = "1" + encoded;
  }
  return encoded;
}

/**
 * Build a minimal ArrayBuffer-like view for a Buffer so it can be used as
 * a mock arrayBuffer() response.  We copy the bytes into a fresh
 * ArrayBuffer to avoid offset/length issues from Buffer's backing store.
 */
function bufToArrayBuffer(buf) {
  const ab = new ArrayBuffer(buf.length);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buf.length; i++) view[i] = buf[i];
  return ab;
}

// ── verifyCidContent ────────────────────────────────────────────────────

test("verifyCidContent is exported", () => {
  assert.equal(typeof ipfs.verifyCidContent, "function");
});

test("verifyCidContent returns true for CIDv1 whose content matches the hash", () => {
  const content = Buffer.from("Hello, ZKVote!");
  const cid = makeCIDv1(content);
  assert.equal(ipfs.verifyCidContent(cid, content), true);
});

test("verifyCidContent returns false for CIDv1 when content is tampered", () => {
  const content = Buffer.from("Hello, ZKVote!");
  const tamperedContent = Buffer.from("Hello, TAMPERED!");
  const cid = makeCIDv1(content);
  assert.equal(ipfs.verifyCidContent(cid, tamperedContent), false);
});

test("verifyCidContent returns true for CIDv0 whose content matches the hash", () => {
  const content = Buffer.from("ZKVote CIDv0 test content");
  const cid = makeCIDv0(content);
  assert.equal(ipfs.verifyCidContent(cid, content), true);
});

test("verifyCidContent returns false for CIDv0 when content is tampered", () => {
  const content = Buffer.from("ZKVote CIDv0 test content");
  const cid = makeCIDv0(content);
  const tamperedContent = Buffer.from("ZKVote CIDv0 TAMPERED!");
  assert.equal(ipfs.verifyCidContent(cid, tamperedContent), false);
});

test("verifyCidContent returns false for empty / invalid inputs", () => {
  const content = Buffer.from("some content");
  assert.equal(ipfs.verifyCidContent("", content), false);
  assert.equal(ipfs.verifyCidContent(null, content), false);
  assert.equal(ipfs.verifyCidContent("not-a-cid", content), false);
  // non-Buffer second arg
  assert.equal(ipfs.verifyCidContent(cidV1, "not-a-buffer"), false);
  assert.equal(ipfs.verifyCidContent(cidV1, null), false);
});

// ── fetchContent CID integrity check (mock test) ──────────────────────────

test("fetchContent rejects tampered content whose CID does not match", async () => {
  // Pinata is already initialized from the earlier mock tests above.
  // Build a CIDv1 for "real content" but serve "tampered content" from every
  // gateway. fetchContent should throw the integrity error.
  const realContent = Buffer.from(JSON.stringify({ version: 1, body: "real" }));
  const validCid = makeCIDv1(realContent);

  const tamperedBody = Buffer.from(JSON.stringify({ version: 1, body: "tampered!" }));

  const originalFetch = globalThis.fetch;
  // Both primary and all fallback gateways return tampered content
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => "application/json" },
    arrayBuffer: async () => bufToArrayBuffer(tamperedBody),
  });

  try {
    await assert.rejects(
      () => ipfs.fetchContent(validCid),
      /CID content integrity check failed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── ensurePinned ──────────────────────────────────────────────────────────

test("ensurePinned is exported", () => {
  assert.equal(typeof ipfs.ensurePinned, "function");
});

test("ensurePinned returns error result for invalid CID", async () => {
  const result = await ipfs.ensurePinned("not-a-valid-cid");
  assert.equal(result.pinned, false);
  assert.ok(result.error);
});

test("ensurePinned returns alreadyPinned:true when CID is in local registry", async () => {
  // Import the pin manager and register a fake pin
  const pinManager = await import("../src/services/ipfs-pin-manager.js");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { rmSync } = await import("node:fs");

  const tmpDir = join(tmpdir(), `zkvote-ensure-pin-${Date.now()}`);
  pinManager.initPinManager(tmpDir);

  const fakeCid = cidV1; // Use the well-formed CIDv1 from module top
  pinManager.registerPin(fakeCid, "json", "test-pin", 100, "application/json");

  const result = await ipfs.ensurePinned(fakeCid, 1);
  assert.equal(result.cid, fakeCid);
  assert.equal(result.alreadyPinned, true);
  assert.equal(result.pinned, true);
  assert.ok(Array.isArray(result.services));
  assert.ok(result.services.length >= 1);

  // Cleanup
  rmSync(tmpDir, { recursive: true, force: true });
});

test("ensurePinned returns error when CID is invalid format", async () => {
  const result = await ipfs.ensurePinned("invalid!!CID");
  assert.equal(result.pinned, false);
  assert.ok(typeof result.error === "string");
});

// ── fetchContent fallback gateway with CID-matched content ───────────────

test("fetchContent tries multiple fallback gateways and succeeds on second", async () => {
  // Build a CIDv1 for content we'll serve from the second fallback
  const content = Buffer.from(JSON.stringify({ hello: "fallback" }));
  const validCid = makeCIDv1(content);

  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    callCount++;
    const href = String(url);

    // Primary gateway: fail
    if (href.includes("gateway.pinata.cloud")) {
      throw new Error("primary gateway down");
    }

    // First public gateway (ipfs.io): fail
    if (href.startsWith("https://ipfs.io/")) {
      throw new Error("first fallback down");
    }

    // Second public gateway (dweb.link): succeed with correct content
    if (href.startsWith("https://dweb.link/")) {
      return {
        ok: true,
        headers: { get: () => "application/json" },
        arrayBuffer: async () => bufToArrayBuffer(content),
      };
    }

    throw new Error(`unexpected fetch: ${href}`);
  };

  try {
    const result = await ipfs.fetchContent(validCid);
    assert.deepEqual(result.data, { hello: "fallback" });
    assert.ok(callCount >= 2, "Should have tried at least 2 gateways");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
