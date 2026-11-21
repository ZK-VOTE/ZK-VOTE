/**
 * Canary-based redaction tests — ZV-083
 *
 * These tests embed deliberately sensitive canary values and assert that none
 * of them survive in log output.  A canary escaping the redaction layer is a
 * test failure, not just a lint warning.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  redact,
  setRedactionPolicy,
  getRedactionPolicy,
  log,
  runWithContext,
  createLogger,
} from "../../services/logger.js";

// ── Canary corpus ──────────────────────────────────────────────────────────────

const STELLAR_PUBKEY  = "GBSAICCZJ7MB5KMZWKQHQTBSQO3LSXKBVT5XFBEVG3ZQIY4MNLHWGQJ";   // fake 56-char G... address
const STELLAR_SECRET  = "SCZANGBA7UQDC57IQJXLWLQOFK33LVNXOWJTSCH4BQKW2UFZMOXEULV3";   // fake 56-char S...
const REAL_IP         = "192.168.100.42";
const TX_HASH_64      = "a3f4e1d20b7c9f88654321fedcba987605e1234aabbccddeeff00112233445566";
const IPFS_CID_V0     = "QmYwAPJzv5CZsnAztsSugrfLKJjQZu2kZ8MCRGBgQdPZCo";

// ── Helpers ───────────────────────────────────────────────────────────────────

function captureOutput(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
    errSpy.mockRestore();
  }
  return lines;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("redact()", () => {
  beforeEach(() => {
    setRedactionPolicy({});           // reset to defaults
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    setRedactionPolicy({});
  });

  it("replaces known sensitive field names with [REDACTED]", () => {
    const result = redact({
      password: "hunter2",
      secret: "my-secret",
      token: "eyJhbGc",
      privateKey: STELLAR_SECRET,
    });
    expect(result.password).toBe("[REDACTED]");
    expect(result.secret).toBe("[REDACTED]");
    expect(result.token).toBe("[REDACTED]");
    expect(result.privateKey).toBe("[REDACTED]");
  });

  it("masks Stellar public keys regardless of field name", () => {
    const result = redact({ senderAddress: STELLAR_PUBKEY });
    expect(JSON.stringify(result)).not.toContain(STELLAR_PUBKEY);
    // Expect truncated form GBSA…WGQJ
    expect(String(result.senderAddress)).toMatch(/GBSA…WGQJ/);
  });

  it("fully redacts Stellar secret keys even when field name is benign", () => {
    const result = redact({ memo: STELLAR_SECRET });
    expect(JSON.stringify(result)).not.toContain(STELLAR_SECRET);
    expect(String(result.memo)).toContain("[STELLAR_SECRET]");
  });

  it("hashes IP addresses — original IP never appears in output", () => {
    const result = redact({ sourceIp: REAL_IP, description: `request from ${REAL_IP}` });
    const json = JSON.stringify(result);
    expect(json).not.toContain(REAL_IP);
    expect(String(result.sourceIp)).toMatch(/\[IP:[0-9a-f]{8}\]/);
  });

  it("truncates 64-hex transaction hashes", () => {
    const result = redact({ txHash: TX_HASH_64 });
    const json = JSON.stringify(result);
    expect(json).not.toContain(TX_HASH_64);
    expect(String(result.txHash)).toMatch(/\[TX:[0-9a-f]{8}…\]/);
  });

  it("truncates IPFS CIDs", () => {
    const result = redact({ cid: IPFS_CID_V0 });
    const json = JSON.stringify(result);
    expect(json).not.toContain(IPFS_CID_V0);
    expect(String(result.cid)).toMatch(/\[IPFS:QmYwAPJz…\]/);
  });

  it("recursively redacts nested objects", () => {
    const result = redact({
      user: { ip: REAL_IP, wallet: STELLAR_PUBKEY, name: "alice" },
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain(REAL_IP);
    expect(json).not.toContain(STELLAR_PUBKEY);
    expect(json).toContain("alice");   // non-sensitive survives
  });

  it("redacts sensitive values inside arrays", () => {
    const result = redact({ addresses: [STELLAR_PUBKEY, "safe-value"] });
    const json = JSON.stringify(result);
    expect(json).not.toContain(STELLAR_PUBKEY);
    expect(json).toContain("safe-value");
  });

  it("truncates strings exceeding maxStringLength", () => {
    const long = "x".repeat(600);
    const result = redact({ data: long });
    expect(String(result.data).length).toBeLessThan(600);
    expect(String(result.data)).toContain("[truncated]");
  });
});

describe("production: pattern redaction always enforced", () => {
  const realNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    setRedactionPolicy({ detailedLevels: [] });  // mirrors IS_PRODUCTION guard
  });

  afterEach(() => {
    process.env.NODE_ENV = realNodeEnv;
    setRedactionPolicy({});
  });

  it("masks Stellar addresses in production at debug level", () => {
    const result = redact({ addr: STELLAR_PUBKEY }, "debug");
    expect(JSON.stringify(result)).not.toContain(STELLAR_PUBKEY);
  });

  it("masks IPs in production at debug level", () => {
    const result = redact({ ip: REAL_IP }, "debug");
    expect(JSON.stringify(result)).not.toContain(REAL_IP);
  });

  it("masks tx hashes in production at debug level", () => {
    const result = redact({ hash: TX_HASH_64 }, "debug");
    expect(JSON.stringify(result)).not.toContain(TX_HASH_64);
  });
});

describe("log() output", () => {
  it("emits JSON that contains no canary values", () => {
    const lines = captureOutput(() => {
      log("info", "test_event", {
        ip: REAL_IP,
        address: STELLAR_PUBKEY,
        note: "normal text",
      });
    });
    const all = lines.join("\n");
    expect(all).not.toContain(REAL_IP);
    expect(all).not.toContain(STELLAR_PUBKEY);
    expect(all).toContain("normal text");
    expect(all).toContain("test_event");
  });

  it("includes requestId from async context when present", () => {
    const lines = captureOutput(() => {
      runWithContext(
        { requestId: "req-abc123", method: "POST", path: "/vote" },
        () => log("info", "vote_submitted", {})
      );
    });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.requestId).toBe("req-abc123");
    expect(parsed.path).toBe("/vote");
  });

  it("writes errors to stderr", () => {
    const errLines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errLines.push(String(chunk));
      return true;
    });
    log("error", "critical_failure", { code: 500 });
    spy.mockRestore();
    expect(errLines.length).toBe(1);
    expect(JSON.parse(errLines[0]).level).toBe("error");
  });
});

describe("createLogger()", () => {
  it("prefixes every log entry with defaultMeta", () => {
    const lines = captureOutput(() => {
      const logger = createLogger({ service: "relayer" });
      logger.info("started");
    });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.service).toBe("relayer");
  });
});

describe("retention verification — canary must NOT appear in stored log lines", () => {
  it("full canary corpus never survives to stdout", () => {
    const lines = captureOutput(() => {
      log("debug", "canary_test", {
        stellarPub: STELLAR_PUBKEY,
        stellarSec: STELLAR_SECRET,
        ip: REAL_IP,
        txHash: TX_HASH_64,
        ipfsCid: IPFS_CID_V0,
        normal: "this should survive",
      });
    });
    const all = lines.join("\n");
    const canaries = [STELLAR_PUBKEY, STELLAR_SECRET, REAL_IP, TX_HASH_64, IPFS_CID_V0];
    for (const canary of canaries) {
      expect(all, `canary "${canary.slice(0, 12)}…" escaped redaction`).not.toContain(canary);
    }
    expect(all).toContain("this should survive");
  });
});
