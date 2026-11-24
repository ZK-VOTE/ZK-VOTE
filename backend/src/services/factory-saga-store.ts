/**
 * Durable state machine for DAO-creation sagas.
 *
 * Replaces the process-local `Map` in factory-orchestrator.ts. Every step has a
 * stable idempotency key derived from (ticketId, step, name); a re-run with the
 * same key returns the stored result instead of re-executing the deployment.
 *
 * All mutations are synchronous better-sqlite3 transactions (no awaits inside),
 * so two workers sharing the same DB file cannot interleave a read/modify/write.
 * Optimistic concurrency is enforced with a `version` column.
 */

import crypto from "crypto";
import { getDb } from "./db.js";
import { ensureDurableSchema, type SqliteLike } from "./durable-schema.js";

export const FACTORY_STATUSES = [
  "in_progress",
  "completed",
  "failed",
  "compensating",
  "compensated",
] as const;
export type FactoryStatusValue = (typeof FACTORY_STATUSES)[number];

export interface SagaRecord {
  ticketId: string;
  creator: string;
  daoName: string;
  params: Record<string, unknown>;
  currentStep: number;
  status: FactoryStatusValue;
  version: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SagaStepRecord {
  ticketId: string;
  step: number;
  name: string;
  idempotencyKey: string;
  status: "pending" | "running" | "completed" | "failed" | "compensated";
  result: Record<string, unknown> | null;
  contractId: string | null;
  txHash: string | null;
  attempts: number;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

export interface CompensationPlanEntry {
  step: number;
  name: string;
  action: string;
  contractId: string | null;
}

export class SagaConcurrencyError extends Error {
  constructor(ticketId: string) {
    super(`saga ${ticketId} was modified concurrently; retry the operation`);
    this.name = "SagaConcurrencyError";
  }
}

/** Stable, collision-resistant per-step key. Never use Date.now() here. */
export function createStepIdempotencyKey(
  ticketId: string,
  step: number,
  name: string,
): string {
  return crypto
    .createHash("sha256")
    .update(`${ticketId}\u0000${step}\u0000${name}`)
    .digest("hex");
}

type Db = SqliteLike & {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
};

export class FactorySagaStore {
  private readonly db: Db;

  constructor(db: Db = getDb() as unknown as Db) {
    this.db = db;
    ensureDurableSchema(db);
  }

  /** Create a saga. Idempotent: an existing ticket is returned unchanged. */
  createSaga(input: {
    ticketId: string;
    creator: string;
    daoName: string;
    params: Record<string, unknown>;
    now?: number;
  }): SagaRecord {
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO factory_sagas
           (ticket_id, creator, dao_name, params, current_step, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 'in_progress', 1, ?, ?)`,
      )
      .run(
        input.ticketId,
        input.creator,
        input.daoName,
        JSON.stringify(input.params),
        now,
        now,
      );
    return this.getSaga(input.ticketId)!;
  }

  getSaga(ticketId: string): SagaRecord | null {
    const row = this.db
      .prepare("SELECT * FROM factory_sagas WHERE ticket_id = ?")
      .get(ticketId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      ticketId: row.ticket_id as string,
      creator: row.creator as string,
      daoName: row.dao_name as string,
      params: JSON.parse(row.params as string) as Record<string, unknown>,
      currentStep: row.current_step as number,
      status: row.status as FactoryStatusValue,
      version: row.version as number,
      error: (row.error as string | null) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  getStep(ticketId: string, step: number): SagaStepRecord | null {
    const row = this.db
      .prepare("SELECT * FROM factory_saga_steps WHERE ticket_id = ? AND step = ?")
      .get(ticketId, step) as Record<string, unknown> | undefined;
    return row ? this.mapStep(row) : null;
  }

  listSteps(ticketId: string): SagaStepRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM factory_saga_steps WHERE ticket_id = ? ORDER BY step ASC",
      )
      .all(ticketId) as Record<string, unknown>[];
    return rows.map((row) => this.mapStep(row));
  }

  /**
   * Claim a step for execution.
   *
   * Returns `reuse` with the persisted result when the same idempotency key
   * already completed — the caller must NOT redeploy in that case.
   */
  claimStep(input: {
    ticketId: string;
    step: number;
    name: string;
    now?: number;
  }): { action: "run" | "reuse"; idempotencyKey: string; result?: Record<string, unknown> } {
    const now = input.now ?? Date.now();
    const key = createStepIdempotencyKey(
      input.ticketId,
      input.step,
      input.name,
    );
    return this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO factory_saga_steps
             (ticket_id, step, name, idempotency_key, status, attempts, started_at)
           VALUES (?, ?, ?, ?, 'running', 1, ?)`,
        )
        .run(input.ticketId, input.step, input.name, key, now);
      const existing = this.getStep(input.ticketId, input.step)!;
      if (inserted.changes === 0) {
        if (existing.idempotencyKey === key && existing.status === "completed") {
          return {
            action: "reuse" as const,
            idempotencyKey: key,
            result: existing.result ?? {},
          };
        }
        if (existing.status === "running") {
          // Another worker owns the step. Do not double-deploy; it will finish
          // (or fail) and the coordinator can resume it later.
          return {
            action: "reuse" as const,
            idempotencyKey: key,
            result: undefined,
          };
        }
      }
      // Re-run with an explicit new attempt (e.g. operator retry).
      this.db
        .prepare(
          `UPDATE factory_saga_steps
              SET status = 'running', attempts = attempts + 1,
                  error = NULL, started_at = ?, completed_at = NULL,
                  idempotency_key = ?
            WHERE ticket_id = ? AND step = ?`,
        )
        .run(now, key, input.ticketId, input.step);
      return { action: "run" as const, idempotencyKey: key };
    })();
  }

  /** Persist a successful step result (contract id / tx hash / arbitrary output). */
  completeStep(input: {
    ticketId: string;
    step: number;
    result?: Record<string, unknown>;
    contractId?: string;
    txHash?: string;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    const persistedResult = {
      ...(input.result ?? {}),
      ...(input.contractId ? { contractId: input.contractId } : {}),
      ...(input.txHash ? { txHash: input.txHash } : {}),
    };
    this.db
      .prepare(
        `UPDATE factory_saga_steps
            SET status = 'completed', result = ?, contract_id = ?, tx_hash = ?,
                error = NULL, completed_at = ?
          WHERE ticket_id = ? AND step = ?`,
      )
      .run(
        Object.keys(persistedResult).length ? JSON.stringify(persistedResult) : null,
        input.contractId ?? null,
        input.txHash ?? null,
        now,
        input.ticketId,
        input.step,
      );
  }

  failStep(input: {
    ticketId: string;
    step: number;
    error: string;
    now?: number;
  }): void {
    this.db
      .prepare(
        `UPDATE factory_saga_steps
            SET status = 'failed', error = ?, completed_at = ?
          WHERE ticket_id = ? AND step = ?`,
      )
      .run(input.error, input.now ?? Date.now(), input.ticketId, input.step);
  }

  markStepCompensated(ticketId: string, step: number, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE factory_saga_steps SET status = 'compensated', completed_at = ?
          WHERE ticket_id = ? AND step = ?`,
      )
      .run(now, ticketId, step);
  }

  /**
   * Update saga header with optimistic concurrency. Throws when another worker
   * changed the saga between read and write.
   */
  updateSaga(input: {
    ticketId: string;
    expectedVersion: number;
    currentStep?: number;
    status?: FactoryStatusValue;
    error?: string | null;
    now?: number;
  }): SagaRecord {
    const saga = this.getSaga(input.ticketId);
    if (!saga) throw new Error(`saga ${input.ticketId} not found`);
    const result = this.db
      .prepare(
        `UPDATE factory_sagas
            SET current_step = ?, status = ?, error = ?, updated_at = ?, version = version + 1
          WHERE ticket_id = ? AND version = ?`,
      )
      .run(
        input.currentStep ?? saga.currentStep,
        input.status ?? saga.status,
        input.error === undefined ? saga.error : input.error,
        input.now ?? Date.now(),
        input.ticketId,
        input.expectedVersion,
      );
    if (result.changes === 0) throw new SagaConcurrencyError(input.ticketId);
    return this.getSaga(input.ticketId)!;
  }

  /** Append an immutable audit event for a saga transition. */
  appendEvent(input: {
    ticketId: string;
    step?: number;
    event: string;
    detail?: Record<string, unknown>;
    now?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO factory_saga_events (ticket_id, step, event, detail, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.ticketId,
        input.step ?? null,
        input.event,
        input.detail ? JSON.stringify(input.detail) : null,
        input.now ?? Date.now(),
      );
  }

  listEvents(ticketId: string): Array<{
    step: number | null;
    event: string;
    detail: Record<string, unknown> | null;
    createdAt: number;
  }> {
    const rows = this.db
      .prepare(
        "SELECT * FROM factory_saga_events WHERE ticket_id = ? ORDER BY id ASC",
      )
      .all(ticketId) as Record<string, unknown>[];
    return rows.map((row) => ({
      step: (row.step as number | null) ?? null,
      event: row.event as string,
      detail: row.detail ? (JSON.parse(row.detail as string) as Record<string, unknown>) : null,
      createdAt: row.created_at as number,
    }));
  }

  /**
   * Build a compensating cleanup plan from the steps that actually produced
   * external side effects. Returned newest-first so it can be executed safely.
   */
  buildCompensationPlan(ticketId: string): CompensationPlanEntry[] {
    return this.listSteps(ticketId)
      .filter((step) => step.status === "completed" || step.status === "failed")
      .filter((step) => step.contractId || COMPENSABLE_ACTIONS[step.name])
      .reverse()
      .map((step) => ({
        step: step.step,
        name: step.name,
        action: COMPENSABLE_ACTIONS[step.name] ?? `cleanup_${step.name}`,
        contractId: step.contractId,
      }));
  }

  /** Sagas that have not progressed within `staleMs`, for restart recovery. */
  listResumable(staleMs: number, now = Date.now()): SagaRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM factory_sagas
          WHERE status IN ('in_progress','failed')
            AND updated_at <= ?
          ORDER BY updated_at ASC`,
      )
      .all(now - staleMs) as Record<string, unknown>[];
    return rows.map((row) => ({
      ticketId: row.ticket_id as string,
      creator: row.creator as string,
      daoName: row.dao_name as string,
      params: JSON.parse(row.params as string) as Record<string, unknown>,
      currentStep: row.current_step as number,
      status: row.status as FactoryStatusValue,
      version: row.version as number,
      error: (row.error as string | null) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }));
  }

  private mapStep(row: Record<string, unknown>): SagaStepRecord {
    return {
      ticketId: row.ticket_id as string,
      step: row.step as number,
      name: row.name as string,
      idempotencyKey: row.idempotency_key as string,
      status: row.status as SagaStepRecord["status"],
      result: row.result ? (JSON.parse(row.result as string) as Record<string, unknown>) : null,
      contractId: (row.contract_id as string | null) ?? null,
      txHash: (row.tx_hash as string | null) ?? null,
      attempts: row.attempts as number,
      error: (row.error as string | null) ?? null,
      startedAt: (row.started_at as number | null) ?? null,
      completedAt: (row.completed_at as number | null) ?? null,
    };
  }
}

/** Compensating action per step (mirrors EPIC-005). */
export const COMPENSABLE_ACTIONS: Record<string, string> = {
  validate_input: "no_op",
  reserve_name: "release_name_reservation",
  create_registry: "delete_registry_entry",
  deploy_membership_sbt: "cleanup_sbt_contract",
  deploy_membership_tree: "cleanup_tree_contract",
  deploy_voting: "cleanup_voting_contract",
  deploy_comments: "cleanup_comments_contract",
  initialize_treasury: "refund_treasury",
  register_search: "remove_search_index_entry",
  verify_first_vote: "no_op",
  complete: "no_op",
};

export const factorySagaStore = new FactorySagaStore();
