/**
 * Wallet session (#750 / SPIKE-080)
 *
 * One module-level source of truth for "which account, on which network, in
 * which generation". Several components call useWallet() and each gets its own
 * React state, so the session cannot live in a hook.
 *
 *  - generation: bumps whenever the account or network changes or the wallet
 *    disconnects. Long flows (a 60 s proof, a quote) snapshot it at the start
 *    and check it before acting.
 *  - network: compared by passphrase, exactly. A mismatch blocks building,
 *    submitting and confirming; it is not a dismissible banner.
 *  - binding: proofs are bound to (account tag, network). A proof built under
 *    account A is held, never submitted, while account B is connected, and is
 *    resumed when A reconnects on the right network. No re-prove, and the
 *    nullifier keeps it from counting twice.
 *  - server session: a random HMAC key registered with the relayer (no wallet
 *    address, #644). Every /vote is MACed with it; it is revoked on every
 *    generation change, so anything captured under an old session is rejected
 *    server-side. See backend/src/services/voteSession.ts.
 *
 * Every generation change also clears the React Query caches, so data fetched
 * for the previous account or network cannot be read under the new one.
 */

import { NETWORK_CONFIG } from "../config/contracts";
import { clearAllQueryCaches } from "./cacheInvalidation";
import { relayerFetch } from "./api";

// ============================================================
// Networks
// ============================================================

/** Freighter reports a network name; map it to the passphrase we compare. */
const NETWORK_PASSPHRASES: Record<string, string> = {
  PUBLIC: "Public Global Stellar Network ; September 2015",
  MAINNET: "Public Global Stellar Network ; September 2015",
  TESTNET: "Test SDF Network ; September 2015",
  FUTURENET: "Test SDF Future Network ; October 2022",
  STANDALONE: "Standalone Network ; February 2017",
  LOCAL: "Standalone Network ; February 2017",
};

export const APP_NETWORK_PASSPHRASE: string = NETWORK_CONFIG.networkPassphrase;

/**
 * Resolve what the wallet reports into a passphrase. Returns null when the
 * wallet does not say (xBull, Albedo): those sign for the network the kit was
 * created with, which is the app's.
 */
export function resolveWalletPassphrase(
  details: {
    network?: string | null;
    networkPassphrase?: string | null;
  } | null,
): string | null {
  if (!details) return null;
  if (details.networkPassphrase) return details.networkPassphrase;
  if (!details.network) return null;
  const byName = NETWORK_PASSPHRASES[details.network.trim().toUpperCase()];
  // An unknown name is a custom network: never equal to ours by accident.
  return byName ?? `unknown:${details.network}`;
}

export function networkLabel(passphrase: string | null): string {
  if (!passphrase) return "unknown network";
  const name = Object.entries(NETWORK_PASSPHRASES).find(
    ([, p]) => p === passphrase,
  )?.[0];
  return name ? name.toLowerCase() : passphrase.replace(/^unknown:/, "");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** What the relayer compares: SHA-256 of the passphrase. */
export function networkHash(passphrase: string): Promise<string> {
  return sha256Hex(passphrase);
}

/**
 * Persisted instead of the address, so a queued proof can be matched to its
 * account without writing the raw key next to the ballot (#644).
 */
export async function accountTag(account: string): Promise<string> {
  return (await sha256Hex(`zkvote-account-tag-v1:${account}`)).slice(0, 32);
}

// ============================================================
// Session state
// ============================================================

export type WalletSessionStatus =
  | "disconnected"
  | "active"
  | "network_mismatch";

export interface WalletSessionState {
  generation: number;
  account: string | null;
  /** Passphrase the wallet reported; null = wallet does not report one. */
  walletPassphrase: string | null;
  status: WalletSessionStatus;
}

export interface SessionSnapshot {
  generation: number;
  account: string | null;
}

/** Why a snapshot is no longer valid. "reconnected" = same account, safe to continue. */
export type SessionChange =
  | "account_changed"
  | "disconnected"
  | "network_mismatch"
  | "reconnected";

export class WalletSessionError extends Error {
  readonly kind: Exclude<SessionChange, "reconnected">;

  constructor(kind: Exclude<SessionChange, "reconnected">, message: string) {
    super(message);
    this.name = "WalletSessionError";
    this.kind = kind;
  }
}

let state: WalletSessionState = {
  generation: 0,
  account: null,
  walletPassphrase: null,
  status: "disconnected",
};

interface ServerSession {
  id: string;
  key: CryptoKey;
  generation: number;
}
let serverSession: ServerSession | null = null;
let pendingServerSession: Promise<ServerSession> | null = null;

const listeners = new Set<() => void>();

function computeStatus(
  account: string | null,
  passphrase: string | null,
): WalletSessionStatus {
  if (!account) return "disconnected";
  if (passphrase && passphrase !== APP_NETWORK_PASSPHRASE)
    return "network_mismatch";
  return "active";
}

function revokeServerSession(): void {
  const old = serverSession;
  serverSession = null;
  pendingServerSession = null;
  if (!old) return;
  // Fire and forget: a failed revoke still leaves the id unused by us, and it
  // expires server-side.
  void relayerFetch("/vote-session/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: old.id }),
    maxRetries: 1,
  }).catch(() => undefined);
}

