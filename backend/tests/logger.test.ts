/**
 * Tests for PII Redaction in Logger
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  redact,
  truncateStellarAddress,
  setRedactionPolicy,
  getRedactionPolicy,
} from "../src/services/logger.js";

// Valid 56-char Stellar G-address (G + 55 base32 chars).
const VALID_STELLAR_ADDRESS = "G" + "A".repeat(55);

describe("Logger PII Redaction", () => {
  describe("Stellar address redaction", () => {
    it("should truncate Stellar addresses (show first 4 + last 4)", () => {
      const result = truncateStellarAddress(VALID_STELLAR_ADDRESS);
      assert.equal(result, "GAAA...AAAA");
    });

    it("should redact Stellar addresses in logs", () => {
      const meta = {
        voter: VALID_STELLAR_ADDRESS,
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
        voter: VALID_STELLAR_ADDRESS,
        proof: "abcdef123456",
        debugData: "detailed_info",
      };

      // In debug mode, non-sensitive fields are passed through untouched;
      // redacted fields stay redacted.
      const result = redact(meta, "debug");
      assert.equal(result.proof, "[REDACTED]");
      assert.equal(result.voter, VALID_STELLAR_ADDRESS);
      assert.equal(result.debugData, "detailed_info");
    });

    it("should redact more in production (info) mode", () => {
      const meta = {
        voter: VALID_STELLAR_ADDRESS,
        debugData: "detailed_info",
      };
      // At info level every field goes through redaction: Stellar addresses
      // are truncated, non-sensitive strings pass through.
      const result = redact(meta, "info");
      assert.equal(result.voter, "GAAA...AAAA");
      assert.equal(result.debugData, "detailed_info");
    });
  });

  describe("Pattern-based redaction", () => {
    it("should redact transaction hashes (show first 6 + last 6)", () => {
      const meta = {
        txHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      };
      const result = redact(meta);
      assert.equal(result.txHash, "abcdef...567890");
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
      assert.ok(result.ipfsCid.includes("Qmabcd...mnopqr"));
    });
  });

  describe("RedactionPolicy configuration", () => {
    it("should allow custom redaction policy", () => {
      setRedactionPolicy({
        redactedFields: ["custom_field", "sensitive"],
        showClientIp: "none",
      });

      const policy = getRedactionPolicy();
      assert.ok(policy.redactedFields.includes("custom_field"));
      assert.equal(policy.showClientIp, "none");
    });
  });
});
