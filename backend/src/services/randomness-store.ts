/**
 * Durable, replayable proposal-ordering state.
 *
 * Replaces the `orderingStore = new Map()` in routes/randomness.ts. Shares,
 * VDF checkpoints and the finalized ordering are persisted with versioning;
 * an immutable commit record is appended at finalization so late shares can
 * never mutate a committed ordering and GET /verify/:daoId can recompute
 * everything from stored inputs, even after a process restart.
 */

import crypto from "crypto";
import { getDb } from "./db.js";
import { ensureDurableSchema, type SqliteLike } from "./durable-schema.js";

export interface ThresholdShare {
  authorityId: string;
  shareHex: string;
  submittedAt: number;
}

export interface OrderingState {
  daoId: number;
  version: number;
  vdfInput: string;
  vdfOutput: string;
  vdfCheckpoints: string[];
  vdfIterations: number;
  shares: ThresholdShare[];
  requiredShares: number;
  combinedSeed: string;
  ordering: number[];
  proposalIds: number[];
  finalizedAt: number | null;
  replayNonce: string;
  committed: boolean;
  createdAt: number;
  updatedAt: number;
}

export class OrderingCommittedError extends Error {
  constructor(daoId: number) {
    super(`ordering for DAO ${daoId} is committed and immutable`);
    this.name = "OrderingCommittedError";
  }
}

type Db = SqliteLike & {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
};

export class RandomnessStore {
  constructor(private readonly db: Db = getDb() as unknown as Db) {
    ensureDurableSchema(db);
  }

  /** Seed a new ordering. Idempotent: an existing state is left untouched. */
  create(input: {
    daoId: number;
    vdfInput: string;
    vdfOutput: string;
    vdfCheckpoints: string[];
    vdfIterations: number;
    proposalIds: number[];
    requiredShares: number;
    replayNonce: string;
    now?: number;
  }): OrderingState {
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO randomness_orderings
           (dao_id, version, vdf_input, vdf_output, vdf_checkpoints, vdf_iterations,
            proposal_ids, required_shares, replay_nonce, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.daoId,
        input.vdfInput,
        input.vdfOutput,
        JSON.stringify(input.vdfCheckpoints),
        input.vdfIterations,
        JSON.stringify(input.proposalIds),
        input.requiredShares,
        input.replayNonce,
        now,
        now,
      );
    return this.get(input.daoId)!;
  }

  get(daoId: number): OrderingState | null {
    const row = this.db
      .prepare("SELECT * FROM randomness_orderings WHERE dao_id = ?")
      .get(daoId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      daoId,
      version: row.version as number,
      vdfInput: row.vdf_input as string,
      vdfOutput: row.vdf_output as string,
      vdfCheckpoints: JSON.parse(row.vdf_checkpoints as string) as string[],
      vdfIterations: row.vdf_iterations as number,
      shares: this.getShares(daoId),
      requiredShares: row.required_shares as number,
      combinedSeed: row.combined_seed as string,
      ordering: JSON.parse(row.ordering as string) as number[],
      proposalIds: JSON.parse(row.proposal_ids as string) as number[],
      finalizedAt: (row.finalized_at as number | null) ?? null,
      replayNonce: row.replay_nonce as string,
      committed: row.committed === 1,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  getShares(daoId: number): ThresholdShare[] {
    const rows = this.db
      .prepare(
        "SELECT authority_id, share_hex, submitted_at FROM randomness_shares WHERE dao_id = ? ORDER BY submitted_at ASC",
      )
      .all(daoId) as Array<{
      authority_id: string;
      share_hex: string;
      submitted_at: number;
    }>;
    return rows.map((r) => ({
      authorityId: r.authority_id,
      shareHex: r.share_hex,
      submittedAt: r.submitted_at,
    }));
  }

  /**
   * Add a threshold share. The UNIQUE(dao_id, authority_id) constraint makes
   * duplicate submission a no-op across replicas; committed orderings reject
   * every late share inside one transaction.
   */
  addShare(input: {
    daoId: number;
    authorityId: string;
    shareHex: string;
    now?: number;
  }): { added: boolean; sharesReceived: number; requiredShares: number } {
    const now = input.now ?? Date.now();
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT committed, finalized_at, required_shares FROM randomness_orderings WHERE dao_id = ?",
        )
        .get(input.daoId) as
        | { committed: number; finalized_at: number | null; required_shares: number }
        | undefined;
      if (!row) throw new Error("No pending randomness computation for this DAO");
      if (row.committed === 1 || row.finalized_at !== null) {
        throw new OrderingCommittedError(input.daoId);
      }
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO randomness_shares (dao_id, authority_id, share_hex, submitted_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(input.daoId, input.authorityId, input.shareHex, now);
      const count = (
        this.db
          .prepare("SELECT COUNT(*) AS count FROM randomness_shares WHERE dao_id = ?")
          .get(input.daoId) as { count: number }
      ).count;
      this.db
        .prepare("UPDATE randomness_orderings SET updated_at = ? WHERE dao_id = ?")
        .run(now, input.daoId);
      return {
        added: result.changes === 1,
        sharesReceived: count,
        requiredShares: row.required_shares,
      };
    })();
  }

