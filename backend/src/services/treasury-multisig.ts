/**
 * Treasury multisig signing sessions (ZV-039 / #888).
 *
 * The treasury's spends and signer rotations are enforced on chain by
 * contracts/threshold-crypto (`treasury_propose` → `treasury_approve` →
 * `treasury_execute`). This service coordinates the humans around one
 * proposal: it records which signers have signed the proposal's digest, tells
 * the signer dashboard when the contract's threshold is met, and writes every
 * step to the hash-chained audit log.
 *
 * A signature is a SEP-53 message signature (what wallets' `signMessage`
 * produces) over {@link approvalMessage}, which names the proposal id, its
 * digest and its expiry. The digest itself commits to the contract, nonce,
 * signer-set version, action and expiry, so a signature cannot be replayed
 * onto another proposal, another amount or a later expiry. The same rule as
 * the contract decides how many signatures are needed: `large_threshold` for
 * a spend above `large_amount` (dual control), `threshold` otherwise —
 * including for rotations, which therefore always need the current threshold.
 */
import crypto from "node:crypto";
import * as StellarSdk from "@stellar/stellar-sdk";
import type { Database as DatabaseType } from "better-sqlite3";
import { getDb } from "./db.js";
import { recordAuditLog } from "./audit.js";

export type TreasuryActionInput =
  | { kind: "spend"; token: string; to: string; amount: string }
  | { kind: "rotate"; signers: string[]; threshold: number; largeAmount: string; largeThreshold: number };

/** The on-chain `TreasuryConfig` the session was opened under. */
export interface TreasuryConfigSnapshot {
  signers: string[];
  threshold: number;
  largeAmount: string;
  largeThreshold: number;
}

export type SessionStatus = "collecting" | "ready" | "executed" | "expired";

export interface SigningSession {
  id: string;
  proposalId: number;
  digest: string;
  action: TreasuryActionInput;
  signers: string[];
  required: number;
  expiresAt: number;
  status: SessionStatus;
  signatures: { signer: string; signedAt: number }[];
  stellarTxHash: string | null;
  createdAt: number;
}

export class TreasuryMultisigError extends Error {
  constructor(
    public readonly code:
      | "invalid_input"
      | "not_found"
      | "expired"
      | "not_signer"
      | "already_signed"
      | "bad_signature"
      | "insufficient_signatures"
      | "already_executed"
      | "duplicate_session",
    message: string,
  ) {
    super(message);
    this.name = "TreasuryMultisigError";
  }
}

const DIGEST = /^[0-9a-f]{64}$/;
const SEP53_PREFIX = "Stellar Signed Message:\n";

/** The exact text a signer signs (with their wallet's signMessage) to approve a proposal. */
export function approvalMessage(proposalId: number, digest: string, expiresAt: number): string {
  return `ZK-VOTE treasury approval\nproposal: ${proposalId}\ndigest: ${digest}\nexpires: ${expiresAt}`;
}

/** Verifies a SEP-53 message signature: ed25519 over sha256("Stellar Signed Message:\n" + message). */
export function verifySep53(publicKey: string, message: string, signatureBase64: string): boolean {
  try {
    const hash = crypto.createHash("sha256").update(SEP53_PREFIX + message, "utf8").digest();
    const signature = Buffer.from(signatureBase64, "base64");
    return signature.length === 64 && StellarSdk.Keypair.fromPublicKey(publicKey).verify(hash, signature);
  } catch {
    return false;
  }
}

/** Signs like a wallet's signMessage does. For tests and scripted signers. */
export function signSep53(keypair: StellarSdk.Keypair, message: string): string {
  const hash = crypto.createHash("sha256").update(SEP53_PREFIX + message, "utf8").digest();
  return keypair.sign(hash).toString("base64");
}

const toStroops = (amount: string): bigint => {
  if (!/^\d+(\.\d{1,7})?$/.test(amount)) throw new TreasuryMultisigError("invalid_input", `Invalid amount "${amount}"`);
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, "0"));
};

/** Approvals needed — the same rule as the contract's `required_approvals`. */
export function requiredApprovals(config: TreasuryConfigSnapshot, action: TreasuryActionInput): number {
  if (action.kind === "spend" && toStroops(action.amount) > toStroops(config.largeAmount)) {
    return config.largeThreshold;
  }
  return config.threshold;
}

