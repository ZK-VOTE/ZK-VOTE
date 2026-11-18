import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSEP24Session,
  invalidateSEP24Session,
  verifyPopupNonce,
} from "../src/services/sep24-session-security.js";

describe("SEP-24 popup nonce replay protection", () => {
  let sessionId: string | undefined;

  afterEach(() => {
    if (sessionId) invalidateSEP24Session(sessionId);
    sessionId = undefined;
  });

  it("accepts the issued nonce once and rejects replay", () => {
    const session = createSEP24Session(
      "USDC",
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      "https://app.example",
    );
    sessionId = session.sessionId;

    assert.equal(verifyPopupNonce(session.sessionId, session.popupNonce), true);
    assert.equal(verifyPopupNonce(session.sessionId, session.popupNonce), false);
  });

  it("rejects malformed, stale, and unknown-session nonces", () => {
    const session = createSEP24Session(
      "EURC",
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      "https://app.example",
    );
    sessionId = session.sessionId;

    assert.equal(verifyPopupNonce(session.sessionId, "bad"), false);
    assert.equal(verifyPopupNonce("missing-session", session.popupNonce), false);
  });
});