  /**
   * Finalize atomically. `compute` derives {combinedSeed, ordering} from the
   * persisted VDF output and the persisted shares. A second finalize returns
   * the existing committed result (idempotent).
   */
  finalize(input: {
    daoId: number;
    compute: (state: OrderingState) => { combinedSeed: string; ordering: number[] };
    now?: number;
  }): OrderingState {
    const now = input.now ?? Date.now();
    return this.db.transaction(() => {
      const state = this.get(input.daoId);
      if (!state) throw new Error("No pending randomness computation for this DAO");
      if (state.finalizedAt !== null) return state;
      if (state.shares.length < state.requiredShares) {
        throw new Error(
          `Insufficient shares: received ${state.shares.length}, need ${state.requiredShares}`,
        );
      }
      const { combinedSeed, ordering } = input.compute(state);
      const payload = JSON.stringify({
        daoId: input.daoId,
        version: state.version,
        proposalIds: state.proposalIds,
        vdfOutput: state.vdfOutput,
        combinedSeed,
        ordering,
        replayNonce: state.replayNonce,
        authoritySet: state.shares.map((s) => s.authorityId),
        shareHashes: state.shares.map((s) =>
          crypto.createHash("sha256").update(s.shareHex).digest("hex"),
        ),
      });
      const payloadHash = crypto
        .createHash("sha256")
        .update(payload)
        .digest("hex");
      this.db
        .prepare(
          `UPDATE randomness_orderings
              SET combined_seed = ?, ordering = ?, finalized_at = ?, committed = 1,
                  version = version + 1, updated_at = ?
            WHERE dao_id = ? AND committed = 0`,
        )
        .run(combinedSeed, JSON.stringify(ordering), now, now, input.daoId);
      // Immutable audit record — triggers prevent UPDATE/DELETE.
      this.db
        .prepare(
          `INSERT OR IGNORE INTO randomness_commits
             (dao_id, version, payload_hash, payload, recorded_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.daoId, state.version + 1, payloadHash, payload, now);
      return this.get(input.daoId)!;
    })();
  }

  /** Authority set + hashes recorded at commit, for third-party audit. */
  getCommitRecord(daoId: number): {
    version: number;
    payloadHash: string;
    payload: Record<string, unknown>;
    recordedAt: number;
  } | null {
    const row = this.db
      .prepare(
        "SELECT * FROM randomness_commits WHERE dao_id = ? ORDER BY version DESC LIMIT 1",
      )
      .get(daoId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      version: row.version as number,
      payloadHash: row.payload_hash as string,
      payload: JSON.parse(row.payload as string) as Record<string, unknown>,
      recordedAt: row.recorded_at as number,
    };
  }
}

export const randomnessStore = new RandomnessStore();