function validateConfig(config: TreasuryConfigSnapshot): void {
  const n = config.signers.length;
  if (n === 0 || new Set(config.signers).size !== n) {
    throw new TreasuryMultisigError("invalid_input", "Signer set must be non-empty and unique");
  }
  for (const signer of config.signers) {
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(signer)) {
      throw new TreasuryMultisigError("invalid_input", `Signer ${signer} is not a Stellar account`);
    }
  }
  if (config.threshold < 1 || config.threshold > n || config.largeThreshold < Math.max(2, config.threshold) || config.largeThreshold > n) {
    throw new TreasuryMultisigError("invalid_input", "Invalid threshold or dual-control threshold");
  }
  toStroops(config.largeAmount);
}

function validateAction(action: TreasuryActionInput): void {
  if (action.kind === "spend") {
    if (!StellarSdk.StrKey.isValidContract(action.token)) {
      throw new TreasuryMultisigError("invalid_input", "token must be a contract address (C...)");
    }
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(action.to) && !StellarSdk.StrKey.isValidContract(action.to)) {
      throw new TreasuryMultisigError("invalid_input", "to must be a Stellar address");
    }
    if (toStroops(action.amount) <= 0n) throw new TreasuryMultisigError("invalid_input", "amount must be positive");
  } else if (action.kind === "rotate") {
    validateConfig({
      signers: action.signers,
      threshold: action.threshold,
      largeAmount: action.largeAmount,
      largeThreshold: action.largeThreshold,
    });
  } else {
    throw new TreasuryMultisigError("invalid_input", "action.kind must be spend or rotate");
  }
}

interface SessionRow {
  id: string;
  proposal_id: number;
  digest: string;
  action: string;
  signers: string;
  required: number;
  expires_at: number;
  status: SessionStatus;
  stellar_tx_hash: string | null;
  created_at: number;
}

export interface AuditContext {
  actor?: string | null;
  endpoint?: string;
  requestId?: string | null;
}

