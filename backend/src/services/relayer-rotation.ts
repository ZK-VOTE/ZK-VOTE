/**
 * Relayer Key Rotation Orchestrator (#746)
 *
 * A Stellar relayer key is an account with its own sequence chain, so
 * rotating it changes the relayer's on-chain identity. A bare active-pointer
 * swap (what `rotateActiveKey` alone does) lets in-flight work sign under the
 * wrong identity, activates accounts that were never funded, and cannot be
 * undone cleanly. This orchestrator wraps it in an explicit lifecycle.
 *
 * Planned rotation — bounded dual-identity window
 *   preflight  target must exist on-chain with >= RELAYER_ROTATION_MIN_FUNDING_XLM
 *              (funding-gap guard); at most one identity may be draining.
 *   cutover    the active-pointer swap runs inside the sequence lock (fence),
 *              so no transaction is mid-build across the switch; the new
 *              identity's sequence is resynced. Any failure rolls back to the
 *              old identity before new work is lost.
 *   draining   the old identity may only sign transactions sourced from its
 *              own account (built before cutover) until drainUntil; all new
 *              work is built and signed by the new identity. Signing is fenced
 *              by source account in RelayerKeyManager.signTransaction.
 *   completed  drain window closed; old identity is an idle standby.
 *   rolled_back manual or automatic return to the previous identity.
 *
 * Compromise response — revoke first, then restore service
 *   1. revoke: signing for the compromised account stops at once, including
 *      drains; the revocation is persisted so a restart with the same secret
 *      still refuses it.
 *   2. rotate: first standby that passes the funding check becomes active
 *      (never an unfunded account); with none, signing halts (fail closed).
 *   3. report: signatures by the compromised key still in flight are listed
 *      as invalidated — vote jobs retry under the new identity and the
 *      on-chain nullifier keeps a retried vote from double counting.
 *   4. sweep (separate, two-person): move remaining XLM to the pre-provisioned
 *      safe account.
 *   Declaration-to-rotated time is measured against
 *   RELAYER_COMPROMISE_SLO_SECONDS.
 *
 * Griefing analysis (declaration and sweep as attack vectors)
 *   - A fake declaration can only move signing to another of our own funded
 *     standby keys and burn one key; it cannot redirect funds.
 *   - Repeated declarations within RELAYER_COMPROMISE_COOLDOWN_MS need a
 *     second person (confirmedBy), so one stolen admin token cannot thrash
 *     identities until standbys run out.
 *   - Sweep destination comes only from RELAYER_SWEEP_SAFE_ACCOUNT, never
 *     from the request, must not be a hot relayer key, and needs a confirmer
 *     distinct from the declarer. The sweep transaction shape is re-checked
 *     at signing time (pay/merge to the safe account only).
 *   - An attacker holding the key can race the sweep; merging the account
 *     makes it unusable afterwards, and fee-bump/sequence races only cost the
 *     attacker the same funds the sweep was protecting.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import crypto from "crypto";
import { log } from "./logger.js";
import {
  relayerCompromiseDeclarationsTotal,
  relayerCompromiseSloBreachesTotal,
  relayerCompromiseTimeToRotatedSeconds,
  relayerRotationDurationSeconds,
  relayerRotationPhase,
  relayerRotationsCompletedTotal,
  relayerSigningHalted,
  relayerSweepsTotal,
} from "./metrics.js";
import type {
  RelayerKeyManager,
  RelayerManagedKey,
} from "./relayerKeyManager.js";
import type { SigningPolicy } from "./relayer-signing-policy.js";

export type RotationKind = "planned" | "compromise";
export type RotationPhase =
  | "preflight"
  | "cutover"
  | "draining"
  | "completed"
  | "rolled_back"
  | "failed";

const ALL_PHASES: RotationPhase[] = [
  "preflight",
  "cutover",
  "draining",
  "completed",
  "rolled_back",
  "failed",
];

export interface RotationRecord {
  id: string;
  kind: RotationKind;
  phase: RotationPhase;
  actor: string;
  reason: string;
  fromKeyId: string | null;
  fromPublicKey: string | null;
  toKeyId: string | null;
  toPublicKey: string | null;
  startedAt: number;
  cutoverAt?: number;
  drainUntil?: number | null;
  finishedAt?: number;
  error?: string;
  timeline: Array<{ phase: string; at: number }>;
  // Compromise only
  declaredAt?: number;
  revokedAt?: number;
  rotatedAt?: number;
  timeToRotatedMs?: number;
  sloMet?: boolean;
  invalidatedSignatures?: string[];
  halted?: boolean;
  revocationPersisted?: boolean;
}

export class RotationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly record?: RotationRecord,
  ) {
    super(message);
    this.name = "RotationError";
  }
}

// ============================================
// PERSISTENT STORE
// ============================================

export interface KeyLifecycleEvent {
  event: string;
  keyId?: string | null;
  publicKey?: string | null;
  actor: string;
  reason?: string;
  detail?: Record<string, unknown>;
  at: number;
}

export interface KeyRevocation {
  publicKey: string;
  keyId: string;
  reason: string;
  declaredBy: string;
  at: number;
}

export interface KeyLifecycleStore {
  recordEvent(event: KeyLifecycleEvent): void;
  recordRevocation(revocation: KeyRevocation): void;
  /** public key → reason */
  loadRevocations(): Map<string, string>;
}

