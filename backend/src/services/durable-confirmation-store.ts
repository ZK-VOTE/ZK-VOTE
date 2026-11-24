/**
 * Durable Confirmation-Queue Store — ZV-073 (#917)
 *
 * Persists the pending-waiter set from the confirmation queue so that hashes
 * which were queued but not yet confirmed before a process restart are
 * automatically re-enqueued on startup.
 *
 * Layout: a single NDJSON file at <storeDir>/pending-waiters.ndjson.
 * Each line holds one waiter record:
 *
 *   { "op": "add",    "hash": "...", "opts": {...}, "enqueuedAt": <ms> }
 *   { "op": "remove", "hash": "..." }
 *
 * On startup, replay() folds the log into a map (add → insert, remove → delete)
 * and returns the surviving entries so the caller can re-enqueue them.
 *
 * Writes are synchronous (appendFileSync) so a mid-write crash leaves a
 * partially-written last line, which the parser skips gracefully.
 *
 * The file is compacted (rewritten) whenever it exceeds MAX_LINES to prevent
 * unbounded growth.
 */

import fs from "node:fs";
import path from "node:path";
import { log } from "./logger.js";
import type { WaitForTransactionOptions } from "./confirmation-queue.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface WaiterRecord {
  hash: string;
  opts: Required<
    Pick<
      WaitForTransactionOptions,
      "maxWaitMs" | "maxAttempts" | "initialDelayMs" | "maxDelayMs" | "backoffFactor" | "jitter"
    >
  >;
  enqueuedAt: number;
}

type WalRecord =
  | { op: "add"; hash: string; opts: WaiterRecord["opts"]; enqueuedAt: number }
  | { op: "remove"; hash: string };

// ── Store ────────────────────────────────────────────────────────────────────

const MAX_LINES = 10_000;

export class DurableConfirmationStore {
  private readonly filePath: string;
  private lineCount = 0;

  constructor(storeDir: string) {
    fs.mkdirSync(storeDir, { recursive: true });
    this.filePath = path.join(storeDir, "pending-waiters.ndjson");
    // Count existing lines so we know when to compact.
    if (fs.existsSync(this.filePath)) {
      try {
        const content = fs.readFileSync(this.filePath, "utf8");
        this.lineCount = content.split("\n").filter(Boolean).length;
      } catch { /* ignore */ }
    }
  }

  /** Record that a hash has been enqueued.  Synchronous for crash safety. */
  add(hash: string, opts: WaiterRecord["opts"]): void {
    const record: WalRecord = { op: "add", hash, opts, enqueuedAt: Date.now() };
    this._append(record);
  }

  /** Record that a hash has been resolved and is no longer pending. */
  remove(hash: string): void {
    const record: WalRecord = { op: "remove", hash };
    this._append(record);
  }

  /**
   * Replay the WAL and return all hashes that were added but never removed.
   * Those are the ones the caller must re-enqueue.  Also compacts the file so
   * it only contains the surviving "add" records.
   */
  replay(): WaiterRecord[] {
    const surviving = new Map<string, WaiterRecord>();

    if (!fs.existsSync(this.filePath)) return [];

    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return [];
    }

    for (const line of raw.split("\n").filter(Boolean)) {
      let record: WalRecord;
      try {
        record = JSON.parse(line) as WalRecord;
      } catch {
        continue;
      }
      if (record.op === "add") {
        surviving.set(record.hash, { hash: record.hash, opts: record.opts, enqueuedAt: record.enqueuedAt });
      } else if (record.op === "remove") {
        surviving.delete(record.hash);
      }
    }

    const records = [...surviving.values()];

    // Compact: rewrite the file with only the surviving "add" records.
    this._compact(records);

    log("info", "confirmation_store_replay", { replayed: records.length });
    return records;
  }

  /** Remove the WAL file (useful in tests). */
  clear(): void {
    try { fs.unlinkSync(this.filePath); } catch { /* ignore */ }
    this.lineCount = 0;
  }

  private _append(record: WalRecord): void {
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
    this.lineCount++;
    if (this.lineCount >= MAX_LINES) {
      // Compact in the background — do not block the caller.
      setImmediate(() => this._compactFromFile());
    }
  }

  private _compactFromFile(): void {
    try {
      const surviving = new Map<string, WaiterRecord>();
      const raw = fs.readFileSync(this.filePath, "utf8");
      for (const line of raw.split("\n").filter(Boolean)) {
        let record: WalRecord;
        try { record = JSON.parse(line) as WalRecord; } catch { continue; }
        if (record.op === "add") {
          surviving.set(record.hash, { hash: record.hash, opts: record.opts, enqueuedAt: record.enqueuedAt });
        } else if (record.op === "remove") {
          surviving.delete(record.hash);
        }
      }
      this._compact([...surviving.values()]);
    } catch { /* ignore — compaction is best-effort */ }
  }

  private _compact(records: WaiterRecord[]): void {
    const lines = records
      .map((r): WalRecord => ({ op: "add", hash: r.hash, opts: r.opts, enqueuedAt: r.enqueuedAt }))
      .map((r) => JSON.stringify(r))
      .join("\n");
    const content = records.length > 0 ? `${lines}\n` : "";
    fs.writeFileSync(this.filePath, content, "utf8");
    this.lineCount = records.length;
  }
}
