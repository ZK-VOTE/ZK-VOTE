/**
 * Wallet session (#750): generations, network matching, cache invalidation,
 * and the queue's hold / resume / stale-session behaviour against a fake
 * relayer that implements the backend protocol (session registry + HMAC
 * check, as in backend/src/services/voteSession.ts).
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { createHash, createHmac } from "node:crypto";

vi.mock("./api", () => ({
  relayerFetch: vi.fn(),
  parseApiError: (data: { error?: unknown }) =>
    typeof data?.error === "string" ? data.error : "Unknown error",
  getApiErrorCode: () => undefined,
}));
vi.mock("./client", () => ({
  getZkVoteClient: () => ({ membershipTree: { root_ok: vi.fn().mockResolvedValue({ result: true }) } }),
}));
const clearAllQueryCaches = vi.fn();
vi.mock("./cacheInvalidation", () => ({ clearAllQueryCaches: () => clearAllQueryCaches() }));

const store: Record<string, string> = {};
Object.defineProperty(window, "localStorage", {
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => void (store[k] = v),
    removeItem: (k: string) => void delete store[k],
    clear: () => Object.keys(store).forEach((k) => delete store[k]),
    length: 0,
    key: () => null,
  },
  writable: true,
});

import { relayerFetch } from "./api";
import {
  APP_NETWORK_PASSPHRASE,
  __resetWalletSession,
  accountTag,
  resolveWalletPassphrase,
  walletSession,
  WalletSessionError,
} from "./walletSession";
import { CREDENTIAL_COLLISION_MESSAGE, processEntry } from "./queueProcessor";
import { submissionQueue, type VotePayload } from "../store/submissionQueue";

const FUTURENET = "Test SDF Future Network ; October 2022";
const VICTIM = "GVICTIM" + "A".repeat(49);
const OTHER = "GOTHER" + "B".repeat(50);

// ── Fake relayer ─────────────────────────────────────────────────────────────

const relayer = {
  sessions: new Map<string, { key: Buffer; revoked: boolean }>(),
  spentBy: new Map<string, string>(),
  votes: [] as Array<{ nullifier: string; session: string }>,
  reset() {
    this.sessions.clear();
    this.spentBy.clear();
    this.votes = [];
  },
  /** Simulate a relayer restart: every session is forgotten. */
  restart() {
    this.sessions.clear();
  },
};
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function json(status: number, body: unknown) {
  return { ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

(relayerFetch as Mock).mockImplementation(async (path: string, init: RequestInit = {}) => {
  const body = init.body ? JSON.parse(String(init.body)) : {};
  const headers = (init.headers ?? {}) as Record<string, string>;
  if (path === "/vote-session") {
    if (body.network !== sha256(APP_NETWORK_PASSPHRASE)) return json(409, { code: "NETWORK_MISMATCH" });
    const id = `s${relayer.sessions.size + 1}_${Math.random().toString(16).slice(2)}`;
    relayer.sessions.set(id, { key: Buffer.from(body.key, "base64"), revoked: false });
    return json(201, { sessionId: id });
  }
  if (path === "/vote-session/revoke") {
    const s = relayer.sessions.get(body.sessionId);
    if (s) s.revoked = true;
    return json(204, {});
  }
  if (path === "/vote") {
    const id = headers["X-Vote-Session"];
    const s = id ? relayer.sessions.get(id) : undefined;
    if (!s || s.revoked) return json(401, { error: "stale", code: "VOTE_SESSION_STALE" });
    const canonical = [
      "zkvote-vote-session-v1",
      body.daoId,
      body.proposalId,
      body.choice ? "1" : "0",
      body.nullifier.toLowerCase(),
      body.root.toLowerCase(),
      sha256(APP_NETWORK_PASSPHRASE),
    ].join("\n");
    const mac = createHmac("sha256", s.key).update(canonical).digest("hex");
    if (headers["X-Vote-Session-Mac"] !== mac) return json(401, { error: "bad mac", code: "VOTE_SESSION_INVALID" });
    const owner = relayer.spentBy.get(body.nullifier);
    if (owner) {
      return json(409, {
        status: "CONFLICT",
        error: "Nullifier already used",
        conflictSource: owner === id ? "same_session" : "other_session",
      });
    }
    relayer.spentBy.set(body.nullifier, id);
    relayer.votes.push({ nullifier: body.nullifier, session: id });
    return json(200, { success: true, txHash: "ab".repeat(32) });
  }
  throw new Error(`unexpected ${path}`);
});

function payload(nullifier: string): VotePayload {
  return {
    daoId: 1,
    proposalId: 2,
    choice: true,
    nullifier,
    root: "0f".repeat(32),
    proof: { a: "00", b: "00", c: "00" },
    timestamp: Date.now(),
  };
}

async function enqueueBoundTo(account: string, nullifier: string) {
  walletSession.sync(account, APP_NETWORK_PASSPHRASE);
  const binding = await walletSession.currentBinding();
  return submissionQueue.enqueue(payload(nullifier), binding);
}

const entry = (id: string) => submissionQueue.getState().entries[id];

beforeEach(() => {
  __resetWalletSession();
  submissionQueue.clearAll();
  relayer.reset();
  clearAllQueryCaches.mockClear();
});

// ── Session state ───────────────────────────────────────────────────────────

describe("walletSession", () => {
  it("bumps the generation only on a real change (several useWallet instances report the same event)", () => {
    walletSession.sync(VICTIM, APP_NETWORK_PASSPHRASE);
    const g = walletSession.getState().generation;
    walletSession.sync(VICTIM, APP_NETWORK_PASSPHRASE);
    walletSession.sync(VICTIM);
    expect(walletSession.getState().generation).toBe(g);
    walletSession.sync(OTHER);
    expect(walletSession.getState().generation).toBe(g + 1);
  });

  it("clears query caches on every account, network and disconnect change", () => {
    walletSession.sync(VICTIM, APP_NETWORK_PASSPHRASE);
    walletSession.sync(OTHER);
    walletSession.sync(OTHER, FUTURENET);
    walletSession.end();
    expect(clearAllQueryCaches).toHaveBeenCalledTimes(4);
  });

  it("compares networks by passphrase; Freighter's TESTNET name matches the testnet app", () => {
    expect(resolveWalletPassphrase({ network: "TESTNET" })).toBe(APP_NETWORK_PASSPHRASE);
    expect(resolveWalletPassphrase({ network: "testnet" })).toBe(APP_NETWORK_PASSPHRASE);
    expect(resolveWalletPassphrase({ network: "FUTURENET" })).toBe(FUTURENET);
    expect(resolveWalletPassphrase({ network: "MyLocalNet" })).not.toBe(APP_NETWORK_PASSPHRASE);
    walletSession.sync(VICTIM, resolveWalletPassphrase({ network: "TESTNET" }));
    expect(walletSession.getState().status).toBe("active");
    walletSession.sync(VICTIM, resolveWalletPassphrase({ network: "FUTURENET" }));
    expect(walletSession.getState().status).toBe("network_mismatch");
  });

  it("assertCanBuild blocks other accounts, disconnects and network mismatches", () => {
    expect(() => walletSession.assertCanBuild(VICTIM)).toThrow(WalletSessionError);
    walletSession.sync(VICTIM, FUTURENET);
    expect(() => walletSession.assertCanBuild(VICTIM)).toThrow(/futurenet/);
    walletSession.sync(VICTIM, APP_NETWORK_PASSPHRASE);
    expect(() => walletSession.assertCanBuild(OTHER)).toThrow(/switched/);
    expect(() => walletSession.assertCanBuild(VICTIM)).not.toThrow();
  });

  it("changeSince distinguishes a same-account reconnect from a switch", () => {
    walletSession.sync(VICTIM, APP_NETWORK_PASSPHRASE);
    const snap = walletSession.snapshot();
    walletSession.end();
    expect(walletSession.changeSince(snap)).toBe("disconnected");
    walletSession.sync(VICTIM, APP_NETWORK_PASSPHRASE);
    expect(walletSession.changeSince(snap)).toBe("reconnected");
    walletSession.sync(OTHER);
    expect(walletSession.changeSince(snap)).toBe("account_changed");
  });

  it("verifyLiveAccount catches a silent switch in wallets without events (xBull, Albedo)", async () => {
    walletSession.sync(VICTIM, APP_NETWORK_PASSPHRASE);
    await walletSession.verifyLiveAccount({ getAddress: async () => ({ address: OTHER }) });
    expect(walletSession.getState().account).toBe(OTHER);
    await walletSession.verifyLiveAccount({ getAddress: async () => Promise.reject(new Error("locked")) });
    expect(walletSession.getState().status).toBe("disconnected");
  });

  it("persists only a hashed account tag, never the address", async () => {
    const e = await enqueueBoundTo(VICTIM, "11".repeat(32));
    expect(e.binding?.accountTag).toBe(await accountTag(VICTIM));
    expect(JSON.stringify(e)).not.toContain(VICTIM);
  });
});

// ── Queue: hold, resume, staleness ──────────────────────────────────────────

describe("queue + wallet session", () => {
  it("submits a bound vote with a MAC the relayer accepts", async () => {
    const e = await enqueueBoundTo(VICTIM, "21".repeat(32));
    await processEntry(e);
    expect(entry(e.id).status).toBe("submitted");
    expect(relayer.votes).toHaveLength(1);
  });

  it("holds a vote while another account is connected and resumes when its account returns", async () => {
    const e = await enqueueBoundTo(VICTIM, "31".repeat(32));
    walletSession.sync(OTHER);
    await processEntry(entry(e.id));
    expect(entry(e.id).status).toBe("pending");
    expect(entry(e.id).heldReason).toMatch(/different wallet account/);
    expect(entry(e.id).attempts).toBe(0);
    expect(relayer.votes).toHaveLength(0);

    walletSession.sync(VICTIM);
    await processEntry(entry(e.id));
    expect(entry(e.id).status).toBe("submitted");
    expect(entry(e.id).heldReason).toBeNull();
  });

  it("holds during a network mismatch and while disconnected", async () => {
    const e = await enqueueBoundTo(VICTIM, "41".repeat(32));
    walletSession.sync(VICTIM, FUTURENET);
    await processEntry(entry(e.id));
    expect(entry(e.id).heldReason).toMatch(/Switch your wallet back to testnet/);
    walletSession.end();
    await processEntry(entry(e.id));
    expect(entry(e.id).heldReason).toMatch(/Reconnect/);
    expect(relayer.votes).toHaveLength(0);
  });

  it("revokes the relayer session on every change, so headers captured before it are stale", async () => {
    walletSession.sync(VICTIM, APP_NETWORK_PASSPHRASE);
    const p = payload("51".repeat(32));
    const captured = await walletSession.voteHeaders(p);
    walletSession.end(); // victim disconnects; an attacker kept the headers
    await Promise.resolve();
    const replay = await (relayerFetch as Mock)("/vote", { body: JSON.stringify(p), headers: captured });
    expect(replay.status).toBe(401);
    expect((await replay.json()).code).toBe("VOTE_SESSION_STALE");
  });

  it("re-opens the relayer session after a restart instead of failing the vote", async () => {
    const e = await enqueueBoundTo(VICTIM, "61".repeat(32));
    await walletSession.voteHeaders(e.payload); // session opened
    relayer.restart();
    await processEntry(entry(e.id));
    expect(entry(e.id).status).toBe("pending"); // retryable, not failed
    submissionQueue.getState().entries[e.id].retryAfter = null;
    await processEntry(entry(e.id));
    expect(entry(e.id).status).toBe("submitted");
  });

  it("resume never double-votes: a second submit of the same nullifier is a conflict, not a new vote", async () => {
    const e = await enqueueBoundTo(VICTIM, "71".repeat(32));
    await processEntry(e);
    const again = submissionQueue.enqueue(payload("71".repeat(32)), e.binding);
    expect(again.status).toBe("submitted"); // enqueue is idempotent by nullifier
    expect(relayer.votes).toHaveLength(1);
  });

  it("Tier-1: the victim is told when someone else spent their nullifier first", async () => {
    const nullifier = "81".repeat(32);
    // Attacker with the victim's credentials, in their own session.
    walletSession.sync(OTHER, APP_NETWORK_PASSPHRASE);
    const stolen = payload(nullifier);
    stolen.choice = false;
    await (relayerFetch as Mock)("/vote", {
      body: JSON.stringify(stolen),
      headers: await walletSession.voteHeaders(stolen),
    });

    const e = await enqueueBoundTo(VICTIM, nullifier);
    await processEntry(e);
    expect(entry(e.id).status).toBe("conflict");
    expect(entry(e.id).conflictDetail).toBe(CREDENTIAL_COLLISION_MESSAGE);
  });

  it("disconnect keeps unsent proofs and drops settled history", async () => {
    const sent = await enqueueBoundTo(VICTIM, "91".repeat(32));
    await processEntry(sent);
    const unsent = await enqueueBoundTo(VICTIM, "92".repeat(32));
    walletSession.end();
    submissionQueue.clearSettled();
    expect(entry(sent.id)).toBeUndefined();
    expect(entry(unsent.id)?.status).toBe("pending");
  });
});
