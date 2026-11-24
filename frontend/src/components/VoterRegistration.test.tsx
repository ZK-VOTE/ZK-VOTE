import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import VoterRegistration from "./VoterRegistration";
import { mnemonicToMasterSecret } from "../lib/crypto";

/**
 * The global test setup (src/test/setup.ts) stubs `window.localStorage`
 * with a permanent no-op (getItem always returns null). That's fine for
 * most components, but these tests specifically exercise save/restore
 * across a render, so each test gets a real in-memory backing store layered
 * on top of the same mock object (the `window.localStorage` property itself
 * is locked down and can't be replaced, but its methods can be spied on).
 */
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
  vi.spyOn(window.localStorage, "removeItem").mockImplementation(
    (key: string) => {
      store.delete(key);
    },
  );
  vi.spyOn(window.localStorage, "clear").mockImplementation(() => {
    store.clear();
  });
  return store;
}

describe("VoterRegistration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installInMemoryLocalStorage();
    (global as unknown as { fetch: typeof fetch }).fetch = vi
      .fn()
      .mockResolvedValue({ ok: true } as unknown as Response);
  });

  it("shows the progressive-onboarding choice screen for a first-time visitor", () => {
    render(<VoterRegistration />);
    expect(
      screen.getByText("Set Up Your Voting Identity"),
    ).toBeInTheDocument();
    expect(screen.getByText("Browse read-only")).toBeInTheDocument();
  });

  it("never generates a secret or derives keys in read-only explore mode", async () => {
    render(<VoterRegistration />);
    fireEvent.click(screen.getByText("Browse read-only"));

    await waitFor(() =>
      expect(screen.getByText("Browsing Read-Only")).toBeInTheDocument(),
    );
    expect(localStorage.getItem("zkvote_hd_master_secret")).toBeNull();
    expect(
      screen.queryByText(/Derived Election Identity/),
    ).not.toBeInTheDocument();
  });

  it("restores an existing secret directly into setup mode, skipping the choice screen", async () => {
    const mnemonic =
      "abandon ability able about above absent absorb abstract absurd abuse access accident";
    const secret = mnemonicToMasterSecret(mnemonic).toString();
    localStorage.setItem("zkvote_hd_master_secret", secret);

    render(<VoterRegistration />);
    await waitFor(() =>
      expect(
        screen.getByText("HD Multi-Election Identity"),
      ).toBeInTheDocument(),
    );
  });

  it("creating an identity generates a 12-word phrase and requires backup confirmation before finishing", async () => {
    const onCredentialsDerived = vi.fn();
    render(<VoterRegistration onCredentialsDerived={onCredentialsDerived} />);

    fireEvent.click(screen.getByText("Create a voting identity"));

    await waitFor(() =>
      expect(
        screen.getByText("HD Multi-Election Identity"),
      ).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/backup hasn't been confirmed/),
      ).toBeInTheDocument(),
    );

    // Derivation runs locally (so the user can see their identity) but the
    // callback must not fire until the backup is confirmed.
    await waitFor(() =>
      expect(
        screen.getByText(/Derived Election Identity/),
      ).toBeInTheDocument(),
    );
    expect(onCredentialsDerived).not.toHaveBeenCalled();
  });

  it("completes verification with the correct word and then fires onCredentialsDerived", async () => {
    const onCredentialsDerived = vi.fn();
    render(<VoterRegistration onCredentialsDerived={onCredentialsDerived} />);
    fireEvent.click(screen.getByText("Create a voting identity"));

    await waitFor(() => screen.getByText("Verify my backup"));
    fireEvent.click(screen.getByText("Verify my backup"));

    const mnemonic = localStorage.getItem("zkvote_hd_mnemonic")!;
    const words = mnemonic.split(" ");

    const match = screen.getByText(/Confirm word #(\d+)/);
    const position = Number(match.textContent!.match(/#(\d+)/)![1]) - 1;

    const input = screen.getByLabelText(`Backup word ${position + 1}`);
    fireEvent.change(input, { target: { value: words[position] } });
    fireEvent.click(screen.getByText("Confirm Backup"));

    await waitFor(() =>
      expect(screen.getByText(/Backup confirmed/)).toBeInTheDocument(),
    );
    await waitFor(() => expect(onCredentialsDerived).toHaveBeenCalled());
  });

  it("rejects an incorrect verification word without confirming the backup", async () => {
    render(<VoterRegistration />);
    fireEvent.click(screen.getByText("Create a voting identity"));

    await waitFor(() => screen.getByText("Verify my backup"));
    fireEvent.click(screen.getByText("Verify my backup"));

    const match = screen.getByText(/Confirm word #(\d+)/);
    const position = Number(match.textContent!.match(/#(\d+)/)![1]) - 1;
    const input = screen.getByLabelText(`Backup word ${position + 1}`);
    fireEvent.change(input, { target: { value: "definitely-wrong-word" } });
    fireEvent.click(screen.getByText("Confirm Backup"));

    await waitFor(() =>
      expect(screen.getByText(/doesn't match/)).toBeInTheDocument(),
    );
  });

  it("does not expose the mnemonic words in the unverified-backup reminder", async () => {
    render(<VoterRegistration />);
    fireEvent.click(screen.getByText("Create a voting identity"));

    await waitFor(() => screen.getByText(/backup hasn't been confirmed/));
    const mnemonic = localStorage.getItem("zkvote_hd_mnemonic")!;

    // The reminder is static copy with no interpolated secret data — assert
    // its exact text rather than scanning for individual mnemonic words,
    // since several BIP-39 words (e.g. "about", "access", "confirm") are
    // common enough to coincidentally appear in any English UI copy.
    const reminderText = screen
      .getByText(/backup hasn't been confirmed/)
      .closest("div")!.textContent!;
    expect(reminderText).toBe(
      "Your backup hasn't been confirmed yet." +
        "Confirm you've saved your phrase to finish setting up voting. " +
        "We'll only ask for a single word — never the full phrase." +
        "Verify my backup",
    );
    expect(reminderText).not.toContain(mnemonic);
  });

  it("restores the exact backed-up phrase, not a regenerated approximation from the secret", async () => {
    // mnemonicToMasterSecret/masterSecretToMnemonic reduce entropy modulo
    // the BN254 field and don't round-trip for this phrase — restoring
    // from the stored mnemonic (not re-deriving one from the secret) is
    // what makes "verify your backup" meaningful after a page reload.
    const mnemonic =
      "abandon ability able about above absent absorb abstract absurd abuse access accident";
    const secret = mnemonicToMasterSecret(mnemonic).toString();
    localStorage.setItem("zkvote_hd_master_secret", secret);
    localStorage.setItem("zkvote_hd_mnemonic", mnemonic);

    render(<VoterRegistration />);
    await waitFor(() =>
      expect(
        screen.getByText("HD Multi-Election Identity"),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText(/Reveal/));
    expect(screen.getByText("abandon")).toBeInTheDocument();
    expect(screen.getByText("accident")).toBeInTheDocument();
  });

  it("restoring a previously-verified secret skips re-verification", async () => {
    const mnemonic =
      "abandon ability able about above absent absorb abstract absurd abuse access accident";
    const secret = mnemonicToMasterSecret(mnemonic).toString();
    localStorage.setItem("zkvote_hd_master_secret", secret);
    localStorage.setItem("zkvote_backup_verified_for", secret);

    const onCredentialsDerived = vi.fn();
    render(<VoterRegistration onCredentialsDerived={onCredentialsDerived} />);

    await waitFor(() => expect(onCredentialsDerived).toHaveBeenCalled());
    expect(
      screen.queryByText(/backup hasn't been confirmed/),
    ).not.toBeInTheDocument();
  });
});
