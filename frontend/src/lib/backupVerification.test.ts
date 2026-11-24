import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifyMnemonicBackup,
  generateVerificationChallenge,
  verifyWordAtPosition,
  markBackupVerified,
  isBackupVerified,
} from "./backupVerification";
import {
  generateMnemonic,
  mnemonicToMasterSecret,
  masterSecretToMnemonic,
} from "./crypto";

function installInMemoryLocalStorage() {
  const store = new Map<string, string>();
  vi.spyOn(window.localStorage, "getItem").mockImplementation((key: string) =>
    store.has(key) ? store.get(key)! : null,
  );
  vi.spyOn(window.localStorage, "setItem").mockImplementation(
    (key: string, value: string) => {
      store.set(key, String(value));
    },
  );
}

describe("backupVerification", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installInMemoryLocalStorage();
  });

  describe("verifyMnemonicBackup", () => {
    it("succeeds when the entered mnemonic matches the original secret", () => {
      const mnemonic = generateMnemonic(12);
      const secret = mnemonicToMasterSecret(mnemonic).toString();
      const result = verifyMnemonicBackup(secret, mnemonic);
      expect(result.success).toBe(true);
    });

    it("fails when the word count is wrong", () => {
      const result = verifyMnemonicBackup("123", "only two words");
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Expected 12 words/);
    });
  });

  describe("generateVerificationChallenge", () => {
    it("always returns a position within the 12-word range", () => {
      for (let i = 0; i < 50; i++) {
        const pos = generateVerificationChallenge();
        expect(pos).toBeGreaterThanOrEqual(0);
        expect(pos).toBeLessThan(12);
      }
    });
  });

  describe("verifyWordAtPosition", () => {
    it("matches the correct word at a given position, case-insensitively", () => {
      const mnemonic = generateMnemonic(12);
      const words = mnemonic.split(" ");
      expect(verifyWordAtPosition(mnemonic, 3, words[3].toUpperCase())).toBe(
        true,
      );
    });

    it("rejects a wrong word", () => {
      const mnemonic = generateMnemonic(12);
      expect(verifyWordAtPosition(mnemonic, 0, "not-a-real-word")).toBe(
        false,
      );
    });

    it("checks against the exact phrase given, independent of any master secret round trip", () => {
      // mnemonicToMasterSecret/masterSecretToMnemonic reduce entropy modulo
      // the BN254 field and are not guaranteed to round-trip (this fixed
      // phrase is a known case where they don't). A mnemonic that would
      // regenerate differently from its own derived secret must still
      // verify correctly against itself.
      const mnemonic =
        "abandon ability able about above absent absorb abstract absurd abuse access accident";
      const secret = mnemonicToMasterSecret(mnemonic).toString();
      const roundTripped = masterSecretToMnemonic(secret);
      expect(roundTripped).not.toBe(mnemonic); // sanity-check the premise
      const words = mnemonic.split(" ");
      expect(verifyWordAtPosition(mnemonic, 5, words[5])).toBe(true);
    });
  });

  describe("per-secret verified scoping (#791 follow-up)", () => {
    it("is unverified for a secret that has never been marked", () => {
      expect(isBackupVerified("secret-a")).toBe(false);
    });

    it("is verified only for the specific secret that was marked", () => {
      markBackupVerified("secret-a");
      expect(isBackupVerified("secret-a")).toBe(true);
      expect(isBackupVerified("secret-b")).toBe(false);
    });

    it("switching to a newly-imported secret does not inherit a previous verification", () => {
      markBackupVerified("secret-a");
      expect(isBackupVerified("secret-a")).toBe(true);

      // Import a different secret into the same browser.
      expect(isBackupVerified("secret-b")).toBe(false);
    });
  });
});
