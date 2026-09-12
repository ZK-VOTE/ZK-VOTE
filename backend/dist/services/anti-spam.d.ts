import type { DB } from "../generated/db-types.js";
import type { LoggerPort } from "./interfaces.js";
/**
 * Dependencies the anti-spam service needs, injected explicitly via
 * `initAntiSpam` (called by the composition root) so the service never
 * imports `db.js`/`kysely.js` module globals (#358).
 */
export interface AntiSpamDeps {
    /** Getter for the current better-sqlite3 connection (write path). */
    getDb: () => DatabaseType;
    /** Kysely query builder used to compile SQL. */
    kysely: Kysely<DB>;
    /** Structured logger. */
    logger: LoggerPort;
}
/** Explicitly wire the anti-spam service's dependencies. */
export declare function initAntiSpam(d: AntiSpamDeps): void;
export interface FlagResult {
    success: boolean;
    hidden: boolean;
    flagCount: number;
    threshold: number;
}
export interface FlagStatus {
    flagged: boolean;
    hidden: boolean;
    flagCount: number;
}
export declare function checkCommitmentRateLimit(commitment: string, daoId: number, proposalId: number, maxPerWindow: number, windowMs: number): boolean;
export declare function recordCommentSubmission(commitment: string, daoId: number, proposalId: number, windowMs: number): void;
export declare function flagComment(commentId: number, daoId: number, proposalId: number, flaggerCommitment: string, flaggerNullifier: string, threshold: number): FlagResult;
export declare function getFlagStatus(commentId: number, daoId: number, proposalId: number): FlagStatus;
export declare function getHiddenCommentIds(daoId: number, proposalId: number): number[];
//# sourceMappingURL=anti-spam.d.ts.map