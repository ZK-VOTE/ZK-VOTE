import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  sanitizeAnchorResponse,
  validateInteractiveUrl,
} from "../src/services/anchor.js";

describe("anchor interactive URL validation", () => {
  it("accepts the configured asset anchor and exposes its exact origin", () => {
    const result = sanitizeAnchorResponse(
      { interactive_url: "https://anchor.circle.com/sep24/session/123" },
      "USDC",
    );
    assert.equal(result.interactiveOrigin, "https://anchor.circle.com");
    assert.equal(
      result.interactiveUrl,
      "https://anchor.circle.com/sep24/session/123",
    );
    assert.equal(result.interactive_url, undefined);
  });

  it("blocks a malicious or lookalike anchor before it reaches the iframe", () => {
    assert.throws(
      () =>
        validateInteractiveUrl(
          "https://anchor.circle.com.evil.example/steal",
          "USDC",
        ),
      /untrusted/,
    );
    assert.throws(
      () => validateInteractiveUrl("javascript:alert(1)", "USDC"),
      /untrusted/,
    );
  });
});
