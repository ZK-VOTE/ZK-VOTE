/**
 * Resumable DAO bootstrap saga.
 *
 * Creating a DAO is a five-step cross-contract flow with several
 * non-compensable effects (append-only Merkle insertion, SBT mint). Soroban has
 * no multi-contract atomic commit, so a crash between steps used to leave a
 * silent half-provisioned DAO. This service records every step in a durable,
 * atomically-written checkpoint and only advances after the previous step is
 * confirmed.
 *
 * Exactly-once properties:
 *   - `registry` uses `create_dao_idempotent(key)` on-chain, so even a crash
 *     after submission but before checkpointing cannot create a second DAO.
 *   - every other step is derived from the stable `daoId` and a step key; the
 *     executor must treat a replay of a `done` step as a no-op (documented in
 *     `ProvisioningExecutor`).
 *   - a completed step is never re-executed by `retry`.
 *
 * The checkpoint file is queryable through the backend status endpoint, so an
 * operator or the onboarding UI can render "resume from step N".
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectConfusableMixedScript } from "../utils/confusables.js";

export const DEFAULT_BOOTSTRAP_STEPS = [
  "registry",
  "membership-sbt",
  "membership-tree",
  "commitment",
  "voting-vk",
] as const;

export type BootstrapStepId = (typeof DEFAULT_BOOTSTRAP_STEPS)[number] | string;

export type StepStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped";

export type SagaStatus =
  | "running"
  | "completed"
  | "failed"
  | "abandoned";

export interface BootstrapParams {
  /** Human-readable DAO name. */
  name: string;
  /** Stellar address of the creator/admin. */
  creator: string;
  membershipOpen: boolean;
  membersCanPropose: boolean;
  metadataCid?: string;
  /** Initial member commitment, if the creator provides one up front. */
  commitment?: string;
  [extra: string]: unknown;
}

export interface StepRecord {
  id: BootstrapStepId;
  status: StepStatus;
  attempts: number;
  /** Deterministic key the executor can pass to an idempotent contract call. */
  idempotencyKey: string;
  daoId?: number;
  txHash?: string;
  lastError?: string;
  result?: Record<string, unknown>;
  updatedAt: string;
}

export interface ProvisioningRecord {
  key: string;
  version: 1;
  status: SagaStatus;
  currentStep: BootstrapStepId | null;
  daoId: number | null;
  params: BootstrapParams;
  steps: StepRecord[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  abandonedAt?: string;
}

export interface ExecutorContext {
  key: string;
  step: BootstrapStepId;
  stepKey: string;
  daoId: number | null;
  params: BootstrapParams;
  previous: Record<string, Record<string, unknown>>;
}

export interface ExecutorResult {
  daoId?: number;
  txHash?: string;
  detail?: Record<string, unknown>;
}

export interface ProvisioningExecutor {
  /**
   * Execute (or resume) one step. Must be idempotent with respect to
   * `ctx.stepKey` / `ctx.daoId`: replaying a step that already committed on
   * chain should return success with the existing result, not create a second
   * object.
   */
  execute(ctx: ExecutorContext): Promise<ExecutorResult>;
  /**
   * Best-effort compensation used by `abandon`. Omit for non-compensable steps
   * (append-only tree insertion, SBT mint).
   */
  compensate?(ctx: ExecutorContext): Promise<void>;
}

export type ExecutorMap = Record<string, ProvisioningExecutor>;

export interface ProvisioningOptions {
  stateDir?: string;
  steps?: readonly BootstrapStepId[];
  now?: () => Date;
}

export class ProvisioningError extends Error {
  constructor(
    message: string,
    readonly code:
      | "NOT_FOUND"
      | "STEP_NOT_CONFIGURED"
      | "INVALID_STATE"
      | "CHECKPOINT_CORRUPT"
      | "INVALID_NAME",
  ) {
    super(message);
    this.name = "ProvisioningError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeKey(key: string): string {
  const clean = key.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new ProvisioningError(
      "idempotency key must be 32 bytes of hex",
      "INVALID_STATE",
    );
  }
  return clean;
}

function stepKey(key: string, step: string): string {
  return sha256(`${key}:${step}`);
}

/**
 * File-backed saga coordinator. Writes are `tmp + rename` so a process kill
 * cannot leave a truncated JSON checkpoint.
 */
export class DaoProvisioningService {
  private readonly stateDir: string;
  private readonly steps: readonly BootstrapStepId[];
  private readonly now: () => Date;
  private readonly executors: ExecutorMap;
  private readonly inFlight = new Map<string, Promise<ProvisioningRecord>>();

  constructor(executors: ExecutorMap, options: ProvisioningOptions = {}) {
    this.executors = executors;
    this.steps = options.steps ?? DEFAULT_BOOTSTRAP_STEPS;
    this.now = options.now ?? (() => new Date());
    this.stateDir =
      options.stateDir ??
      process.env.DAO_PROVISIONING_DIR ??
      path.join(tmpdir(), "zkvote-dao-provisioning");
  }

  private fileFor(key: string): string {
    return path.join(this.stateDir, `${key}.json`);
  }

  private async load(key: string): Promise<ProvisioningRecord | null> {
    try {
      const raw = await readFile(this.fileFor(key), "utf8");
      const parsed = JSON.parse(raw) as ProvisioningRecord;
      if (parsed.version !== 1 || parsed.key !== key) {
        throw new ProvisioningError(
          `checkpoint for ${key} is not a v1 record`,
          "CHECKPOINT_CORRUPT",
        );
      }
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (err instanceof ProvisioningError) throw err;
      throw new ProvisioningError(
        `could not read checkpoint for ${key}: ${(err as Error).message}`,
        "CHECKPOINT_CORRUPT",
      );
    }
  }

