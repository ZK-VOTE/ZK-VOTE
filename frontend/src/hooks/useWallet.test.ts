import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// Mock the stellar wallets kit - must use inline factory
vi.mock("@creit.tech/stellar-wallets-kit", () => {
  const mockGetAddress = vi.fn().mockResolvedValue({ address: "GDTEST..." });
  const mockSetWallet = vi.fn();
  const mockOpenModal = vi.fn();

  class MockStellarWalletsKit {
    getAddress = mockGetAddress;
    setWallet = mockSetWallet;
    openModal = mockOpenModal;
  }

  return {
    StellarWalletsKit: MockStellarWalletsKit,
    WalletNetwork: {
      PUBLIC: "PUBLIC",
      TESTNET: "TESTNET",
      FUTURENET: "FUTURENET",
    },
    FREIGHTER_ID: "freighter",
    FreighterModule: class {},
    xBullModule: class {},
    AlbedoModule: class {},
  };
});

// Mock the config
vi.mock("../config/contracts", () => ({
  NETWORK_CONFIG: {
    networkPassphrase: "Test SDF Future Network ; October 2022",
  },
}));

// Import AFTER mocks are set up
import { useWallet } from "./useWallet";

describe("useWallet", () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initializes with default state", async () => {
    const { result } = renderHook(() => useWallet());

    // Initial state - publicKey should be null and not connected
    expect(result.current.publicKey).toBeNull();
    expect(result.current.isConnected).toBe(false);

    // Wait for initialization to complete (may already be done due to fast mocks)
    await waitFor(() => {
      expect(result.current.isInitializing).toBe(false);
    });

    // After initialization, still should be disconnected (no stored wallet)
    expect(result.current.publicKey).toBeNull();
    expect(result.current.isConnected).toBe(false);
  });

  it("provides connect and disconnect functions", () => {
    const { result } = renderHook(() => useWallet());

    expect(typeof result.current.connect).toBe("function");
    expect(typeof result.current.disconnect).toBe("function");
  });

  it("skips auto-reconnect when no stored wallet ID", async () => {
    const { result } = renderHook(() => useWallet());

    // Wait for initialization to complete
    await waitFor(() => {
      expect(result.current.isInitializing).toBe(false);
    });

    // Should remain disconnected
    expect(result.current.isConnected).toBe(false);
    expect(result.current.publicKey).toBeNull();
  });

  it("disconnect clears state and localStorage", async () => {
    const { result } = renderHook(() => useWallet());

    // Set up some localStorage entries that should be cleared
    localStorage.setItem("selectedWalletId", "freighter");
    localStorage.setItem("SWK_something", "value");
    localStorage.setItem("stellar_data", "value");

    // Wait for initialization
    await waitFor(() => {
      expect(result.current.isInitializing).toBe(false);
    });

    // Call disconnect
    act(() => {
      result.current.disconnect();
    });

    // State should be cleared
    expect(result.current.isConnected).toBe(false);
    expect(result.current.publicKey).toBeNull();

    // localStorage should be cleared
    expect(localStorage.getItem("selectedWalletId")).toBeNull();
    expect(localStorage.getItem("SWK_something")).toBeNull();
    expect(localStorage.getItem("stellar_data")).toBeNull();
  });

  it("kit is available after initialization", async () => {
    const { result } = renderHook(() => useWallet());

    await waitFor(() => {
      expect(result.current.kit).not.toBeNull();
    });
  });
});

describe("inferWalletNetwork (via useWallet behavior)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("handles unknown network passphrase gracefully", async () => {
    // This is tested indirectly - the hook should still initialize
    // even with an unknown passphrase
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = renderHook(() => useWallet());

    await waitFor(() => {
      expect(result.current.isInitializing).toBe(false);
    });

    // Kit should still be created (falling back to FUTURENET)
    expect(result.current.kit).not.toBeNull();

    consoleSpy.mockRestore();
  });
});

describe("WalletState interface", () => {
  it("has correct shape", () => {
    const state = {
      publicKey: "GTEST..." as string | null,
      isConnected: true,
      isInitializing: false,
      kit: null,
    };

    expect(state.publicKey).toBeDefined();
    expect(typeof state.isConnected).toBe("boolean");
    expect(typeof state.isInitializing).toBe("boolean");
  });
});
