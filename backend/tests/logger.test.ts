/**
 * Tests for PII Redaction, Correlation Context, and Sampling in the Logger.
 * Runs under the backend's node:test runner (tsx).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  redact,
  truncateStellarAddress,
  setRedactionPolicy,
  getRedactionPolicy,
  runWithContext,
  getRequestContext,
  log,
  setLogSampleRate,
  getLogSampleRate,
  type LogMeta,
} from "../src/services/logger.js";

// Valid 56-char Stellar public key (G + 55 alphanumerics).
const STELLAR_ADDRESS = "G" + "A".repeat(55);

function captureLogs(fn: () => void): Array<Record<string, unknown>> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.map((line) => JSON.parse(line));
}

describe("Logger PII Redaction", () => {
  describe("Stellar address redaction", () => {
    it("should truncate Stellar addresses (show first 4 + last 4)", () => {
      assert.equal(truncateStellarAddress(STELLAR_ADDRESS), "GAAA...AAAA");
    });

    it("should redact Stellar addresses in logs", () => {
      const meta = {
        voter: STELLAR_ADDRESS,
        action: "vote_cast",
      };
      const result = redact(meta);
      assert.equal(result.voter, "GAAA...AAAA");
    });
  });

  describe("Field-based redaction", () => {
    it("should redact known sensitive fields", () => {
      const meta = {
        proof: "abcdef123456",
        nullifier: "xyz789",
        secret: "secret123",
        token: "jwt123",
        password: "pass123",
        data: "not_sensitive",
      };
      const result = redact(meta);
      assert.equal(result.proof, "[REDACTED]");
      assert.equal(result.nullifier, "[REDACTED]");
      assert.equal(result.secret, "[REDACTED]");
      assert.equal(result.token, "[REDACTED]");
      assert.equal(result.password, "[REDACTED]");
      assert.equal(result.data, "not_sensitive");
    });
  });

  describe("Log-level based redaction", () => {
    it("should show more details in debug mode", () => {
      const meta = {
        voter: STELLAR_ADDRESS,
        proof: "abcdef123456",
        debugData: "detailed_info",
      };

      const result = redact(meta, "debug");
      assert.equal(result.proof, "[REDACTED]");
      // Debug level keeps non-sensitive fields in full (voter is not sensitive)
      assert.equal(result.voter, STELLAR_ADDRESS);
      assert.equal(result.debugData, "detailed_info");
    });
  });

  describe("Pattern-based redaction", () => {
    it("should redact transaction hashes (show first 6 + last 6)", () => {
      const meta = {
        txHash:
          "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      };
      const result = redact(meta);
      assert.match(result.txHash, /^abcdef\.\.\.567890$/);
    });

    it("should redact IP addresses", () => {
      const meta = {
        ip: "192.168.1.100",
        userIp: "10.0.0.1",
      };
      const result = redact(meta);
      assert.equal(result.ip, "[REDACTED_IP]");
      assert.equal(result.userIp, "[REDACTED_IP]");
    });

    it("should redact IPFS CIDs (show first 6 + last 6)", () => {
      const meta = {
        ipfsCid: "Qmabcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqr",
      };
      const result = redact(meta);
      assert.match(result.ipfsCid, /^Qmabcd\.\.\.mnopqr$/);
    });
  });

  describe("RedactionPolicy configuration", () => {
    it("should allow custom redaction policy and reset", () => {
      setRedactionPolicy({
        redactedFields: ["custom_field", "sensitive"],
        showClientIp: "none",
      });

      const policy = getRedactionPolicy();
      assert.ok(policy.redactedFields.includes("custom_field"));
      assert.equal(policy.showClientIp, "none");

      setRedactionPolicy({
        redactedFields: [
          "proof",
          "nullifier",
          "commitment",
          "secret",
          "token",
          "password",
          "jwt",
          "refresh_token",
          "access_token",
          "api_key",
          "private_key",
          "seed",
          "mnemonic",
        ],
        showClientIp: "hash",
      });
    });
  });
});

describe("Logger Correlation Context", () => {
  it("attaches ctx and traceId to log calls inside a request context", () => {
    const ctx = "a1b2c3d4e5f6";
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

    const lines = captureLogs(() => {
      runWithContext({ ctx, traceId, path: "/vote", method: "POST" }, () => {
        log("info", "service_call", { action: "create_vote" });
      });
    });

    assert.equal(lines.length, 1);
    assert.equal(lines[0].ctx, ctx);
    assert.equal(lines[0].traceId, traceId);
    assert.equal(lines[0].path, "/vote");
    assert.equal(lines[0].method, "POST");
  });

  it("propagates context through async work (correlation flows)", async () => {
    const ctx = "0f0e0d0c0b0a";
    const traceId = "aa0000000000000000000000000000aa";

    const captured = await captureLogsAsync(async () => {
      await runWithContext({ ctx, traceId }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        log("info", "async_flow", { hop: 1 });
        await Promise.resolve();
        log("info", "async_flow", { hop: 2 });
      });
    });

    assert.ok(captured.length >= 2);
    for (const entry of captured) {
      assert.equal(entry.ctx, ctx);
      assert.equal(entry.traceId, traceId);
    }
  });

  it("does not attach correlation when no request context is active", () => {
    const lines = captureLogs(() => {
      log("info", "background_job", { job: "indexer" });
    });

    assert.equal(lines.length, 1);
    assert.equal("ctx" in lines[0], false);
    assert.equal("traceId" in lines[0], false);
  });

  it("exposes the active context via getRequestContext", () => {
    const ctx = "abc123def456";
    runWithContext({ ctx, traceId: "t" }, () => {
      const active = getRequestContext();
      assert.equal(active?.ctx, ctx);
    });
  });
});

describe("Logger Sampling", () => {
  it("drops request logs when sample rate is 0", () => {
    setLogSampleRate(0);
    try {
      const lines = captureLogs(() => {
        runWithContext({ ctx: "x", traceId: "y" }, () => {
          log("info", "request_start", {});
        });
      });
      assert.equal(lines.length, 0);
    } finally {
      setLogSampleRate(1);
    }
  });

  it("keeps request logs when sample rate is 1", () => {
    setLogSampleRate(1);
    try {
      const lines = captureLogs(() => {
        runWithContext({ ctx: "x", traceId: "y" }, () => {
          log("info", "request_start", {});
        });
      });
      assert.equal(lines.length, 1);
    } finally {
      setLogSampleRate(1);
    }
  });

  it("samples deterministically per trace (whole request kept or dropped)", () => {
    setLogSampleRate(0.5);
    try {
      // Same traceId twice -> identical sampling decision for both entries.
      const lines = captureLogs(() => {
        runWithContext({ ctx: "c1", traceId: "abcd" }, () => {
          log("info", "request_start", {});
          log("info", "request_end", {});
        });
      });
      assert.ok(lines.length === 0 || lines.length === 2);
    } finally {
      setLogSampleRate(1);
    }
  });

  it("exposes and clamps the sample rate", () => {
    setLogSampleRate(1.5);
    assert.equal(getLogSampleRate(), 1);
    setLogSampleRate(-1);
    assert.equal(getLogSampleRate(), 0);
    setLogSampleRate(1);
  });

  it("redacts sensitive meta while sampling is active", () => {
    setLogSampleRate(1);
    try {
      const meta: LogMeta = {
        proof: "secret-proof",
        voter: STELLAR_ADDRESS,
      };
      const lines = captureLogs(() => {
        runWithContext({ ctx: "x", traceId: "y" }, () => {
          log("info", "request_start", meta);
        });
      });
      assert.equal(lines.length, 1);
      assert.equal(lines[0].proof, "[REDACTED]");
      assert.equal(lines[0].voter, "GAAA...AAAA");
    } finally {
      setLogSampleRate(1);
    }
  });
});

async function captureLogsAsync(
  fn: () => Promise<void>,
): Promise<Array<Record<string, unknown>>> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.map((line) => JSON.parse(line));
}