export class TreasuryMultisig {
  constructor(
    private readonly db: () => DatabaseType = getDb,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  private audit(action: string, session: SigningSession, ctx: AuditContext, params: Record<string, unknown> = {}) {
    recordAuditLog({
      action: `treasury.${action}`,
      endpoint: ctx.endpoint ?? "treasury-multisig",
      authTokenId: ctx.actor ?? null,
      ipHash: null,
      requestId: ctx.requestId ?? null,
      statusCode: 200,
      params: {
        sessionId: session.id,
        proposalId: session.proposalId,
        digest: session.digest,
        kind: session.action.kind,
        status: session.status,
        signatures: session.signatures.length,
        required: session.required,
        ...params,
      },
    });
  }

  /** Opens a session for an on-chain proposal, under the signer set it was proposed with. */
  open(
    input: {
      proposalId: number;
      digest: string;
      expiresAt: number;
      action: TreasuryActionInput;
      config: TreasuryConfigSnapshot;
    },
    ctx: AuditContext = {},
  ): SigningSession {
    if (!Number.isInteger(input.proposalId) || input.proposalId < 1) {
      throw new TreasuryMultisigError("invalid_input", "proposalId must be a positive integer");
    }
    const digest = String(input.digest).toLowerCase().replace(/^0x/, "");
    if (!DIGEST.test(digest)) throw new TreasuryMultisigError("invalid_input", "digest must be 32 bytes of hex");
    if (!Number.isInteger(input.expiresAt) || input.expiresAt <= this.now()) {
      throw new TreasuryMultisigError("expired", "The proposal has already expired");
    }
    validateConfig(input.config);
    validateAction(input.action);

    const now = Date.now();
    const id = crypto.randomUUID();
    try {
      this.db()
        .prepare(
          `INSERT INTO treasury_signing_sessions
             (id, proposal_id, digest, action, signers, required, expires_at, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'collecting', ?, ?, ?)`,
        )
        .run(
          id,
          input.proposalId,
          digest,
          JSON.stringify(input.action),
          JSON.stringify(input.config.signers),
          requiredApprovals(input.config, input.action),
          input.expiresAt,
          ctx.actor ?? null,
          now,
          now,
        );
    } catch (err) {
      if (/UNIQUE/.test((err as Error).message)) {
        throw new TreasuryMultisigError("duplicate_session", "A session for this proposal already exists");
      }
      throw err;
    }
    const session = this.get(id)!;
    this.audit("session.opened", session, ctx);
    return session;
  }

  get(id: string): SigningSession | null {
    const row = this.db().prepare("SELECT * FROM treasury_signing_sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) return null;
    const signatures = this.db()
      .prepare("SELECT signer, signed_at FROM treasury_session_signatures WHERE session_id = ? ORDER BY signed_at, signer")
      .all(id) as { signer: string; signed_at: number }[];
    let status = row.status;
    if ((status === "collecting" || status === "ready") && row.expires_at <= this.now()) status = "expired";
    return {
      id: row.id,
      proposalId: row.proposal_id,
      digest: row.digest,
      action: JSON.parse(row.action),
      signers: JSON.parse(row.signers),
      required: row.required,
      expiresAt: row.expires_at,
      status,
      signatures: signatures.map((s) => ({ signer: s.signer, signedAt: s.signed_at })),
      stellarTxHash: row.stellar_tx_hash,
      createdAt: row.created_at,
    };
  }

  list(status?: SessionStatus): SigningSession[] {
    const ids = this.db()
      .prepare("SELECT id FROM treasury_signing_sessions ORDER BY created_at DESC LIMIT 200")
      .all() as { id: string }[];
    return ids.map(({ id }) => this.get(id)!).filter((s) => !status || s.status === status);
  }

  private require(id: string): SigningSession {
    const session = this.get(id);
    if (!session) throw new TreasuryMultisigError("not_found", "Signing session not found");
    if (session.status === "executed") throw new TreasuryMultisigError("already_executed", "The proposal was already executed");
    if (session.status === "expired") throw new TreasuryMultisigError("expired", "The proposal has expired");
    return session;
  }

  /** Records `signer`'s signature over the approval message for this session's digest. */
  sign(id: string, signer: string, signatureBase64: string, ctx: AuditContext = {}): SigningSession {
    const session = this.require(id);
    if (!session.signers.includes(signer)) throw new TreasuryMultisigError("not_signer", "Not a treasury signer");
    if (session.signatures.some((s) => s.signer === signer)) {
      throw new TreasuryMultisigError("already_signed", "This signer has already signed");
    }
    const message = approvalMessage(session.proposalId, session.digest, session.expiresAt);
    if (!verifySep53(signer, message, signatureBase64)) {
      throw new TreasuryMultisigError("bad_signature", "Signature does not match this proposal's digest and expiry");
    }
    const db = this.db();
    db.transaction(() => {
      db.prepare(
        "INSERT INTO treasury_session_signatures (session_id, signer, signature, signed_at) VALUES (?, ?, ?, ?)",
      ).run(id, signer, signatureBase64, Date.now());
      const count = (db.prepare("SELECT COUNT(*) AS n FROM treasury_session_signatures WHERE session_id = ?").get(id) as { n: number }).n;
      db.prepare("UPDATE treasury_signing_sessions SET status = ?, updated_at = ? WHERE id = ?").run(
        count >= session.required ? "ready" : "collecting",
        Date.now(),
        id,
      );
    })();
    const updated = this.get(id)!;
    this.audit("session.signed", updated, ctx, { signer });
    if (updated.status === "ready") this.audit("session.ready", updated, ctx);
    return updated;
  }

  /** Records the on-chain `treasury_execute` transaction. Refused below threshold, and only once. */
  markExecuted(id: string, stellarTxHash: string, ctx: AuditContext = {}): SigningSession {
    const session = this.require(id);
    if (session.signatures.length < session.required) {
      throw new TreasuryMultisigError(
        "insufficient_signatures",
        `${session.signatures.length} of ${session.required} required signatures`,
      );
    }
    if (!/^[0-9a-f]{64}$/i.test(stellarTxHash)) throw new TreasuryMultisigError("invalid_input", "Invalid transaction hash");
    const changes = this.db()
      .prepare(
        "UPDATE treasury_signing_sessions SET status = 'executed', stellar_tx_hash = ?, updated_at = ? WHERE id = ? AND status = 'ready'",
      )
      .run(stellarTxHash.toLowerCase(), Date.now(), id).changes;
    if (changes === 0) throw new TreasuryMultisigError("already_executed", "The proposal was already executed");
    const executed = this.get(id)!;
    this.audit(session.action.kind === "rotate" ? "signer_set.rotated" : "spend.executed", executed, ctx, {
      stellarTxHash: executed.stellarTxHash,
      signers: executed.signatures.map((s) => s.signer),
      ...(session.action.kind === "rotate"
        ? { newSigners: session.action.signers, newThreshold: session.action.threshold }
        : { to: session.action.to, amount: session.action.amount, token: session.action.token }),
    });
    return executed;
  }
}

export const treasuryMultisig = new TreasuryMultisig();