  private async save(record: ProvisioningRecord): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    const file = this.fileFor(record.key);
    const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
    record.updatedAt = this.now().toISOString();
    await writeFile(tmp, JSON.stringify(record, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, file);
  }

  private newRecord(key: string, params: BootstrapParams): ProvisioningRecord {
    const timestamp = this.now().toISOString();
    return {
      key,
      version: 1,
      status: "running",
      currentStep: null,
      daoId: null,
      params,
      steps: this.steps.map((id) => ({
        id,
        status: "pending",
        attempts: 0,
        idempotencyKey: stepKey(key, id),
        updatedAt: timestamp,
      })),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  /** Start a bootstrap; returns the existing record for a duplicate key. */
  async start(
    rawKey: string,
    params: BootstrapParams,
  ): Promise<ProvisioningRecord> {
    const nameCheck = detectConfusableMixedScript(params.name);
    if (nameCheck.confusable) {
      throw new ProvisioningError(
        `DAO name rejected by naming policy: ${nameCheck.reason}`,
        "INVALID_NAME",
      );
    }

    const key = normalizeKey(rawKey);
    const existing = await this.load(key);
    if (existing) return existing;
    const record = this.newRecord(key, params);
    await this.save(record);
    return this.run(record);
  }

  /**
   * Resume a failed/running saga. Completed steps are skipped; a failed step is
   * retried with the same `stepKey`. Safe to call concurrently in one process.
   */
  async retry(rawKey: string): Promise<ProvisioningRecord> {
    const key = normalizeKey(rawKey);
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const record = await this.load(key);
    if (!record) {
      throw new ProvisioningError(`no bootstrap for ${key}`, "NOT_FOUND");
    }
    if (record.status === "completed") return record;
    if (record.status === "abandoned") {
      throw new ProvisioningError(
        `bootstrap ${key} was abandoned`,
        "INVALID_STATE",
      );
    }

    for (const step of record.steps) {
      if (step.status === "running" || step.status === "failed") {
        step.status = "pending";
        step.lastError = undefined;
      }
    }
    record.status = "running";
    await this.save(record);
    return this.run(record);
  }

  async get(rawKey: string): Promise<ProvisioningRecord | null> {
    return this.load(normalizeKey(rawKey));
  }

  private async run(record: ProvisioningRecord): Promise<ProvisioningRecord> {
    if (this.inFlight.has(record.key)) {
      return this.inFlight.get(record.key)!;
    }

    const operation = (async () => {
      for (const step of record.steps) {
        if (step.status === "done" || step.status === "skipped") continue;
        const executor = this.executors[step.id];
        if (!executor) {
          record.status = "failed";
          record.currentStep = step.id;
          step.status = "failed";
          step.lastError = `no executor configured for step ${step.id}`;
          await this.save(record);
          return record;
        }

        record.currentStep = step.id;
        step.status = "running";
        step.attempts += 1;
        await this.save(record);

        const previous: Record<string, Record<string, unknown>> = {};
        for (const prior of record.steps) {
          if (prior.result) previous[String(prior.id)] = prior.result;
        }

        try {
          const result = await executor.execute({
            key: record.key,
            step: step.id,
            stepKey: step.idempotencyKey,
            daoId: record.daoId,
            params: record.params,
            previous,
          });
          step.status = "done";
          step.daoId = result.daoId ?? record.daoId ?? undefined;
          step.txHash = result.txHash;
          step.result = result.detail;
          step.updatedAt = this.now().toISOString();
          if (result.daoId != null) record.daoId = result.daoId;
        } catch (err) {
          step.status = "failed";
          step.lastError = (err as Error).message;
          step.updatedAt = this.now().toISOString();
          record.status = "failed";
          await this.save(record);
          return record;
        }
        await this.save(record);
      }

      record.status = "completed";
      record.currentStep = null;
      record.completedAt = this.now().toISOString();
      await this.save(record);
      return record;
    })().finally(() => {
      this.inFlight.delete(record.key);
    });

    this.inFlight.set(record.key, operation);
    return operation;
  }

  /**
   * Explicitly abandon a half-created DAO. Compensable steps are unwound in
   * reverse order; non-compensable effects are listed in the record for manual
   * operator action. This is never called automatically because a transient
   * RPC failure should be retried, not rolled back.
   */
  async abandon(rawKey: string): Promise<ProvisioningRecord> {
    const key = normalizeKey(rawKey);
    const record = await this.load(key);
    if (!record) {
      throw new ProvisioningError(`no bootstrap for ${key}`, "NOT_FOUND");
    }
    if (record.status === "completed") {
      throw new ProvisioningError(
        "cannot abandon a completed bootstrap",
        "INVALID_STATE",
      );
    }

    for (let i = record.steps.length - 1; i >= 0; i--) {
      const step = record.steps[i];
      if (step.status !== "done") continue;
      const executor = this.executors[step.id];
      if (!executor?.compensate) continue;
      try {
        await executor.compensate({
          key: record.key,
          step: step.id,
          stepKey: step.idempotencyKey,
          daoId: record.daoId,
          params: record.params,
          previous: {},
        });
        step.status = "skipped";
      } catch (err) {
        step.lastError = `compensation failed: ${(err as Error).message}`;
      }
      step.updatedAt = this.now().toISOString();
    }

    record.status = "abandoned";
    record.abandonedAt = this.now().toISOString();
    await this.save(record);
    return record;
  }
}
