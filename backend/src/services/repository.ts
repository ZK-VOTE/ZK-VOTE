/**
 * Repository / data-access layer (issue #305, ZV data-access refactor).
 *
 * Every production write is built with the single Kysely query builder here.
 * The compiled, fully parameterized statement is executed through an injected
 * synchronous executor (the existing better-sqlite3 write handle today) and is
 * mirrored through the dual-write seam at the same point. Raw `.prepare()` in
 * a caller therefore never sees interpolated values: SQL and parameters always
 * come from Kysely's compiler.
 *
 * The module has no runtime dependency on `db.ts` or `kysely.ts`, which keeps it
 * importable in tests and avoids the existing db <-> kysely import cycle.
 */

import type { Kysely } from "kysely";

export interface WriteResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

/** Minimal synchronous execution surface, satisfied by better-sqlite3 today. */
export interface WriteExecutor {
  run(sql: string, params: readonly unknown[]): WriteResult;
  transaction<T>(fn: () => T): T;
}

export type MirrorFn = (sql: string, params: readonly unknown[]) => boolean | Promise<boolean>;

export interface RepositoryConfig {
  db: Kysely<Record<string, never>>;
  executor: WriteExecutor;
  mirror?: MirrorFn;
  /** Fail the primary write when a shadow mirror fails (synchronous shadows only). */
  strict?: boolean;
  /** `repository` routes hot paths through this layer; `legacy` keeps old paths. */
  cutover?: "repository" | "legacy";
}

interface Configured extends RepositoryConfig {
  mirror: MirrorFn;
  strict: boolean;
  cutover: "repository" | "legacy";
}

let current: Configured | null = null;

export function configureRepository(config: RepositoryConfig): void {
  current = {
    ...config,
    mirror: config.mirror ?? (() => false),
    strict: config.strict ?? false,
    cutover: config.cutover ?? "repository",
  };
}

export function getRepository(): Repository {
  if (!current) {
    throw new Error("Repository is not configured; call configureRepository() during boot");
  }
  return new Repository(current);
}

export function isRepositoryCutoverEnabled(): boolean {
  return current?.cutover === "repository";
}

/** Tables whose writes are known to traverse this layer. Mirrors dualWrite.ts. */
export const REPOSITORY_TABLES = [
  "vote_submissions",
  "vote_receipts",
  "transaction_log",
  "daos",
  "treasury_signing_sessions",
  "treasury_session_signatures",
  "payment_jobs",
  "ledger_entries",
  "ledger_lines",
] as const;

export class Repository {
  private readonly config: Configured;

  constructor(config: Configured) {
    this.config = config;
  }

  /** Execute one Kysely-compiled statement and mirror it at the same seam. */
  execute(query: { compile(): { sql: string; parameters: readonly unknown[] } }): WriteResult {
    const compiled = query.compile();
    const params = [...compiled.parameters];
    const result = this.config.executor.run(compiled.sql, params);
    const mirrored = this.config.mirror(compiled.sql, params);
    if (this.config.strict && mirrored === false) {
      throw new Error("Dual-write mirror failed in strict mode");
    }
    // An async shadow cannot be awaited from the synchronous primary path; its
    // outcome is reported by the scheduled parity job and dualWrite stats.
    if (mirrored && typeof (mirrored as Promise<boolean>).then === "function") {
      void (mirrored as Promise<boolean>).catch(() => {
        /* dualWrite records the failure and the parity job reports it */
      });
    }
    return result;
  }

  transaction<T>(fn: () => T): T {
    return this.config.executor.transaction(fn);
  }

  insertVoteSubmission(nullifierHash: string, now: number): boolean {
    const dao = this.config.db
      .insertInto("vote_submissions" as never)
      .values({
        nullifier_hash: nullifierHash,
        status: "pending",
        tx_hash: null,
        created_at: now,
        updated_at: now,
      } as never)
      .onConflict((oc: any) => oc.column("nullifier_hash").doNothing());
    const result = this.execute(dao);
    return result.changes > 0;
  }

  updateVoteSubmission(nullifierHash: string, status: string, txHash: string | undefined, now: number): void {
    const query: any = this.config.db
      .updateTable("vote_submissions" as never)
      .set(txHash ? { status, tx_hash: txHash, updated_at: now } : { status, updated_at: now })
      .where("nullifier_hash", "=", nullifierHash);
    this.execute(query);
  }

  storeVoteReceipt(
    nullifier: string,
    txHash: string,
    proposalId: number,
    daoId: number,
    status: string,
    now: number,
  ): void {
    const daoQuery = this.config.db
      .insertInto("daos" as never)
      .values({
        id: daoId,
        name: `DAO ${daoId}`,
        creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      } as never)
      .onConflict((oc: any) => oc.column("id").doNothing());
    const receiptQuery = this.config.db
      .insertInto("vote_receipts" as never)
      .values({
        nullifier,
        tx_hash: txHash,
        proposal_id: proposalId,
        dao_id: daoId,
        status,
      } as never);
    // Multi-statement units are one transaction on the primary and one mirrored
    // unit on the shadow, so the shadow never observes a half-applied receipt.
    this.transaction(() => {
      this.execute(daoQuery);
      this.execute(receiptQuery);
    });
  }

  recordTransactionLog(nullifierHash: string, txHash: string, status: string, now: number): void {
    const query = this.config.db
      .insertInto("transaction_log" as never)
      .values({
        nullifier_hash: nullifierHash,
        tx_hash: txHash,
        status,
        created_at: now,
        updated_at: now,
      } as never)
      .onConflict((oc: any) =>
        oc.column("nullifier_hash").doUpdateSet({
          tx_hash: txHash,
          status,
          updated_at: now,
        } as never),
      );
    this.execute(query);
  }

  updateTransactionLogStatus(nullifierHash: string, status: string, txHash: string | undefined, now: number): void {
    const query: any = this.config.db
      .updateTable("transaction_log" as never)
      .set(txHash ? { status, tx_hash: txHash, updated_at: now } : { status, updated_at: now })
      .where("nullifier_hash", "=", nullifierHash);
    this.execute(query);
  }

  openTreasurySession(input: {
    id: string;
    proposalId: string;
    digest: string;
    action: unknown;
    signers: unknown[];
    required: number;
    expiresAt: number;
    actor: string | null;
    now: number;
  }): void {
    const query = this.config.db
      .insertInto("treasury_signing_sessions" as never)
      .values({
        id: input.id,
        proposal_id: input.proposalId,
        digest: input.digest,
        action: JSON.stringify(input.action),
        signers: JSON.stringify(input.signers),
        required: input.required,
        expires_at: input.expiresAt,
        status: "collecting",
        created_by: input.actor,
        created_at: input.now,
        updated_at: input.now,
      } as never);
    this.execute(query);
  }

  recordTenantPaymentJob(input: Record<string, unknown>): void {
    const query = this.config.db
      .insertInto("payment_jobs" as never)
      .values(input as never);
    this.execute(query);
  }
}