export class MemoryKeyLifecycleStore implements KeyLifecycleStore {
  readonly events: KeyLifecycleEvent[] = [];
  readonly revocations = new Map<string, KeyRevocation>();

  recordEvent(event: KeyLifecycleEvent): void {
    this.events.push(event);
  }

  recordRevocation(revocation: KeyRevocation): void {
    this.revocations.set(revocation.publicKey, revocation);
  }

  loadRevocations(): Map<string, string> {
    return new Map(
      Array.from(this.revocations.values()).map((r) => [r.publicKey, r.reason]),
    );
  }
}

export const KEY_LIFECYCLE_DDL = `
CREATE TABLE IF NOT EXISTS relayer_key_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  key_id TEXT,
  public_key TEXT,
  actor TEXT NOT NULL,
  reason TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relayer_key_events_created ON relayer_key_events(created_at);
CREATE TABLE IF NOT EXISTS relayer_key_revocations (
  public_key TEXT PRIMARY KEY,
  key_id TEXT,
  reason TEXT NOT NULL,
  declared_by TEXT NOT NULL,
  declared_at INTEGER NOT NULL
);
`;

interface SqliteLike {
  exec(sql: string): unknown;
  prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
}

/**
 * SQLite-backed store. Creates its own tables because the revocation list
 * must be readable at boot, before (and regardless of) the migration runner.
 */
export class SqliteKeyLifecycleStore implements KeyLifecycleStore {
  private ready = false;

  constructor(private readonly getDb: () => SqliteLike) {}

  private db(): SqliteLike {
    const db = this.getDb();
    if (!this.ready) {
      db.exec(KEY_LIFECYCLE_DDL);
      this.ready = true;
    }
    return db;
  }

