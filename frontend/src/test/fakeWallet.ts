/**
 * Scripted wallet for tests (#750): drive account switches, network
 * switches, lock/unlock and disconnects the way real wallets deliver them.
 *
 * Two delivery modes, matching services/freighter.ts:
 *   "events"  — Freighter versions with onAccountChange / onNetworkChange
 *   "polling" — no event API; the app polls getPublicKey every 2 s and
 *               getNetworkDetails every 3 s
 *
 * The kit side (what StellarWalletsKit.getAddress returns) is exposed as
 * `kitAddress()` so a mocked kit can answer from the same state; that is how
 * a module that lies about the account (malicious xBull/Albedo build) is
 * scripted: `wallet.kitOverride("G...")`.
 */

import type { FreighterApi } from "../services/freighter";

const PASSPHRASES: Record<string, string> = {
  TESTNET: "Test SDF Network ; September 2015",
  FUTURENET: "Test SDF Future Network ; October 2022",
  PUBLIC: "Public Global Stellar Network ; September 2015",
};

export interface FakeWalletOptions {
  account: string;
  network?: keyof typeof PASSPHRASES;
  mode?: "events" | "polling";
}

export interface FakeWallet {
  switchAccount(account: string): void;
  switchNetwork(network: keyof typeof PASSPHRASES): void;
  /** Locked Freighter reports no account. */
  lock(): void;
  unlock(): void;
  /** What the kit's getAddress answers; throws while locked. */
  kitAddress(): Promise<{ address: string }>;
  /** Make the kit report a different account than the extension (malicious module). */
  kitOverride(account: string | null): void;
  uninstall(): void;
}

export function installFakeWallet(opts: FakeWalletOptions): FakeWallet {
  let account = opts.account;
  let network: keyof typeof PASSPHRASES = opts.network ?? "TESTNET";
  let locked = false;
  let kitAccount: string | null = null;
  const accountListeners = new Set<(a: string) => void>();
  const networkListeners = new Set<(n: string) => void>();
  const events = (opts.mode ?? "events") === "events";

  const provider: FreighterApi = {
    isConnected: () => true,
    isAllowed: async () => true,
    getUserInfo: async () => ({ publicKey: locked ? "" : account }),
    getPublicKey: async () => (locked ? "" : account),
    getNetwork: async () => network,
    getNetworkDetails: async () => ({
      network,
      networkUrl: "https://example.invalid",
      networkPassphrase: PASSPHRASES[network],
    }),
    requestAccess: async () => account,
    isLocked: async () => locked,
    ...(events
      ? {
          onAccountChange: (cb: (a: string) => void) => {
            accountListeners.add(cb);
            return { remove: () => accountListeners.delete(cb) };
          },
          onNetworkChange: (cb: (n: string) => void) => {
            networkListeners.add(cb);
            return { remove: () => networkListeners.delete(cb) };
          },
        }
      : {}),
  };
  window.freighter = provider;

  const emitAccount = () =>
    accountListeners.forEach((cb) => cb(locked ? "" : account));

  return {
    switchAccount(next) {
      account = next;
      emitAccount();
    },
    switchNetwork(next) {
      network = next;
      networkListeners.forEach((cb) => cb(next));
    },
    lock() {
      locked = true;
      emitAccount();
    },
    unlock() {
      locked = false;
      emitAccount();
    },
    async kitAddress() {
      if (locked) throw new Error("Wallet is locked");
      return { address: kitAccount ?? account };
    },
    kitOverride(next) {
      kitAccount = next;
    },
    uninstall() {
      delete window.freighter;
      accountListeners.clear();
      networkListeners.clear();
    },
  };
}
