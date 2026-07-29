import { describe, it, expect, beforeEach } from "vitest";
import {
  userStore,
  electionStore,
  uiStore,
  clearAllStores,
  setAuthToken,
  getAuthToken,
  clearAuthToken,
  encryptData,
  decryptData,
  sanitizeState,
  configureDevtools,
} from "./index";

describe("Hardened Stores & Security", () => {
  beforeEach(() => {
    localStorage.clear();
    clearAllStores();
  });

  it("keeps auth tokens in isolated closure", () => {
    setAuthToken("secret_token_123");
    expect(getAuthToken()).toBe("secret_token_123");
    expect(JSON.stringify(userStore.getState())).not.toContain("secret_token_123");

    clearAuthToken();
    expect(getAuthToken()).toBeNull();
  });

  it("encrypts and decrypts stored state", () => {
    const original = { address: "GABC123...", daoMemberships: ["dao1"] };
    const encrypted = encryptData(original, "test_key");
    expect(encrypted).not.toContain("GABC123...");

    const decrypted = decryptData<typeof original>(encrypted, "test_key");
    expect(decrypted).toEqual(original);
  });

  it("sanitizes sensitive fields before logging/reporting", () => {
    const sensitiveObj = {
      user: "alice",
      token: "secret_token",
      nested: {
        privateKey: "0x123",
        publicData: "hello",
      },
    };

    const sanitized = sanitizeState(sensitiveObj);
    expect(sanitized.user).toBe("alice");
    expect(sanitized.token).toBe("[REDACTED]");
    expect((sanitized.nested as any).privateKey).toBe("[REDACTED]");
    expect((sanitized.nested as any).publicData).toBe("hello");
  });

  it("clears all stores on logout/disconnect", () => {
    userStore.setUser("GABC123...", "my_token", ["dao1"]);
    electionStore.setUnsubmittedVote("prop1", 2);
    uiStore.openModal("vote");

    expect(userStore.getState().isConnected).toBe(true);
    expect(getAuthToken()).toBe("my_token");
    expect(electionStore.getState().unsubmittedVoteChoices["prop1"]).toBe(2);

    clearAllStores();

    expect(userStore.getState().isConnected).toBe(false);
    expect(getAuthToken()).toBeNull();
    expect(electionStore.getState().unsubmittedVoteChoices).toEqual({});
    expect(uiStore.getState().isModalOpen).toBe(false);
  });

  it("disables devtools in production environment", () => {
    (window as any).__ZUSTAND_DEVTOOLS__ = {};
    const enabled = configureDevtools();
    if (import.meta.env.PROD || process.env.NODE_ENV === "production") {
      expect(enabled).toBe(false);
      expect((window as any).__ZUSTAND_DEVTOOLS__).toBeUndefined();
    }
  });
});