function setState(next: WalletSessionState): void {
  const changed =
    next.account !== state.account ||
    next.walletPassphrase !== state.walletPassphrase ||
    next.status !== state.status;
  if (!changed) return;
  state = { ...next, generation: state.generation + 1 };
  revokeServerSession();
  void clearAllQueryCaches();
  listeners.forEach((l) => l());
}

export const walletSession = {
  getState(): WalletSessionState {
    return state;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /**
   * Report what the wallet says now. Idempotent: every useWallet instance
   * may call it for the same event; only a real change bumps the generation.
   * `walletPassphrase: undefined` keeps the last known network.
   */
  sync(account: string | null, walletPassphrase?: string | null): void {
    const passphrase =
      walletPassphrase === undefined
        ? account
          ? state.walletPassphrase
          : null
        : walletPassphrase;
    setState({
      generation: state.generation,
      account: account || null,
      walletPassphrase: account ? passphrase : null,
      status: computeStatus(account || null, account ? passphrase : null),
    });
  },

  end(): void {
    this.sync(null, null);
  },

  snapshot(): SessionSnapshot {
    return { generation: state.generation, account: state.account };
  },

  /** null while the snapshot is still the live session. */
  changeSince(snap: SessionSnapshot): SessionChange | null {
    if (state.generation === snap.generation) return null;
    if (state.status === "disconnected") return "disconnected";
    if (state.account !== snap.account) return "account_changed";
    if (state.status === "network_mismatch") return "network_mismatch";
    return "reconnected";
  },

  /** Throws unless `account` is connected on the app's network. */
  assertCanBuild(account: string): void {
    if (state.status === "disconnected" || state.account !== account) {
      throw new WalletSessionError(
        state.status === "disconnected" ? "disconnected" : "account_changed",
        state.status === "disconnected"
          ? "Your wallet is disconnected. Reconnect it to continue."
          : `Your wallet switched to ${shortAccount(state.account)}. Reopen this dialog to continue with that account.`,
      );
    }
    if (state.status === "network_mismatch") {
      throw new WalletSessionError(
        "network_mismatch",
        `Your wallet is on ${networkLabel(state.walletPassphrase)}, but this app uses ${networkLabel(APP_NETWORK_PASSPHRASE)}. Switch networks in your wallet, then try again.`,
      );
    }
  },

  /** Throws if the snapshot's session has been replaced by a different account, network or a disconnect. */
  checkpoint(snap: SessionSnapshot): void {
    const change = this.changeSince(snap);
    if (!change || change === "reconnected") return;
    throw new WalletSessionError(change, describeChange(change, snap.account));
  },

  /** The binding a proof built now carries in the queue. */
  async currentBinding(): Promise<VoteBinding | null> {
    if (state.status !== "active" || !state.account) return null;
    return {
      accountTag: await accountTag(state.account),
      network: await networkHash(APP_NETWORK_PASSPHRASE),
    };
  },

  /** Does the live session match a queued proof's binding? */
  async matches(binding: VoteBinding): Promise<boolean> {
    if (state.status !== "active" || !state.account) return false;
    return (
      binding.accountTag === (await accountTag(state.account)) &&
      binding.network === (await networkHash(APP_NETWORK_PASSPHRASE))
    );
  },

  /** Headers that bind one /vote request to the live server session. */
  async voteHeaders(
    fields: VoteBindingFields,
  ): Promise<Record<string, string>> {
    const session = await ensureServerSession();
    const net = await networkHash(APP_NETWORK_PASSPHRASE);
    const canonical = [
      "zkvote-vote-session-v1",
      String(fields.daoId),
      String(fields.proposalId),
      fields.choice ? "1" : "0",
      fields.nullifier.toLowerCase(),
      fields.root.toLowerCase(),
      net,
    ].join("\n");
    const mac = await crypto.subtle.sign(
      "HMAC",
      session.key,
      new TextEncoder().encode(canonical),
    );
    return {
      "X-Vote-Session": session.id,
      "X-Vote-Session-Mac": Array.from(new Uint8Array(mac), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
      "X-Vote-Network": net,
    };
  },

  /**
   * xBull and Albedo send no account events, so before anything is signed,
   * ask the wallet who it is now and fold the answer into the session.
   */
  async verifyLiveAccount(
    kit: { getAddress: () => Promise<{ address: string }> } | null,
  ): Promise<void> {
    if (!kit) return;
    let address: string | null = null;
    try {
      ({ address } = await kit.getAddress());
    } catch {
      address = null; // locked, or access revoked
    }
    if (address !== state.account) this.sync(address);
  },

  /** The relayer said the session is stale/unknown (restart, eviction): register a new one next time. */
  dropServerSession(): void {
    serverSession = null;
    pendingServerSession = null;
  },
};

export interface VoteBinding {
  accountTag: string;
  network: string;
}

export interface VoteBindingFields {
  daoId: number;
  proposalId: number;
  choice: boolean;
  nullifier: string;
  root: string;
}

async function ensureServerSession(): Promise<ServerSession> {
  if (state.status !== "active") {
    throw new WalletSessionError(
      state.status === "network_mismatch" ? "network_mismatch" : "disconnected",
      "No active wallet session to submit from.",
    );
  }
  const generation = state.generation;
  if (serverSession?.generation === generation) return serverSession;
  if (!pendingServerSession) {
    pendingServerSession = (async () => {
      const raw = crypto.getRandomValues(new Uint8Array(32));
      // The raw bytes go to the relayer once; locally the key is non-extractable.
      const key = await crypto.subtle.importKey(
        "raw",
        raw,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const res = await relayerFetch("/vote-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: btoa(String.fromCharCode(...raw)),
          network: await networkHash(APP_NETWORK_PASSPHRASE),
        }),
        maxRetries: 1,
      });
      raw.fill(0);
      const body = await res.json().catch(() => ({}));
      if (!res.ok || typeof body.sessionId !== "string") {
        throw new Error(
          body.error || `Could not open a vote session (HTTP ${res.status})`,
        );
      }
      const session = { id: body.sessionId as string, key, generation };
      // The wallet may have changed while we waited; never hand out a stale one.
      if (state.generation !== generation) {
        throw new WalletSessionError(
          "account_changed",
          "The wallet session changed. Try again.",
        );
      }
      serverSession = session;
      return session;
    })().finally(() => {
      pendingServerSession = null;
    });
  }
  return pendingServerSession;
}

export function shortAccount(account: string | null): string {
  return account
    ? `${account.slice(0, 4)}…${account.slice(-4)}`
    : "another account";
}

function describeChange(
  change: Exclude<SessionChange, "reconnected">,
  account: string | null,
): string {
  switch (change) {
    case "disconnected":
      return "Your wallet disconnected before your vote was ready. Nothing was submitted.";
    case "account_changed":
      return `Your wallet switched away from ${shortAccount(account)} before your vote was ready. Nothing was submitted.`;
    case "network_mismatch":
      return `Your wallet switched to ${networkLabel(state.walletPassphrase)}. Nothing was submitted; switch back to ${networkLabel(APP_NETWORK_PASSPHRASE)} to vote.`;
  }
}

/** Tests only. */
export function __resetWalletSession(): void {
  state = {
    generation: 0,
    account: null,
    walletPassphrase: null,
    status: "disconnected",
  };
  serverSession = null;
  pendingServerSession = null;
  listeners.clear();
}
