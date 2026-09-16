/**
 * Dual-Write Bridge (issue #305)
 *
 * A relay cannot be cut over from SQLite to Postgres in one step: the schema
 * has to be proven under real traffic before anything depends on it. The bridge
 * mirrors every relay write into a shadow backend while the primary keeps
 * serving reads, so a cutover is rehearsed rather than attempted.
 *
 * Three modes, in the order a migration actually goes through them:
 *
 *   1. `off`          — SQLite only. The default; zero overhead.
 *   2. `shadow`       — primary SQLite, mirrored writes to Postgres. Shadow
 *                       failures are counted, not raised (unless
 *                       DB_DUAL_WRITE_STRICT). Reads still come from SQLite.
 *   3. `primary-swap` — DB_BACKEND=postgres with the bridge pointed back at
 *                       SQLite, so the old store stays warm for rollback.
 *
 * The bridge is deliberately at the *statement* level rather than the ORM
 * level: the relay's writes go through both raw `better-sqlite3` prepares and
 * Kysely, and only a statement-level seam catches both.
 */
import type { SqlExecutor } from "./migratePg.js";
export type DualWriteMode = "off" | "shadow" | "primary-swap";
export interface DualWriteStats {
    mode: DualWriteMode;
    /** Writes mirrored successfully to the shadow backend. */
    mirrored: number;
    /** Writes that failed on the shadow backend. */
    failed: number;
    /** Writes skipped because the shadow backend was unavailable. */
    skipped: number;
    /** Rows reconciled by `backfill()`. */
    backfilled: number;
    /** Divergences found by `verify()`. */
    divergences: number;
    lastError: string | null;
    lastMirrorAt: string | null;
}
/**
 * Resolve the bridge mode from configuration.
 *
 * Note that `primary-swap` is inferred, not configured: it is simply what
 * "dual write is on and the primary is already Postgres" means.
 */
export declare function resolveDualWriteMode(): DualWriteMode;
/**
 * Attach a shadow executor. Called once at boot when DB_DUAL_WRITE is on.
 *
 * The executor is passed in rather than built here so the bridge stays testable
 * and so the `primary-swap` direction (Postgres primary, SQLite shadow) reuses
 * the same code. Handing over an executor *is* the enable signal — the env flag
 * decides whether boot constructs one at all — so an explicit executor with
 * `DB_DUAL_WRITE` unset still comes up in `shadow`. Pass `mode` to override.
 */
export declare function initDualWrite(executor: SqlExecutor | null, mode?: DualWriteMode): DualWriteMode;
export declare function isDualWriteEnabled(): boolean;
export declare function getDualWriteStats(): DualWriteStats;
export declare function resetDualWriteStats(): void;
/**
 * Mirror one write to the shadow backend.
 *
 * Always returns — the caller's transaction on the primary must never be held
 * hostage by the shadow, except when DB_DUAL_WRITE_STRICT is set, which is what
 * you turn on for the final rehearsal before a cutover.
 */
export declare function mirrorWrite(sql: string, params?: unknown[]): Promise<boolean>;
/**
 * Mirror a batch inside a single shadow transaction.
 *
 * Used for the multi-statement relay writes (an event insert plus its partition
 * registry touch, say) so the shadow never observes a half-applied unit.
 */
export declare function mirrorBatch(statements: Array<{
    sql: string;
    params?: unknown[];
}>): Promise<boolean>;
export interface TableDivergence {
    table: string;
    primaryCount: number;
    shadowCount: number;
    delta: number;
}
/** Row-count reader for the primary store, injected so this module never
 *  imports `db.ts` (which would create a cycle through `kysely.ts`). */
export type PrimaryCounter = (table: string) => number | Promise<number>;
/**
 * Compare row counts between primary and shadow.
 *
 * Row counts are a coarse check by design: they are cheap enough to run on a
 * schedule against production, and any real divergence (a dropped mirror, a
 * constraint rejecting a row) shows up as a non-zero delta. Content-level
 * verification is the job of the backfill's checksum pass.
 */
export declare function verify(tables: string[], countPrimary: PrimaryCounter): Promise<TableDivergence[]>;
/**
 * Copy rows the shadow is missing.
 *
 * `rows` is supplied by the caller (read from the primary) rather than read
 * here, again to keep this module free of a dependency on `db.ts`. Inserts use
 * `ON CONFLICT DO NOTHING` so a backfill is safe to re-run and safe to run
 * concurrently with live mirroring.
 */
export declare function backfill(table: string, rows: Array<Record<string, unknown>>, conflictColumns: string[]): Promise<number>;
/** Tables the bridge mirrors and verifies. */
export declare const BRIDGED_TABLES: readonly ["daos", "events", "metadata", "partition_registry", "vote_receipts"];
//# sourceMappingURL=dualWrite.d.ts.map