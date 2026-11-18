import { describe, expect, it } from "vitest";
import {
  isTrustedAnchorMessage,
  parseTrustedAnchorSession,
} from "./anchorMessaging";

describe("anchor messaging", () => {
  const session = {
    url: "https://anchor.circle.com/sep24/session/123",
    origin: "https://anchor.circle.com",
    nonce: "0123456789abcdef0123456789abcdef",
    sessionId: "session-123",
    token: "session-token",
  };

  it("rejects interactive URLs outside the allowlist", () => {
    expect(
      parseTrustedAnchorSession(
        {
          interactiveUrl: "https://evil.example/steal",
          interactiveOrigin: "https://evil.example",
          session: { popupNonce: session.nonce, sessionId: session.sessionId, token: session.token },
        },
        new Set(["https://anchor.circle.com"]),
      ),
    ).toBeNull();
  });

  it("requires a valid session nonce before accepting a trusted anchor URL", () => {
    expect(
      parseTrustedAnchorSession(
        {
          interactiveUrl: session.url,
          interactiveOrigin: session.origin,
          session: { popupNonce: session.nonce },
        },
        new Set([session.origin]),
      ),
    ).toEqual(session);
    expect(
      parseTrustedAnchorSession(
        {
          interactiveUrl: session.url,
          interactiveOrigin: session.origin,
          session: { popupNonce: "stale", sessionId: session.sessionId, token: session.token },
        },
        new Set([session.origin]),
      ),
    ).toBeNull();
  });

  it("accepts messages only from the exact iframe, origin, nonce, and schema", () => {
    const frameWindow = {} as Window;
    const trusted = {
      source: frameWindow,
      origin: session.origin,
      data: {
        type: "sep24:complete",
        nonce: session.nonce,
        transactionId: "tx-123",
      },
    } as MessageEvent;
    expect(isTrustedAnchorMessage(trusted, frameWindow, session)).toBe(true);
    expect(
      isTrustedAnchorMessage(
        { ...trusted, origin: "https://evil.example" } as MessageEvent,
        frameWindow,
        session,
      ),
    ).toBe(false);
    expect(
      isTrustedAnchorMessage(
        {
          ...trusted,
          data: { type: "sep24:complete", nonce: "ffffffffffffffffffffffffffffffff" },
        } as MessageEvent,
        frameWindow,
        session,
      ),
    ).toBe(false);
    expect(
      isTrustedAnchorMessage(
        {
          ...trusted,
          data: { type: "sep24:complete", nonce: session.nonce, injected: true },
        } as MessageEvent,
        frameWindow,
        session,
      ),
    ).toBe(false);
  });
});
