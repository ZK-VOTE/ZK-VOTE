import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isFreighterInstalled,
  connectFreighter,
  persistConnectionIntent,
  hasConnectionIntent,
  FREIGHTER_INSTALL_URL,
} from "./freighter";

describe("freighter service", () => {
  beforeEach(() => {
    localStorage.clear();
    delete window.freighter;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects if Freighter is not installed", () => {
    expect(isFreighterInstalled()).toBe(false);
  });

  it("detects if Freighter is installed", () => {
    window.freighter = {
      isConnected: vi.fn().mockResolvedValue(true),
      isAllowed: vi.fn().mockResolvedValue(true),
      getUserInfo: vi.fn(),
      getPublicKey: vi.fn().mockResolvedValue("GBTEST..."),
      getNetwork: vi.fn().mockResolvedValue("TESTNET"),
      getNetworkDetails: vi.fn(),
      requestAccess: vi.fn().mockResolvedValue("GBTEST..."),
    };
    expect(isFreighterInstalled()).toBe(true);
  });

  it("throws clear install error when connecting without Freighter installed", async () => {
    await expect(connectFreighter()).rejects.toThrow(
      `Freighter is not installed. Please install Freighter from ${FREIGHTER_INSTALL_URL}`
    );
  });

  it("handles locked freighter error", async () => {
    window.freighter = {
      isConnected: vi.fn().mockResolvedValue(true),
      isAllowed: vi.fn().mockResolvedValue(true),
      getUserInfo: vi.fn(),
      getPublicKey: vi.fn(),
      getNetwork: vi.fn(),
      getNetworkDetails: vi.fn(),
      requestAccess: vi.fn(),
      isLocked: vi.fn().mockResolvedValue(true),
    };

    await expect(connectFreighter()).rejects.toThrow(
      "Freighter wallet is locked. Please unlock your Freighter wallet and try again."
    );
  });

  it("handles user rejection error gracefully", async () => {
    window.freighter = {
      isConnected: vi.fn().mockResolvedValue(true),
      isAllowed: vi.fn().mockResolvedValue(false),
      getUserInfo: vi.fn(),
      getPublicKey: vi.fn(),
      getNetwork: vi.fn(),
      getNetworkDetails: vi.fn(),
      requestAccess: vi.fn().mockRejectedValue(new Error("User declined access")),
      isLocked: vi.fn().mockResolvedValue(false),
    };

    await expect(connectFreighter()).rejects.toThrow(
      "Connection request declined by user."
    );
  });

  it("persists connection intent in localStorage", () => {
    let storage: Record<string, string> = {};
    const originalLocalStorage = window.localStorage;
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (key: string) => storage[key] || null,
        setItem: (key: string, value: string) => { storage[key] = value; },
        removeItem: (key: string) => { delete storage[key]; },
        clear: () => { storage = {}; }
      },
      writable: true
    });

    expect(hasConnectionIntent()).toBe(false);
    persistConnectionIntent(true);
    expect(hasConnectionIntent()).toBe(true);
    persistConnectionIntent(false);
    expect(hasConnectionIntent()).toBe(false);

    Object.defineProperty(window, 'localStorage', {
      value: originalLocalStorage,
      writable: true
    });
  });
});
