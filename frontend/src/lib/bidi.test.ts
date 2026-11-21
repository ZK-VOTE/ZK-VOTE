import { describe, it, expect } from "vitest";
import {
  hasBidiOverrides,
  stripBidiOverrides,
  isolateBidi,
  sanitizeAddress,
} from "./bidi";

describe("bidi", () => {
  describe("hasBidiOverrides", () => {
    it("detects a bidi override character", () => {
      const spoof = "transfer‮example.com‬";
      expect(hasBidiOverrides(spoof)).toBe(true);
    });

    it("returns false for clean text, including real RTL script", () => {
      expect(hasBidiOverrides("hello world")).toBe(false);
      expect(hasBidiOverrides("نص عربي آمن")).toBe(false);
    });

    // ZV-130 (backend) / ZV-109: a `.test()` call against a global-flagged
    // regex advances `lastIndex`, so reusing the same regex object across
    // calls can make a later, unrelated string's real override go
    // undetected. The equivalent fix landed on the backend for #792 but
    // was missed here on the frontend.
    it("repeated probes do not toggle due to RegExp.lastIndex, even across unrelated strings", () => {
      const spoof = "transfer‮example.com‬";
      expect(hasBidiOverrides(spoof)).toBe(true);
      expect(hasBidiOverrides(spoof)).toBe(true);
      expect(hasBidiOverrides(spoof)).toBe(true);

      // A short, clean string probed right after a match used to be
      // missed if lastIndex had advanced past its length.
      expect(hasBidiOverrides("ok")).toBe(false);
      expect(hasBidiOverrides("‮short")).toBe(true);
    });
  });

  describe("stripBidiOverrides", () => {
    it("removes override characters while keeping the rest of the text", () => {
      expect(stripBidiOverrides("transfer‮example.com‬")).toBe(
        "transferexample.com",
      );
    });

    it("is a no-op on text without overrides", () => {
      expect(stripBidiOverrides("hello")).toBe("hello");
    });
  });

  describe("isolateBidi / sanitizeAddress", () => {
    it("wraps text in FSI...PDI isolation marks", () => {
      expect(isolateBidi("abc")).toBe("⁨abc⁩");
    });

    it("sanitizeAddress strips overrides before isolating", () => {
      const malicious = "G‮ABC";
      const result = sanitizeAddress(malicious);
      // The RLO override (‮) must be gone; the FSI/PDI wrapper that's
      // left is the isolation marker sanitizeAddress itself adds, not an
      // attack character (both happen to fall in the same Unicode block).
      expect(result).toBe("⁨GABC⁩");
      expect(result).not.toContain("‮");
    });
  });
});
