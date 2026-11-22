/**
 * Durable Vote Submission State Machine (#921 ZV-078)
 *
 * Single authoritative state for every vote submission, stored in the
 * `submission_state` table so status queries are consistent across replicas
 * and survives restarts.
 *
 * State graph:
 *
 *   PENDING ──► SUBMITTED ──► CONFIRMING ──► CONFIRMED  (terminal)
 *      │                          │──────► FAILED      (terminal)
 *      │                          │──────► CONFLICT    (terminal)
 *      │                          └──────► EXPIRED     (terminal)
 *      └──────────────────────────────────► EXPIRED    (lease lapsed, terminal)
 */

import type { Database as DatabaseType } from "better-sqlite3";

// ── Types ────────────────────────────────────────────────────────────────────

export type SubmissionState =
  | "PENDING"
  | "SUBMITTED"
  | "CONFIRMING"
  | "CONFIRMED"
  | "FAILED"
  | "CONFLICT"
  | "EXPIRED";

export const TERMINAL_STATES: ReadonlySet<SubmissionState> = new Set([
  "CONFIRMED",
  "FAILED",
  "CONFLICT",
  "EXPIRED",
]);

export interface SubmissionRecord {
  idempotencyKey: string;
  nullifierHash: string;
  state: SubmissionState;
  txHash?: string;
  errorCode?: string;
  errorMessage?: string;
  leaseExpiresAt?: number;
  retryCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SubmissionTransition {
  to: SubmissionState;
  txHash?: string;
  errorCode?: string;
  errorMessage?: string;
  /**
   * Pass a new absolute Unix-ms deadline to extend the lease, null to clear it
   * (terminal states), or undefined to keep the existing value.
   */
  leaseExpiresAt?: number | null;
}

/** Default lease duration in ms. Prevents a crashed replica from permanently
 *  blocking a nullifier. */
export const SUBMISSION_LEASE_MS = 90_000;

// ── State machine ────────────────────────────────────────────────────────────

export class SubmissionStateMachine {
  constructor(private readonly db: DatabaseType) {}

  /**
   * Create a new submission record. Idempotent: a second call with the same
   * `idempotencyKey` returns the existing record without modification, so the
   * frontend can safely retry the initial POST after a network error.
   */
  create(idempotencyKey: string, nullifierHash: string): SubmissionRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO submission_state
           (idempotency_key, nullifier_hash, state, lease_expires_at, created_at, updated_at)
         VALUES (?, ?, 'PENDING', ?, ?, ?)`,
      )
      .run(idempotencyKey, nullifierHash, now + SUBMISSION_LEASE_MS, now, now);
    return this.get(idempotencyKey)!;
  }

  /**
   * Retrieve a submission by its idempotency key.
   * Returns null if no record exists (never submitted, or purged).
   */
  get(idempotencyKey: string): SubmissionRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM submission_state WHERE idempotency_key = ?`)
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * Find the most recent submission for a given nullifier hash.
   * Used to guard against duplicate submissions (#921 acceptance criterion 1):
   * callers check whether the nullifier is already CONFIRMED before retrying.
   */
  getByNullifier(nullifierHash: string): SubmissionRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM submission_state WHERE nullifier_hash = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(nullifierHash) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * Advance the state machine.  The transition is applied with an optimistic
   * lock on the current state: if another replica has already advanced the
   * record, this returns false without overwriting (last-write wins is wrong
   * for a state machine).
   *
   * Returns true when the row was updated, false when it was not (already
   * advanced, or the record does not exist / is terminal).
   */
  transition(
    idempotencyKey: string,
    t: SubmissionTransition,
  ): boolean {
    const now = Date.now();
    const existing = this.get(idempotencyKey);
    if (!existing || TERMINAL_STATES.has(existing.state)) return false;

    const newLease =
      t.leaseExpiresAt === null
        ? null
        : t.leaseExpiresAt !== undefined
          ? t.leaseExpiresAt
          : existing.leaseExpiresAt ?? null;

    const result = this.db
      .prepare(
        `UPDATE submission_state SET
           state            = ?,
           tx_hash          = COALESCE(?, tx_hash),
           error_code       = ?,
           error_message    = ?,
           lease_expires_at = ?,
           updated_at       = ?
         WHERE idempotency_key = ? AND state = ?`,
      )
      .run(
        t.to,
        t.txHash ?? null,
        t.errorCode ?? null,
        t.errorMessage ?? null,
        newLease,
        now,
        idempotencyKey,
        existing.state,
      ) as { changes: number };

    return result.changes > 0;
  }

  /**
   * Mark all PENDING or SUBMITTED submissions whose lease has expired as
   * EXPIRED.  Call periodically (e.g. every 30 s) to recover from crashed
   * replicas (#921 acceptance criterion — deterministic recovery after restart).
   */
  expireLeased(): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE submission_state SET state = 'EXPIRED', updated_at = ?
         WHERE state NOT IN ('CONFIRMED','FAILED','CONFLICT','EXPIRED')
           AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
      )
      .run(now, now) as { changes: number };
    return result.changes;
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): SubmissionRecord {
  return {
    idempotencyKey:  row.idempotency_key  as string,
    nullifierHash:   row.nullifier_hash   as string,
    state:           row.state            as SubmissionState,
    txHash:          row.tx_hash          as string | undefined,
    errorCode:       row.error_code       as string | undefined,
    errorMessage:    row.error_message    as string | undefined,
    leaseExpiresAt:  row.lease_expires_at as number | undefined,
    retryCount:      row.retry_count      as number,
    createdAt:       row.created_at       as number,
    updatedAt:       row.updated_at       as number,
  };
}
