// @ts-nocheck
/**
 * Durable Job Queue with Leases (ZV-069)
 *
 * Workers atomically claim jobs (CAS on status), hold them with renewable
 * leases, and ack/nack on completion.  Expired leases return to 'retrying'
 * so another worker can pick them up.  Jobs that exceed max_attempts move to
 * 'dead' (dead-letter) for investigation.
 *
 * All writes are synchronous SQLite statements so they run in one transaction
 * and cannot race with concurrent claims in the same process.  For multi-
 * process deployments WAL mode is assumed (configured elsewhere).
 */

import { getDb } from "./db.js";
import { createLogger } from "./logger.js";

const logger = createLogger("durable-jobs");

export const DEFAULT_LEASE_MS    = 60_000;   // 1 minute
export const DEFAULT_MAX_ATTEMPTS = 5;

export interface JobInput {
  job_type: string;
  payload?: Record<string, unknown>;
  business_key?: string;
  max_attempts?: number;
  run_after?: number; // epoch-ms; omit for immediate
}

export interface Job {
  id: number;
  business_key: string | null;
  job_type: string;
  payload: string;
  status: "ready" | "leased" | "retrying" | "dead";
  lease_expires_at: number | null;
  attempt_count: number;
  max_attempts: number;
  run_after: number;
  created_at: number;
  updated_at: number;
}

export interface JobQueueHealth {
  ready: number;
  leased: number;
  retrying: number;
  dead: number;
  oldest_ready_age_ms: number | null;
}

/**
 * Enqueue a new job.  If a `business_key` is provided and a live job with
 * that key already exists (status != 'dead'), the call is a no-op and returns
 * the existing job id.
 */
