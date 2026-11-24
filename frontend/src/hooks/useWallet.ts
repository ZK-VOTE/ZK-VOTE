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
import {
  getFreighterNetworkDetails,
  listenToAccountChange,
  listenToNetworkChange,
  persistConnectionIntent,
} from "../services/freighter";
import { clearAllStores } from "../store";
import {
  APP_NETWORK_PASSPHRASE,
  networkLabel,
  resolveWalletPassphrase,
  walletSession,
} from "../lib/walletSession";

export interface WalletState {
  publicKey: string | null;
  isConnected: boolean;
  isInitializing: boolean;
  kit: StellarWalletsKit | null;
  networkWarning?: string | null;
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

/**
 * Read the wallet's network and fold it into the wallet session (#750).
 * Returns the warning to show, or null when the networks match.
 */
async function syncWalletNetwork(account: string | null): Promise<string | null> {
  const passphrase = resolveWalletPassphrase(await getFreighterNetworkDetails());
  walletSession.sync(account, passphrase);
  return networkWarningFor(passphrase);
}

function networkWarningFor(passphrase: string | null): string | null {
  if (!passphrase || passphrase === APP_NETWORK_PASSPHRASE) return null;
  return `Your wallet is on ${networkLabel(passphrase)}, but this app uses ${networkLabel(APP_NETWORK_PASSPHRASE)}. Voting and payments are blocked until you switch networks in your wallet.`;
}

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
    networkWarning: null,
  });

  useEffect(() => {
    let unlistenAccount: (() => void) | null = null;
    let unlistenNetwork: (() => void) | null = null;

    if (wallet.isConnected) {
      unlistenAccount = listenToAccountChange((newAccount) => {
        // The wallet session bumps its generation and clears the query
        // caches, so data for the previous account cannot leak (#755, #750).
        walletSession.sync(newAccount);
        if (!newAccount) {
          setWallet((prev) => ({
            ...prev,
            publicKey: null,
            isConnected: false,
          }));
        } else {
          setWallet((prev) => ({
            ...prev,
            publicKey: newAccount,
            isConnected: true,
          }));
        }
      });

      // Compare passphrases, not names: Freighter reports "TESTNET", which no
      // passphrase contains, so the old substring check warned on the right
      // network and was dismissed as noise (#750).
      unlistenNetwork = listenToNetworkChange((net) => {
        void (async () => {
          const details = await getFreighterNetworkDetails();
          const passphrase = resolveWalletPassphrase(
            details ?? (net ? { network: net } : null),
          );
          walletSession.sync(walletSession.getState().account, passphrase);
          setWallet((prev) => ({
            ...prev,
            networkWarning: networkWarningFor(passphrase),
          }));
        })();
      });
    }

    return () => {
      if (unlistenAccount) unlistenAccount();
      if (unlistenNetwork) unlistenNetwork();
    };
  }, [wallet.isConnected]);

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
          const networkWarning = await syncWalletNetwork(address);
          setWallet({
            publicKey: address,
            isConnected: true,
            isInitializing: false,
            kit: globalKit,
            networkWarning,
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
          persistConnectionIntent(true);
          const networkWarning = await syncWalletNetwork(address);

          setWallet({
            publicKey: address,
            isConnected: true,
            isInitializing: false,
            kit: globalKit,
            networkWarning,
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
    persistConnectionIntent(false);
    // Ends the session: revokes the relayer session and clears query caches.
    walletSession.end();
    clearAllStores();

    // Clear all identity and cryptographic secrets from localStorage
    const secretKeyPatterns = [
      "zkvote_hd_master_secret",
      "identity_secret",
      "private_key",
      "secret",
      "mnemonic",
    ];

    // Clear all Stellar Wallets Kit localStorage entries
    // The library stores data with keys prefixed with "SWK" or containing "stellar"
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        Object.keys(localStorage).forEach((key) => {
          const keyLower = key.toLowerCase();
          if (
            key.startsWith("SWK") ||
            keyLower.includes("stellar") ||
            keyLower.includes("wallet") ||
            keyLower.includes("freighter") ||
            keyLower.includes("albedo") ||
            keyLower.includes("xbull") ||
            secretKeyPatterns.some((pattern) => keyLower.includes(pattern.toLowerCase()))
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
