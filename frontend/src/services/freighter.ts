/**
 * Freighter wallet integration service handling edge cases:
 * - Installation detection
 * - User rejection
 * - Locked wallet prompt
 * - Account & network change listeners
 * - Connection intent persistence
 */

export interface FreighterApi {
  isConnected: () => Promise<boolean> | boolean;
  isAllowed: () => Promise<boolean>;
  getUserInfo: () => Promise<{ publicKey: string }>;
  getPublicKey: () => Promise<string>;
  getNetwork: () => Promise<string>;
  getNetworkDetails: () => Promise<{ network: string; networkUrl: string; networkPassphrase: string }>;
  requestAccess: () => Promise<string>;
  signTransaction?: (xdr: string, opts?: { networkPassphrase?: string }) => Promise<string>;
  isLocked?: () => Promise<boolean>;
  onAccountChange?: (callback: (account: string) => void) => { remove: () => void } | void;
  onNetworkChange?: (callback: (network: string) => void) => { remove: () => void } | void;
}

declare global {
  interface Window {
    freighter?: FreighterApi;
    stellar?: {
      freighter?: FreighterApi;
    };
  }
}

export const FREIGHTER_INSTALL_URL = "https://www.freighter.app/";

export function getFreighterProvider(): FreighterApi | null {
  if (typeof window === "undefined") return null;
  if (window.freighter) return window.freighter;
  if (window.stellar?.freighter) return window.stellar.freighter;
  return null;
}

export function isFreighterInstalled(): boolean {
  return getFreighterProvider() !== null;
}

export async function isFreighterLocked(): Promise<boolean> {
  const provider = getFreighterProvider();
  if (!provider) return false;
  try {
    if (provider.isLocked) {
      return await provider.isLocked();
    }
  } catch {
    // ignore error checking locked status
  }
  return false;
}

export async function getFreighterNetworkDetails(): Promise<{
  network: string;
  networkPassphrase?: string;
} | null> {
  const provider = getFreighterProvider();
  if (!provider) return null;
  try {
    if (provider.getNetworkDetails) {
      const details = await provider.getNetworkDetails();
      return {
        network: details.network,
        networkPassphrase: details.networkPassphrase,
      };
    }
    if (provider.getNetwork) {
      const network = await provider.getNetwork();
      return { network };
    }
  } catch {
    // ignore error
  }
  return null;
}

export async function connectFreighter(): Promise<string> {
  if (!isFreighterInstalled()) {
    throw new Error(
      `Freighter is not installed. Please install Freighter from ${FREIGHTER_INSTALL_URL}`
    );
  }

  const locked = await isFreighterLocked();
  if (locked) {
    throw new Error(
      "Freighter wallet is locked. Please unlock your Freighter wallet and try again."
    );
  }

  const provider = getFreighterProvider()!;

  try {
    let publicKey = "";
    if (provider.requestAccess) {
      const res = await provider.requestAccess();
      if (typeof res === "string") {
        publicKey = res;
      }
    }
    if (!publicKey && provider.getPublicKey) {
      publicKey = await provider.getPublicKey();
    }

    if (!publicKey) {
      throw new Error("User declined access or no public key returned.");
    }

    persistConnectionIntent(true);
    return publicKey;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (
      msg.toLowerCase().includes("declined") ||
      msg.toLowerCase().includes("user rejected") ||
      msg.toLowerCase().includes("cancel") ||
      msg.toLowerCase().includes("rejected")
    ) {
      throw new Error("Connection request declined by user.");
    }
    if (msg.toLowerCase().includes("locked")) {
      throw new Error("Freighter wallet is locked. Please unlock Freighter and try again.");
    }
    throw new Error(msg || "Failed to connect to Freighter.");
  }
}

const CONNECTION_INTENT_KEY = "freighter_connection_intent";

export function persistConnectionIntent(hasIntent: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (hasIntent) {
      localStorage.setItem(CONNECTION_INTENT_KEY, "true");
    } else {
      localStorage.removeItem(CONNECTION_INTENT_KEY);
    }
  } catch {
    // ignore storage error
  }
}

export function hasConnectionIntent(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(CONNECTION_INTENT_KEY) === "true";
  } catch {
    return false;
  }
}

export function listenToAccountChange(callback: (account: string | null) => void): () => void {
  const provider = getFreighterProvider();
  let currentAccount = "";

  if (provider?.onAccountChange) {
    try {
      const sub = provider.onAccountChange((newAcc) => {
        callback(newAcc || null);
      });
      if (sub && typeof sub.remove === "function") {
        return () => sub.remove();
      }
    } catch {
      // Fallback to polling
    }
  }

  const interval = setInterval(async () => {
    const currentProvider = getFreighterProvider();
    if (!currentProvider) return;
    try {
      if (currentProvider.getPublicKey) {
        const key = await currentProvider.getPublicKey();
        if (key !== currentAccount) {
          currentAccount = key;
          callback(key || null);
        }
      }
    } catch {
      // ignore polling errors
    }
  }, 2000);

  return () => clearInterval(interval);
}

export function listenToNetworkChange(callback: (network: string | null) => void): () => void {
  const provider = getFreighterProvider();
  let currentNetwork = "";

  if (provider?.onNetworkChange) {
    try {
      const sub = provider.onNetworkChange((net) => {
        callback(net || null);
      });
      if (sub && typeof sub.remove === "function") {
        return () => sub.remove();
      }
    } catch {
      // Fallback to polling
    }
  }

  const interval = setInterval(async () => {
    const netDetails = await getFreighterNetworkDetails();
    const net = netDetails?.network || "";
    if (net !== currentNetwork) {
      currentNetwork = net;
      callback(net || null);
    }
  }, 3000);

  return () => clearInterval(interval);
}

/**
 * Sign a vote payload using the voter's Stellar keypair via Freighter.
 *
 * We build a minimal ManageData transaction whose operation value is the
 * first 28 bytes of SHA-256(payload).  Freighter signs it and returns the
 * signed XDR.  We hand that XDR back to the backend, which re-derives the
 * same transaction hash and verifies the ed25519 signature against the
 * voter's public key.
 */
export async function signVotePayload(
  payload: string,
  publicKey: string,
  networkPassphrase: string,
): Promise<string> {
  const provider = getFreighterProvider();
  if (!provider || !provider.signTransaction) {
    throw new Error("Freighter does not support transaction signing");
  }

  const { Account, TransactionBuilder, Operation, hash } =
    await import("@stellar/stellar-sdk");

  // hash() is SHA-256 from stellar-sdk, returns a Buffer
  const payloadHash = hash(Buffer.from(payload, "utf8"));

  // Dummy account — sequence 0, only used to build the tx structure
  const account = new Account(publicKey, "0");

  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(
      Operation.manageData({
        name: "vote_sig",
        value: payloadHash.slice(0, 28), // ManageData value max 28 bytes
      }),
    )
    .setTimeout(0)
    .build();

  // Freighter signs and returns the signed XDR string
  const signedXdr = await provider.signTransaction(tx.toXDR(), {
    networkPassphrase,
  });

  return signedXdr;
}