export function enqueueJob(input: JobInput): number {
  const db = getDb();
  const now = Date.now();
  const payload = JSON.stringify(input.payload ?? {});
  const runAfter = input.run_after ?? now;
  const maxAttempts = input.max_attempts ?? DEFAULT_MAX_ATTEMPTS;

  if (input.business_key) {
    const existing = db.prepare(
      "SELECT id FROM jobs WHERE business_key = ? AND status != 'dead'"
    ).get(input.business_key) as { id: number } | undefined;
    if (existing) {
      logger.debug("job_enqueue_dedup", { job_type: input.job_type, business_key: input.business_key, existing_id: existing.id });
      return existing.id;
    }
  }

  const result = db.prepare(`
    INSERT INTO jobs (job_type, payload, business_key, max_attempts, run_after, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(input.job_type, payload, input.business_key ?? null, maxAttempts, runAfter, now, now);

  const id = result.lastInsertRowid as number;
  logger.info("job_enqueued", { id, job_type: input.job_type, business_key: input.business_key ?? null });
  return id;
}

/**
 * Atomically claim the next available job for `job_type`.
 * Returns the job or null if none is available.
 */
export function claimJob(job_type: string, leaseDurationMs = DEFAULT_LEASE_MS): Job | null {
  const db = getDb();
  const now = Date.now();
  const leaseExpires = now + leaseDurationMs;

  // Single atomic UPDATE + SELECT; SQLite's RETURNING clause needs 3.35+.
  // Fallback: SELECT then UPDATE inside a transaction.
  let claimed: Job | null = null;
  const tx = db.transaction(() => {
    const row = db.prepare(`
      SELECT id FROM jobs
      WHERE job_type = ?
        AND status IN ('ready', 'retrying')
        AND run_after <= ?
        AND (lease_expires_at IS NULL OR lease_expires_at < ?)
      ORDER BY run_after ASC, id ASC
      LIMIT 1
    `).get(job_type, now, now) as { id: number } | undefined;

    if (!row) return;

    db.prepare(`
      UPDATE jobs
      SET status          = 'leased',
          lease_expires_at = ?,
          attempt_count   = attempt_count + 1,
          updated_at      = ?
      WHERE id = ? AND status IN ('ready', 'retrying')
    `).run(leaseExpires, now, row.id);

    claimed = db.prepare("SELECT * FROM jobs WHERE id = ?").get(row.id) as Job;
  });
  tx();

  if (claimed) {
    logger.info("job_claimed", { id: (claimed as Job).id, job_type, attempt: (claimed as Job).attempt_count });
  }
  return claimed;
}

/**
 * Extend the lease on an in-progress job to prevent it from being
 * reclaimed while the worker is still running.
 */
export function renewLease(jobId: number, leaseDurationMs = DEFAULT_LEASE_MS): boolean {
  const db = getDb();
  const now = Date.now();
  const result = db.prepare(`
    UPDATE jobs
    SET lease_expires_at = ?,
        updated_at       = ?
    WHERE id = ? AND status = 'leased'
  `).run(now + leaseDurationMs, now, jobId);
  return result.changes > 0;
}

/**
 * Acknowledge successful completion of a job and remove it from the queue.
 */
export function ackJob(jobId: number): void {
  const db = getDb();
  db.prepare("DELETE FROM jobs WHERE id = ? AND status = 'leased'").run(jobId);
  logger.info("job_acked", { id: jobId });
}

/**
 * Nack a job after failure.  Uses exponential back-off with jitter.
 * When attempt_count >= max_attempts, moves the job to 'dead'.
 */
export function nackJob(jobId: number, errorMsg?: string): void {
  const db = getDb();
  const now = Date.now();
  const job = db.prepare("SELECT attempt_count, max_attempts FROM jobs WHERE id = ?")
    .get(jobId) as { attempt_count: number; max_attempts: number } | undefined;

  if (!job) return;

  if (job.attempt_count >= job.max_attempts) {
    db.prepare(`
      UPDATE jobs
      SET status          = 'dead',
          lease_expires_at = NULL,
          updated_at      = ?
      WHERE id = ?
    `).run(now, jobId);
    logger.warn("job_dead_lettered", { id: jobId, attempts: job.attempt_count, error: errorMsg });
    return;
  }

  // Exponential back-off: 2^attempt * 1s + up to 1s jitter, capped at 10m.
  const backoffMs = Math.min(
    Math.pow(2, job.attempt_count) * 1_000 + Math.random() * 1_000,
    600_000,
  );
  db.prepare(`
    UPDATE jobs
    SET status           = 'retrying',
        lease_expires_at = NULL,
        run_after        = ?,
        updated_at       = ?
    WHERE id = ?
  `).run(now + backoffMs, now, jobId);
  logger.info("job_nacked", { id: jobId, next_attempt_at: now + backoffMs, error: errorMsg });
}

/**
 * Reclaim expired leases: jobs whose lease_expires_at < now are moved back
 * to 'retrying' so they can be picked up again.  Call periodically from a
 * maintenance loop.
 */
export function reclaimExpiredLeases(): number {
  const db = getDb();
  const now = Date.now();
  const result = db.prepare(`
    UPDATE jobs
    SET status           = 'retrying',
        lease_expires_at = NULL,
        updated_at       = ?
    WHERE status = 'leased' AND lease_expires_at < ?
  `).run(now, now);
  if (result.changes > 0) {
    logger.warn("job_leases_reclaimed", { count: result.changes });
  }
  return result.changes;
}

/**
 * Health snapshot for observability.
 */
export function getQueueHealth(): JobQueueHealth {
  const db = getDb();
  const counts = db.prepare(`
    SELECT status, COUNT(*) as n FROM jobs GROUP BY status
  `).all() as Array<{ status: string; n: number }>;
  const byStatus: Record<string, number> = {};
  for (const row of counts) byStatus[row.status] = row.n;

  const oldestRow = db.prepare(`
    SELECT run_after FROM jobs
    WHERE status IN ('ready','retrying') AND run_after <= ?
    ORDER BY run_after ASC LIMIT 1
  `).get(Date.now()) as { run_after: number } | undefined;

  return {
    ready:   byStatus["ready"]    ?? 0,
    leased:  byStatus["leased"]   ?? 0,
    retrying: byStatus["retrying"] ?? 0,
    dead:    byStatus["dead"]     ?? 0,
    oldest_ready_age_ms: oldestRow ? Date.now() - oldestRow.run_after : null,
  };
}