  recordEvent(e: KeyLifecycleEvent): void {
    this.db()
      .prepare(
        `INSERT INTO relayer_key_events (event, key_id, public_key, actor, reason, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.event,
        e.keyId ?? null,
        e.publicKey ?? null,
        e.actor,
        e.reason ?? null,
        e.detail ? JSON.stringify(e.detail) : null,
        e.at,
      );
  }

  recordRevocation(r: KeyRevocation): void {
    this.db()
      .prepare(
        `INSERT OR REPLACE INTO relayer_key_revocations (public_key, key_id, reason, declared_by, declared_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(r.publicKey, r.keyId, r.reason, r.declaredBy, r.at);
  }

  loadRevocations(): Map<string, string> {
    const rows = this.db()
      .prepare("SELECT public_key, reason FROM relayer_key_revocations")
      .all() as Array<{ public_key: string; reason: string }>;
    return new Map(rows.map((r) => [r.public_key, r.reason]));
  }
}

// ============================================
// ORCHESTRATOR
// ============================================

export interface SweepAccount {
  account: StellarSdk.Account;
  /** Native balance as a decimal string, e.g. "120.5000000". */
  nativeBalance: string;
  /** Trustlines, offers, data entries, extra signers. */
  subentryCount: number;
}

export interface RotationSettings {
  drainWindowMs: number;
  minFundingXlm: number;
  fenceTimeoutMs: number;
  compromiseSloSeconds: number;
  compromiseCooldownMs: number;
  sweepSafeAccount?: string;
  maxKeyAgeDays: number;
}

export interface RotationDeps {
  keyManager: RelayerKeyManager;
  policy?: SigningPolicy | null;
  store: KeyLifecycleStore;
  /** Run fn while no relayer transaction is mid-build (the sequence lock). */
  fence: <T>(fn: () => Promise<T>) => Promise<T>;
  /** True when no relayer transaction is queued or mid-build. */
  isQuiescent?: () => boolean;
  /** Native XLM balance, or null when the account does not exist on-chain. */
  getBalanceXlm: (publicKey: string) => Promise<number | null>;
  /** Make the newly active identity usable (resync its sequence number). */
  verifyIdentity?: (publicKey: string) => Promise<void>;
  loadSweepAccount?: (publicKey: string) => Promise<SweepAccount>;
  submit?: (tx: StellarSdk.Transaction) => Promise<{ hash: string }>;
  networkPassphrase: string;
  settings: RotationSettings;
  now?: () => number;
}

/** Native balance kept by an account: 2 base reserves + 0.5 XLM per subentry. */
function minimumBalanceXlm(subentryCount: number): number {
  return (2 + subentryCount) * 0.5;
}

export class RelayerRotationOrchestrator {
  private current: RotationRecord | null = null;
  private readonly history: RotationRecord[] = [];
  private lastCompromiseAt: number | null = null;
  private readonly now: () => number;
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: RotationDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ── Bookkeeping ────────────────────────────────────────────────────────

  private newRecord(
    kind: RotationKind,
    actor: string,
    reason: string,
    from: RelayerManagedKey | null,
  ): RotationRecord {
    const record: RotationRecord = {
      id: `rot-${crypto.randomBytes(6).toString("hex")}`,
      kind,
      phase: "preflight",
      actor,
      reason,
      fromKeyId: from?.id ?? null,
      fromPublicKey: from?.publicKey ?? null,
      toKeyId: null,
      toPublicKey: null,
      startedAt: this.now(),
      timeline: [],
    };
    this.setPhase(record, "preflight");
    return record;
  }

  private setPhase(record: RotationRecord, phase: RotationPhase): void {
    record.phase = phase;
    record.timeline.push({ phase, at: this.now() });
    for (const p of ALL_PHASES) relayerRotationPhase.set({ phase: p }, p === phase ? 1 : 0);
    if (phase === "completed" || phase === "rolled_back" || phase === "failed") {
      record.finishedAt = this.now();
      relayerRotationsCompletedTotal.inc({ kind: record.kind, outcome: phase });
    }
  }

  private event(
    event: string,
    actor: string,
    key: { id?: string | null; publicKey?: string | null } | null,
    reason?: string,
    detail?: Record<string, unknown>,
  ): void {
    const entry: KeyLifecycleEvent = {
      event,
      keyId: key?.id ?? null,
      publicKey: key?.publicKey ?? null,
      actor,
      reason,
      detail,
      at: this.now(),
    };
    try {
      this.deps.store.recordEvent(entry);
    } catch (err) {
      log("error", "relayer_key_event_persist_failed", {
        event,
        error: (err as Error).message,
      });
    }
    log("warn", `relayer_key_${event}`, {
      keyId: entry.keyId,
      publicKey: entry.publicKey,
      actor,
      reason,
      ...detail,
    });
  }

  private archive(record: RotationRecord): void {
    this.history.unshift(record);
    this.history.length = Math.min(this.history.length, 20);
    if (this.current === record) this.current = null;
  }

  private async fenced<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    if (timeoutMs === undefined) return this.deps.fence(fn);
    // Compromise path: the key is already revoked, so waiting for the lock
    // only gives in-flight builds a clean switch; never wait unbounded.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ran = false;
    const run = async () => {
      if (ran) return undefined as T;
      ran = true;
      return fn();
    };
    const timeout = new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        log("warn", "relayer_rotation_fence_timeout", { timeoutMs });
        run().then(resolve, reject);
      }, timeoutMs);
      (timer as any).unref?.();
    });
    try {
      return await Promise.race([this.deps.fence(run), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** First candidate whose account exists with enough XLM to take over. */
  private async firstFunded(
    candidates: RelayerManagedKey[],
  ): Promise<{ key: RelayerManagedKey | null; rejected: string[] }> {
    const rejected: string[] = [];
    for (const key of candidates) {
      let balance: number | null;
      try {
        balance = await this.deps.getBalanceXlm(key.publicKey);
      } catch (err) {
        rejected.push(`${key.id}: balance check failed (${(err as Error).message})`);
        continue;
      }
      if (balance === null) {
        rejected.push(`${key.id}: account does not exist on-chain (unfunded)`);
      } else if (balance < this.deps.settings.minFundingXlm) {
        rejected.push(
          `${key.id}: ${balance} XLM < required ${this.deps.settings.minFundingXlm} XLM`,
        );
      } else {
        key.balanceXlm = balance;
        return { key, rejected };
      }
    }
    return { key: null, rejected };
  }

  // ── Planned rotation ───────────────────────────────────────────────────

  async rotate(options: {
    target?: string;
    actor: string;
    reason?: string;
  }): Promise<RotationRecord> {
    const km = this.deps.keyManager;
    this.tick();
    if (this.current) {
      throw new RotationError(
        this.current.phase === "draining" ? "drain_in_progress" : "rotation_in_progress",
        this.current.phase === "draining"
          ? `Previous identity is still draining until ${new Date(this.current.drainUntil ?? 0).toISOString()}; finalize or wait`
          : `Rotation ${this.current.id} is in ${this.current.phase}`,
        this.current,
      );
    }

    const from = km.getActiveKey();
    const record = this.newRecord("planned", options.actor, options.reason ?? "planned", from);
    this.current = record;

    let candidates: RelayerManagedKey[];
    if (options.target) {
      const target = km.findKey(options.target);
      if (!target) return this.fail(record, "target_not_found", `Relayer key ${options.target} not found`);
      if (target.id === from?.id) return this.fail(record, "target_is_active", "Target is already active");
      if (target.status === "revoked" || target.status === "compromised" || km.isPubliclyRevoked(target.publicKey)) {
        return this.fail(record, "target_revoked", `Relayer key ${target.id} is revoked`);
      }
      candidates = [target];
    } else {
      candidates = km.standbyCandidates();
    }

    const { key: to, rejected } = await this.firstFunded(candidates);
    if (!to) {
      return this.fail(
        record,
        "funding_gap",
        `No rotation target passed the funding preflight: ${rejected.join("; ") || "no standby keys"}`,
      );
    }
    record.toKeyId = to.id;
    record.toPublicKey = to.publicKey;

    this.setPhase(record, "cutover");
    try {
      await this.fenced(async () => {
        await km.rotateActiveKey(to.id, "planned", { drainPrevious: true });
      });
      await this.deps.verifyIdentity?.(to.publicKey);
    } catch (err) {
      await this.rollbackCutover(record, from, err as Error);
      throw new RotationError(
        "cutover_failed",
        `Cutover to ${to.id} failed and was rolled back: ${(err as Error).message}`,
        record,
      );
    }

    record.cutoverAt = this.now();
    relayerRotationDurationSeconds.observe(
      { kind: "planned" },
      (record.cutoverAt - record.startedAt) / 1000,
    );
    const drained = from ? km.findKey(from.id) : undefined;
    record.drainUntil = drained?.status === "draining" ? (drained.drainUntil ?? null) : null;
    this.event("rotated", options.actor, to, record.reason, {
      rotationId: record.id,
      from: from?.id,
      drainUntil: record.drainUntil,
    });

    if (record.drainUntil) {
      this.setPhase(record, "draining");
    } else {
      this.setPhase(record, "completed");
      this.archive(record);
    }
    return record;
  }

  private fail(record: RotationRecord, code: string, message: string): never {
    record.error = message;
    this.setPhase(record, "failed");
    this.event("rotation_failed", record.actor, { id: record.fromKeyId, publicKey: record.fromPublicKey }, code, {
      rotationId: record.id,
      message,
    });
    this.archive(record);
    throw new RotationError(code, message, record);
  }

  /** Restore the previous identity after a failed cutover. */
  private async rollbackCutover(
    record: RotationRecord,
    from: RelayerManagedKey | null,
    cause: Error,
  ): Promise<void> {
    const km = this.deps.keyManager;
    record.error = cause.message;
    if (from && km.findKey(from.id)?.status !== "compromised") {
      try {
        await this.fenced(async () => {
          await km.rotateActiveKey(from.id, "rollback", { drainPrevious: true });
        });
        await this.deps.verifyIdentity?.(from.publicKey);
        this.setPhase(record, "rolled_back");
        this.event("rotation_rolled_back", record.actor, from, cause.message, {
          rotationId: record.id,
        });
        this.archive(record);
        return;
      } catch (err) {
        record.error = `${cause.message}; rollback failed: ${(err as Error).message}`;
      }
    }
    this.setPhase(record, "failed");
    this.event("rotation_failed", record.actor, from, record.error, { rotationId: record.id });
    this.archive(record);
  }

  /**
   * Return to the previous identity during the drain window (e.g. the new
   * account misbehaves after cutover). The new identity drains in turn so
   * anything it already signed can still be signed again on retry.
   */
  async rollback(options: { actor: string; reason?: string }): Promise<RotationRecord> {
    this.tick();
    const record = this.current;
    if (!record || record.kind !== "planned" || record.phase !== "draining") {
      throw new RotationError("nothing_to_roll_back", "No planned rotation is inside its drain window");
    }
    const from = record.fromKeyId ? this.deps.keyManager.findKey(record.fromKeyId) : undefined;
    if (!from || from.status !== "draining") {
      throw new RotationError("previous_identity_unavailable", "Previous identity is no longer draining");
    }
    await this.fenced(async () => {
      await this.deps.keyManager.rotateActiveKey(from.id, "rollback", { drainPrevious: true });
    });
    await this.deps.verifyIdentity?.(from.publicKey);
    record.error = options.reason ?? "manual rollback";
    this.setPhase(record, "rolled_back");
    this.event("rotation_rolled_back", options.actor, from, record.error, { rotationId: record.id });
    this.archive(record);
    return record;
  }

  /** Close the drain window early once no relayer work is in flight. */
  finalize(options: { actor: string }): RotationRecord {
    const record = this.current;
    if (!record || record.phase !== "draining" || !record.fromKeyId) {
      throw new RotationError("nothing_to_finalize", "No rotation is draining");
    }
    if (this.deps.isQuiescent && !this.deps.isQuiescent()) {
      throw new RotationError(
        "not_quiescent",
        "Relayer transactions are still in flight; wait for the drain window or retry",
      );
    }
    this.deps.keyManager.finishDrain(record.fromKeyId);
    this.complete(record, options.actor);
    return record;
  }

  private complete(record: RotationRecord, actor: string): void {
    this.setPhase(record, "completed");
    this.event("drain_completed", actor, { id: record.fromKeyId, publicKey: record.fromPublicKey }, undefined, {
      rotationId: record.id,
    });
    this.archive(record);
  }

  /** Advance time-driven transitions (drain expiry). Safe to call often. */
  tick(): void {
    this.deps.keyManager.expireDrains(this.now());
    const record = this.current;
    if (record?.phase === "draining" && record.fromKeyId) {
      const from = this.deps.keyManager.findKey(record.fromKeyId);
      if (!from || from.status !== "draining") this.complete(record, "system");
    }
  }

  // ── Compromise response ────────────────────────────────────────────────

  /** Co-signer id behind an action approval, or null. */
  private confirmer(token: string | undefined, action: string): string | null {
    return this.deps.policy?.verifyActionApproval(token, action) ?? null;
  }

  async declareCompromise(options: {
    key: string;
    declaredBy: string;
    /** Co-signer approval of `compromise:<publicKey>`; needed inside the cooldown. */
    confirmation?: string;
    reason: string;
  }): Promise<RotationRecord> {
    const km = this.deps.keyManager;
    const declaredAt = this.now();
    const key = km.findKey(options.key);
    const confirmedBy = key ? this.confirmer(options.confirmation, `compromise:${key.publicKey}`) : null;
    if (!key) {
      relayerCompromiseDeclarationsTotal.inc({ outcome: "rejected" });
      throw new RotationError("key_not_found", `Relayer key ${options.key} not found`);
    }
    if (key.status === "compromised") {
      // Idempotent: repeating a declaration changes nothing.
      const existing = this.history.find(
        (r) => r.kind === "compromise" && r.fromKeyId === key.id,
      );
      relayerCompromiseDeclarationsTotal.inc({ outcome: "duplicate" });
      if (existing) return existing;
      throw new RotationError("already_compromised", `Relayer key ${key.id} is already revoked`);
    }
    if (
      this.lastCompromiseAt !== null &&
      declaredAt - this.lastCompromiseAt < this.deps.settings.compromiseCooldownMs &&
      (!confirmedBy || confirmedBy === options.declaredBy)
    ) {
      relayerCompromiseDeclarationsTotal.inc({ outcome: "rejected" });
      throw new RotationError(
        "cooldown_requires_confirmation",
        "Another compromise was declared recently; a second operator (confirmedBy) must confirm",
      );
    }

    const wasActive = km.getActiveKey()?.id === key.id;
    // A compromise supersedes any planned rotation still draining.
    if (this.current) {
      this.current.error = "superseded by compromise declaration";
      this.setPhase(this.current, "failed");
      this.archive(this.current);
    }
    const record = this.newRecord("compromise", options.declaredBy, options.reason, key);
    record.declaredAt = declaredAt;
    this.current = record;

    // 1. Revoke first: from this instant the key signs nothing but a sweep.
    km.revokeKey(key.id, options.reason, "compromised");
    record.revokedAt = this.now();
    try {
      this.deps.store.recordRevocation({
        publicKey: key.publicKey,
        keyId: key.id,
        reason: options.reason,
        declaredBy: options.declaredBy,
        at: record.revokedAt,
      });
      record.revocationPersisted = true;
    } catch (err) {
      record.revocationPersisted = false;
      log("error", "relayer_revocation_persist_failed", {
        keyId: key.id,
        error: (err as Error).message,
      });
    }
    record.invalidatedSignatures = km.getOutstandingSignatures(key.publicKey).map((s) => s.hash);
    this.event("compromise_declared", options.declaredBy, key, options.reason, {
      rotationId: record.id,
      confirmedBy,
      wasActive,
      invalidatedSignatures: record.invalidatedSignatures.length,
    });

    // 2. Restore service on a funded standby — never an unfunded account.
    if (wasActive) {
      this.setPhase(record, "cutover");
      const { key: successor, rejected } = await this.firstFunded(km.standbyCandidates());
      if (successor) {
        await this.fenced(async () => {
          await km.rotateActiveKey(successor.id, "compromise", { drainPrevious: false });
        }, this.deps.settings.fenceTimeoutMs);
        record.toKeyId = successor.id;
        record.toPublicKey = successor.publicKey;
        try {
          await this.deps.verifyIdentity?.(successor.publicKey);
        } catch (err) {
          log("warn", "relayer_compromise_successor_resync_failed", {
            keyId: successor.id,
            error: (err as Error).message,
          });
        }
      } else {
        this.halt(`compromise of ${key.id}: no funded standby (${rejected.join("; ")})`, "system");
        record.halted = true;
      }
    }

    // 3. Measure against the SLO.
    record.rotatedAt = this.now();
    record.timeToRotatedMs = record.rotatedAt - declaredAt;
    record.sloMet =
      !record.halted &&
      record.timeToRotatedMs <= this.deps.settings.compromiseSloSeconds * 1000;
    relayerCompromiseTimeToRotatedSeconds.set(record.timeToRotatedMs / 1000);
    if (!record.sloMet) relayerCompromiseSloBreachesTotal.inc();
    relayerCompromiseDeclarationsTotal.inc({ outcome: record.halted ? "halted" : "rotated" });
    this.lastCompromiseAt = declaredAt;

    this.setPhase(record, record.halted ? "failed" : "completed");
    this.event("compromise_contained", options.declaredBy, record.toKeyId ? { id: record.toKeyId, publicKey: record.toPublicKey } : null, undefined, {
      rotationId: record.id,
      timeToRotatedMs: record.timeToRotatedMs,
      sloMet: record.sloMet,
      halted: record.halted ?? false,
    });
    this.archive(record);
    return record;
  }

  /**
   * Move what is left on a compromised account to the safe account. Needs a
   * second person: a co-signer approval of `sweep:<publicKey>` from someone
   * other than the declarer. The destination is configuration, never a
   * parameter.
   */
  async sweep(options: {
    key: string;
    requestedBy: string;
    confirmation?: string;
  }): Promise<{ hash: string; mode: "merge" | "payment"; amount?: string; confirmedBy: string }> {
    const km = this.deps.keyManager;
    const key = km.findKey(options.key);
    const refuse = (code: string, message: string): never => {
      relayerSweepsTotal.inc({ outcome: "refused" });
      this.event("sweep_refused", options.requestedBy, key ?? null, code);
      throw new RotationError(code, message);
    };
    if (!key || key.status !== "compromised") {
      return refuse("not_compromised", "Only a key declared compromised can be swept");
    }
    const declaration = this.history.find((r) => r.kind === "compromise" && r.fromKeyId === key.id);
    const confirmedBy = this.confirmer(options.confirmation, `sweep:${key.publicKey}`);
    if (!confirmedBy || confirmedBy === declaration?.actor || confirmedBy === options.requestedBy) {
      return refuse(
        "two_person_rule",
        "Sweep needs a co-signer approval of sweep:<publicKey> from someone other than the declarer",
      );
    }
    const destination = this.deps.settings.sweepSafeAccount;
    if (!destination) return refuse("no_safe_account", "RELAYER_SWEEP_SAFE_ACCOUNT is not configured");
    if (destination === key.publicKey || km.findKey(destination)) {
      return refuse("unsafe_destination", "Safe account must not be a relayer hot key");
    }
    if (!this.deps.loadSweepAccount || !this.deps.submit) {
      return refuse("sweep_unavailable", "Sweep is not wired to the network in this process");
    }

    const { account, nativeBalance, subentryCount } = await this.deps.loadSweepAccount(key.publicKey);
    const builder = new StellarSdk.TransactionBuilder(account, {
      fee: "10000",
      networkPassphrase: this.deps.networkPassphrase,
    });
    let mode: "merge" | "payment";
    let amount: string | undefined;
    if (subentryCount === 0) {
      // Merging also deletes the account, so the attacker cannot reuse it.
      mode = "merge";
      builder.addOperation(StellarSdk.Operation.accountMerge({ destination }));
    } else {
      const spendable = Number(nativeBalance) - minimumBalanceXlm(subentryCount) - 0.01;
      if (!(spendable > 0)) return refuse("nothing_to_sweep", "No spendable XLM above the reserve");
      mode = "payment";
      amount = spendable.toFixed(7);
      builder.addOperation(
        StellarSdk.Operation.payment({ destination, asset: StellarSdk.Asset.native(), amount }),
      );
    }
    const tx = builder.setTimeout(60).build();
    await km.signTransaction(tx, { purpose: "sweep" });
    try {
      const res = await this.deps.submit(tx);
      relayerSweepsTotal.inc({ outcome: "submitted" });
      this.event("sweep_submitted", options.requestedBy, key, undefined, { hash: res.hash, mode, amount, confirmedBy });
      return { hash: res.hash, mode, amount, confirmedBy };
    } catch (err) {
      relayerSweepsTotal.inc({ outcome: "failed" });
      this.event("sweep_failed", options.requestedBy, key, (err as Error).message, { confirmedBy });
      throw err;
    }
  }

  // ── Halt (co-signer stop signal) ───────────────────────────────────────

  halt(reason: string, by: string): void {
    this.deps.policy?.halt(reason, by);
    relayerSigningHalted.set(1);
    this.event("signing_halted", by, null, reason);
  }

  resume(by: string): void {
    this.deps.policy?.resume();
    relayerSigningHalted.set(0);
    this.event("signing_resumed", by, null);
  }

  // ── Status ─────────────────────────────────────────────────────────────

  getStatus(): {
    current: RotationRecord | null;
    history: RotationRecord[];
    readiness: {
      activeKeyId: string | null;
      activeKeyAgeDays: number | null;
      maxKeyAgeDays: number;
      rotationOverdue: boolean;
      fundedStandbyKeys: number;
      halted: boolean;
      haltReason: string | null;
    };
  } {
    this.tick();
    const km = this.deps.keyManager;
    const active = km.getActiveKey();
    const ageDays = active?.activatedAt
      ? (this.now() - new Date(active.activatedAt).getTime()) / 86_400_000
      : null;
    const halt = this.deps.policy?.getHaltState() ?? null;
    return {
      current: this.current,
      history: this.history.slice(0, 10),
      readiness: {
        activeKeyId: active?.id ?? null,
        activeKeyAgeDays: ageDays === null ? null : Number(ageDays.toFixed(2)),
        maxKeyAgeDays: this.deps.settings.maxKeyAgeDays,
        rotationOverdue: ageDays !== null && ageDays > this.deps.settings.maxKeyAgeDays,
        fundedStandbyKeys: km
          .standbyCandidates()
          .filter((k) => (k.balanceXlm ?? 0) >= this.deps.settings.minFundingXlm).length,
        halted: halt !== null,
        haltReason: halt?.reason ?? null,
      },
    };
  }

  startTicker(intervalMs = 5_000): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.tick(), intervalMs);
    this.ticker.unref?.();
  }

  stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }
}
