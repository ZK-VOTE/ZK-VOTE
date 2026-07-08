import { useState, useCallback, useEffect } from "react";
import {
  StellarWalletsKit,
  WalletNetwork,
  FREIGHTER_ID,
  FreighterModule,
  xBullModule,
  AlbedoModule,
} from "@creit.tech/stellar-wallets-kit";
import type { ISupportedWallet } from "@creit.tech/stellar-wallets-kit";
import { NETWORK_CONFIG } from "../config/contracts";

export interface WalletState {
  publicKey: string | null;
  isConnected: boolean;
  isInitializing: boolean;
  kit: StellarWalletsKit | null;
}

let globalKit: StellarWalletsKit | null = null;

// Safe localStorage helpers (handle private mode/SSR)
const safeLocalStorageGet = (key: string): string | null => {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return localStorage.getItem(key);
    }
  } catch {
    console.warn("[useWallet] localStorage.getItem failed for", key);
  }
  return null;
};

const safeLocalStorageSet = (key: string, value: string): void => {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      localStorage.setItem(key, value);
    }
  } catch {
    console.warn("[useWallet] localStorage.setItem failed for", key);
  }
};

const safeLocalStorageRemove = (key: string): void => {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      localStorage.removeItem(key);
    }
  } catch {
    console.warn("[useWallet] localStorage.removeItem failed for", key);
  }
};

const inferWalletNetwork = (passphrase: string): WalletNetwork | null => {
  if (passphrase === "Public Global Stellar Network ; September 2015")
    return WalletNetwork.PUBLIC;
  if (passphrase === "Test SDF Network ; September 2015")
    return WalletNetwork.TESTNET;
  if (passphrase === "Test SDF Future Network ; October 2022")
    return WalletNetwork.FUTURENET;
  // Unknown/custom network (e.g., local sandbox)
  return null;
};

export function useWallet() {
  const [wallet, setWallet] = useState<WalletState>({
    publicKey: null,
    isConnected: false,
    isInitializing: true,
    kit: null,
  });

  useEffect(() => {
    // Initialize kit only once
    if (!globalKit) {
      const inferredNetwork = inferWalletNetwork(
        NETWORK_CONFIG.networkPassphrase,
      );
      if (!inferredNetwork) {
        console.warn(
          "[wallet] Using FUTURENET as fallback; update WalletNetwork mapping if using a custom passphrase",
          NETWORK_CONFIG.networkPassphrase,
        );
      }

      globalKit = new StellarWalletsKit({
        network: inferredNetwork ?? WalletNetwork.FUTURENET,
        selectedWalletId: FREIGHTER_ID,
        modules: [new FreighterModule(), new xBullModule(), new AlbedoModule()],
      });
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional: one-time kit initialization
    setWallet((prev) => ({ ...prev, kit: globalKit }));

    // Only attempt auto-reconnect if user previously connected
    const checkConnection = async () => {
      const storedWalletId = safeLocalStorageGet("selectedWalletId");

      if (!storedWalletId) {
        // No previous connection, skip auto-reconnect
        if (import.meta.env.DEV)
          console.log(
            "[useWallet] No stored wallet, skipping auto-reconnect. isInitializing -> false",
          );
        setWallet((prev) => ({ ...prev, isInitializing: false }));
        return;
      }

      try {
        // User previously connected, attempt silent reconnect
        globalKit!.setWallet(storedWalletId);
        const { address } = await globalKit!.getAddress();
        if (address) {
          if (import.meta.env.DEV)
            console.log(
              "[useWallet] Auto-reconnected to wallet:",
              address,
              "isInitializing -> false",
            );
          setWallet({
            publicKey: address,
            isConnected: true,
            isInitializing: false,
            kit: globalKit,
          });
        }
      } catch {
        // Auto-reconnect failed, clear stored wallet
        if (import.meta.env.DEV)
          console.log(
            "[useWallet] Auto-reconnect failed, user needs to reconnect manually. isInitializing -> false",
          );
        safeLocalStorageRemove("selectedWalletId");
        setWallet((prev) => ({ ...prev, isInitializing: false }));
      }
    };

    checkConnection();
  }, []);

  const connect = useCallback(async () => {
    if (!globalKit) {
      throw new Error("Wallet kit not initialized");
    }

    try {
      await globalKit.openModal({
        onWalletSelected: async (option: ISupportedWallet) => {
          globalKit!.setWallet(option.id);
          const { address } = await globalKit!.getAddress();

          // Store wallet selection in localStorage for persistence
          safeLocalStorageSet("selectedWalletId", option.id);

          setWallet({
            publicKey: address,
            isConnected: true,
            isInitializing: false,
            kit: globalKit,
          });
        },
      });
    } catch (error) {
      console.error("Failed to connect wallet:", error);
      throw error;
    }
  }, []);

  const disconnect = useCallback(() => {
    // Clear stored wallet selection
    safeLocalStorageRemove("selectedWalletId");

    // Clear all Stellar Wallets Kit localStorage entries
    // The library stores data with keys prefixed with "SWK" or containing "stellar"
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        Object.keys(localStorage).forEach((key) => {
          if (
            key.startsWith("SWK") ||
            key.toLowerCase().includes("stellar") ||
            key.toLowerCase().includes("wallet") ||
            key.toLowerCase().includes("freighter") ||
            key.toLowerCase().includes("albedo") ||
            key.toLowerCase().includes("xbull")
          ) {
            localStorage.removeItem(key);
          }
        });
      }
    } catch {
      console.warn("[useWallet] Failed to clear wallet localStorage entries");
    }

    setWallet({
      publicKey: null,
      isConnected: false,
      isInitializing: false,
      kit: globalKit,
    });
  }, []);

  return {
    ...wallet,
    connect,
    disconnect,
  };
}
