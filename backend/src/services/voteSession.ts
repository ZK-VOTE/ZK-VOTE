/**
 * Vote sessions (#750 / SPIKE-080)
 *
 * Binds a vote submission to the wallet session it was built in, without
 * linking the wallet to the anonymous ballot (#644).
 *
 * The browser generates a random 32-byte key per wallet session (one
 * generation of account + network) and registers it here. No wallet address,
 * signature or IP is stored: a session is an unlinkable random id. Each /vote
 * then carries the session id and an HMAC over the vote's public fields. When
 * the wallet disconnects, switches account or switches network, the browser
 * revokes the session, so anything built or captured under it is rejected:
 *
 *   - unknown, expired or revoked session  -> 401 VOTE_SESSION_STALE
 *   - MAC over different fields / key      -> 401 VOTE_SESSION_INVALID
 *   - session registered for other network -> 409 NETWORK_MISMATCH
 *
 * What this does NOT stop: someone with live access to the wallet can derive
 * the voting credentials (zk.ts) and register their own session. For that
 * case the store remembers which session spent each nullifier, so the
 * victim's later submission gets a conflict that says a different session
 * used it (detection, not prevention). See docs/wallet-session-contract.md.
 */

import crypto from "node:crypto";

export const VOTE_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
/** Bound memory: oldest sessions are evicted past this many. */
export const MAX_VOTE_SESSIONS = 50_000;
const NULLIFIER_OWNER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_NULLIFIER_OWNERS = 100_000;

export const VOTE_MAC_DOMAIN = "zkvote-vote-session-v1";

interface VoteSession {
  key: Uint8Array;
  networkHash: string;
  expiresAt: number;
  revoked: boolean;
}

const sessions = new Map<string, VoteSession>();
const nullifierOwners = new Map<
  string,
  { sessionId: string; expiresAt: number }
>();

/** SHA-256 hex of a network passphrase: what clients send and sessions store. */
export function networkHash(passphrase: string): string {
  return crypto.createHash("sha256").update(passphrase, "utf8").digest("hex");
}

export interface VoteBindingFields {
  daoId: number;
  proposalId: number;
  choice: boolean;
  nullifier: string;
  root: string;
}

/** The exact string the client MACs. Field order and format are the contract. */
export function canonicalVoteBinding(
  fields: VoteBindingFields,
  netHash: string,
): string {
  return [
    VOTE_MAC_DOMAIN,
    String(fields.daoId),
    String(fields.proposalId),
    fields.choice ? "1" : "0",
    String(fields.nullifier).toLowerCase(),
    String(fields.root).toLowerCase(),
    netHash,
  ].join("\n");
}

function evictIfFull<V>(map: Map<string, V>, max: number): void {
  // Maps iterate in insertion order, so the first key is the oldest.
  while (map.size >= max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export type CreateSessionResult =
  | { ok: true; sessionId: string; expiresAt: number }
  | { ok: false; code: "INVALID_SESSION_KEY" | "NETWORK_MISMATCH" };

export function createVoteSession(
  keyB64: unknown,
  clientNetworkHash: unknown,
  serverPassphrase: string,
  now = Date.now(),
): CreateSessionResult {
  if (typeof keyB64 !== "string")
    return { ok: false, code: "INVALID_SESSION_KEY" };
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32 || key.toString("base64") !== keyB64) {
    return { ok: false, code: "INVALID_SESSION_KEY" };
  }
  const serverHash = networkHash(serverPassphrase);
  if (clientNetworkHash !== serverHash)
    return { ok: false, code: "NETWORK_MISMATCH" };

  evictIfFull(sessions, MAX_VOTE_SESSIONS);
  const sessionId = crypto.randomBytes(16).toString("hex");
  const expiresAt = now + VOTE_SESSION_TTL_MS;
  sessions.set(sessionId, {
    key: new Uint8Array(key),
    networkHash: serverHash,
    expiresAt,
    revoked: false,
  });
  return { ok: true, sessionId, expiresAt };
}

/** Idempotent. The tombstone is kept until expiry so a stale id reads as stale. */
export function revokeVoteSession(sessionId: unknown): void {
  if (typeof sessionId !== "string") return;
  const session = sessions.get(sessionId);
  if (session) session.revoked = true;
}

export type VerifyResult =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 409;
      code: "VOTE_SESSION_STALE" | "VOTE_SESSION_INVALID" | "NETWORK_MISMATCH";
    };

export function verifyVoteBinding(
  sessionId: unknown,
  macHex: unknown,
  clientNetworkHash: unknown,
  fields: VoteBindingFields,
  now = Date.now(),
): VerifyResult {
  const session =
    typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
  if (!session || session.revoked || session.expiresAt <= now) {
    return { ok: false, status: 401, code: "VOTE_SESSION_STALE" };
  }
  if (clientNetworkHash !== session.networkHash) {
    return { ok: false, status: 409, code: "NETWORK_MISMATCH" };
  }
  if (typeof macHex !== "string" || !/^[0-9a-f]{64}$/i.test(macHex)) {
    return { ok: false, status: 401, code: "VOTE_SESSION_INVALID" };
  }
  const expected = crypto
    .createHmac("sha256", session.key)
    .update(canonicalVoteBinding(fields, session.networkHash), "utf8")
    .digest();
  const given = Buffer.from(macHex, "hex");
  if (
    !crypto.timingSafeEqual(new Uint8Array(expected), new Uint8Array(given))
  ) {
    return { ok: false, status: 401, code: "VOTE_SESSION_INVALID" };
  }
  return { ok: true };
}

/** Remember which session spent a nullifier (only after the vote is accepted). */
export function recordNullifierOwner(
  nullifier: string,
  sessionId: string,
  now = Date.now(),
): void {
  const key = nullifier.toLowerCase();
  if (nullifierOwners.has(key)) return;
  evictIfFull(nullifierOwners, MAX_NULLIFIER_OWNERS);
  nullifierOwners.set(key, {
    sessionId,
    expiresAt: now + NULLIFIER_OWNER_TTL_MS,
  });
}

/**
 * "same_session" when this session spent the nullifier, "other_session" when
 * a different one did, null when unknown (expired, restarted, or submitted
 * without a session).
 */
export function nullifierSpender(
  nullifier: string,
  sessionId: string | undefined,
  now = Date.now(),
): "same_session" | "other_session" | null {
  const owner = nullifierOwners.get(nullifier.toLowerCase());
  if (!owner || owner.expiresAt <= now || !sessionId) return null;
  return owner.sessionId === sessionId ? "same_session" : "other_session";
}

/** Tests only. */
export function __resetVoteSessions(): void {
  sessions.clear();
  nullifierOwners.clear();
}
