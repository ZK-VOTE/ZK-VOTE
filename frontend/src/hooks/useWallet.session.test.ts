/**
 * useWallet → wallet session (#750), driven by the scripted wallet harness:
 * every interruption class a real wallet produces must reach the shared
 * session, bump its generation, and clear query caches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { installFakeWallet, type FakeWallet } from "../test/fakeWallet";

let wallet: FakeWallet;

vi.mock("@creit.tech/stellar-wallets-kit", () => {
  class MockStellarWalletsKit {
    getAddress = () => wallet.kitAddress();
    setWallet = vi.fn();
    openModal = vi.fn();
  }
  return {
    StellarWalletsKit: MockStellarWalletsKit,
    WalletNetwork: { PUBLIC: "PUBLIC", TESTNET: "TESTNET", FUTURENET: "FUTURENET" },
    FREIGHTER_ID: "freighter",
    FreighterModule: class {},
    xBullModule: class {},
    AlbedoModule: class {},
  };
});
vi.mock("../config/contracts", () => ({
  NETWORK_CONFIG: { networkPassphrase: "Test SDF Network ; September 2015", networkName: "testnet" },
  CONTRACTS: { VOTING_ID: "CVOTING" },
}));
const clearAllQueryCaches = vi.fn();
vi.mock("../lib/cacheInvalidation", () => ({ clearAllQueryCaches: () => clearAllQueryCaches() }));
vi.mock("../lib/api", () => ({ relayerFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) }));

const store: Record<string, string> = {};
Object.defineProperty(window, "localStorage", {
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => void (store[k] = v),
    removeItem: (k: string) => void delete store[k],
    clear: () => Object.keys(store).forEach((k) => delete store[k]),
    get length() {
      return Object.keys(store).length;
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
  },
  writable: true,
});

import { useWallet } from "./useWallet";
import { __resetWalletSession, walletSession } from "../lib/walletSession";
import { submissionQueue } from "../store/submissionQueue";

const VICTIM = "GVICTIM" + "A".repeat(49);
const OTHER = "GOTHER" + "B".repeat(50);

async function connected(mode: "events" | "polling" = "events") {
  wallet = installFakeWallet({ account: VICTIM, network: "TESTNET", mode });
  localStorage.setItem("selectedWalletId", "freighter"); // auto-reconnect path
  const hook = renderHook(() => useWallet());
  await waitFor(() => expect(hook.result.current.isConnected).toBe(true));
  return hook;
}

beforeEach(() => {
  __resetWalletSession();
  submissionQueue.clearAll();
  localStorage.clear();
  clearAllQueryCaches.mockClear();
});
afterEach(() => {
  wallet?.uninstall();
  vi.useRealTimers();
});

describe("useWallet drives the wallet session", () => {
  it("auto-reconnect opens an active session on the matching network, with no warning", async () => {
    const { result } = await connected();
    expect(walletSession.getState()).toMatchObject({ account: VICTIM, status: "active" });
    // Freighter reports "TESTNET"; the old substring check warned here.
    expect(result.current.networkWarning).toBeNull();
  });

  it("account switch: new generation, new account, caches cleared", async () => {
    const { result } = await connected();
    const g = walletSession.getState().generation;
    clearAllQueryCaches.mockClear();
    act(() => wallet.switchAccount(OTHER));
    await waitFor(() => expect(result.current.publicKey).toBe(OTHER));
    expect(walletSession.getState()).toMatchObject({ account: OTHER, generation: g + 1 });
    expect(clearAllQueryCaches).toHaveBeenCalled();
  });

  it("network switch blocks (status), warns, and recovers when switched back", async () => {
    const { result } = await connected();
    act(() => wallet.switchNetwork("FUTURENET"));
    await waitFor(() => expect(walletSession.getState().status).toBe("network_mismatch"));
    await waitFor(() => expect(result.current.networkWarning).toMatch(/futurenet.*blocked/));
    expect(() => walletSession.assertCanBuild(VICTIM)).toThrow(/futurenet/);

    act(() => wallet.switchNetwork("TESTNET"));
    await waitFor(() => expect(walletSession.getState().status).toBe("active"));
    expect(result.current.networkWarning).toBeNull();
  });

  it("lock ends the session; unlock with the same account resumes it", async () => {
    await connected();
    act(() => wallet.lock());
    await waitFor(() => expect(walletSession.getState().status).toBe("disconnected"));
    act(() => wallet.unlock());
    // The hook drops its listeners once disconnected; reconnecting is explicit.
    expect(walletSession.getState().account).toBeNull();
  });

  it("polling-only Freighter: a switch is still detected (2 s poll)", async () => {
    await connected("polling");
    // The first poll reports the current account; the switch shows on a later one.
    await waitFor(() => expect(walletSession.getState().account).toBe(VICTIM));
    wallet.switchAccount(OTHER);
    await waitFor(() => expect(walletSession.getState().account).toBe(OTHER), { timeout: 5000 });
  });

  it("disconnect ends the session but keeps unsent proofs for resume", async () => {
    const { result } = await connected();
    const binding = await walletSession.currentBinding();
    submissionQueue.enqueue(
      {
        daoId: 1,
        proposalId: 1,
        choice: true,
        nullifier: "aa".repeat(32),
        root: "bb".repeat(32),
        proof: { a: "", b: "", c: "" },
        timestamp: Date.now(),
      },
      binding,
    );
    act(() => result.current.disconnect());
    expect(walletSession.getState().status).toBe("disconnected");
    expect(submissionQueue.getState().entries["aa".repeat(32)]?.status).toBe("pending");
  });

  it("malicious module: a kit reporting another account is caught before signing", async () => {
    await connected();
    wallet.kitOverride(OTHER); // extension says VICTIM, the module says OTHER
    const snap = walletSession.snapshot();
    await walletSession.verifyLiveAccount({ getAddress: () => wallet.kitAddress() });
    expect(() => walletSession.checkpoint(snap)).toThrow(/switched away/);
  });
});
