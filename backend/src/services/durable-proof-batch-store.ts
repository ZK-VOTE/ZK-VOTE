/**
 * Durable Proof-Batch Store — ZV-072 (#916)
 *
 * Extends ProofBatchCollector with persistence so pending batches survive a
 * process restart.  The store uses a simple append-only WAL file per
 * (daoId, proposalId) pair that can be replayed on startup to re-enqueue any
 * votes that were buffered at the time of the crash.
 *
 * File layout (one file per batch key):
 *   <walDir>/<daoId>_<proposalId>.ndjson
 *
 * Each line is a JSON record:
 *   { "op": "enqueue", "vote": BatchVoteEntry, "ts": <epoch-ms> }
 *   { "op": "flush",   "count": N,             "ts": <epoch-ms> }
 *
 * On replay, all enqueues up to the latest flush are discarded; enqueues after
 * the last flush are still pending and are re-submitted to the collector.
 *
 * The store is intentionally simple: it does not perform compaction (the files
 * are small and short-lived in practice), and it uses synchronous file I/O so
 * that an `enqueue()` call cannot corrupt the WAL if the process dies mid-write.
 */

import fs from "node:fs";
import path from "node:path";
import { log } from "./logger.js";
import type { BatchVoteEntry } from "./proof-batch-collector.js";

// ── Types ────────────────────────────────────────────────────────────────────

type WalRecord =
  | { op: "enqueue"; vote: BatchVoteEntry; ts: number }
  | { op: "flush"; count: number; ts: number };

export interface ReplayResult {
  daoId: number;
  proposalId: number;
  votes: BatchVoteEntry[];
  skipped: number;
}

// ── Store ────────────────────────────────────────────────────────────────────

export class DurableProofBatchStore {
  private readonly walDir: string;

  constructor(walDir: string) {
    this.walDir = walDir;
    fs.mkdirSync(walDir, { recursive: true });
  }

  private walPath(daoId: number, proposalId: number): string {
    return path.join(this.walDir, `${daoId}_${proposalId}.ndjson`);
  }

  /** Append an enqueue record to the WAL.  Synchronous for crash safety. */
  recordEnqueue(daoId: number, proposalId: number, vote: BatchVoteEntry): void {
    const record: WalRecord = { op: "enqueue", vote, ts: Date.now() };
    fs.appendFileSync(this.walPath(daoId, proposalId), `${JSON.stringify(record)}\n`, "utf8");
  }

  /** Append a flush record and optionally remove the file when the batch is fully flushed. */
  recordFlush(daoId: number, proposalId: number, count: number): void {
    const filePath = this.walPath(daoId, proposalId);
    if (!fs.existsSync(filePath)) return;
    const record: WalRecord = { op: "flush", count, ts: Date.now() };
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
    // After a flush the file is no longer needed; remove it so replay is clean.
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best-effort; a stale flush record is harmless on replay.
    }
  }

  /**
   * Read all WAL files in `walDir` and return the votes that had not yet been
   * flushed when the process stopped.  Call this once on startup before
   * creating the ProofBatchCollector.
   */
  replayAll(): ReplayResult[] {
    const results: ReplayResult[] = [];
    let files: string[];
    try {
      files = fs.readdirSync(this.walDir).filter((f) => f.endsWith(".ndjson"));
    } catch {
      return results;
    }

    for (const file of files) {
      const match = /^(\d+)_(\d+)\.ndjson$/.exec(file);
      if (!match) continue;
      const daoId = Number(match[1]);
      const proposalId = Number(match[2]);
      const result = this._replayFile(path.join(this.walDir, file), daoId, proposalId);
      if (result.votes.length > 0 || result.skipped > 0) {
        results.push(result);
      }
    }

    return results;
  }

  private _replayFile(filePath: string, daoId: number, proposalId: number): ReplayResult {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      return { daoId, proposalId, votes: [], skipped: 0 };
    }

    const lines = raw.split("\n").filter(Boolean);
    const pending: BatchVoteEntry[] = [];
    let flushedCount = 0;

    for (const line of lines) {
      let record: WalRecord;
      try {
        record = JSON.parse(line) as WalRecord;
      } catch {
        continue;
      }

      if (record.op === "enqueue") {
        pending.push(record.vote);
      } else if (record.op === "flush") {
        // The last flush record indicates how many votes were sent; remove them.
        const sent = Math.min(record.count, pending.length);
        pending.splice(0, sent);
        flushedCount += sent;
      }
    }

    log("info", "proof_batch_wal_replay", {
      daoId,
      proposalId,
      replayed: pending.length,
      skipped: flushedCount,
    });

    // Remove the WAL file — the caller will re-enqueue the pending votes, which
    // creates a fresh file.
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }

    return { daoId, proposalId, votes: pending, skipped: flushedCount };
  }

  /** Delete all WAL files (useful in tests). */
  clear(): void {
    try {
      for (const f of fs.readdirSync(this.walDir)) {
        if (f.endsWith(".ndjson")) fs.unlinkSync(path.join(this.walDir, f));
      }
    } catch { /* ignore */ }
  }
}
