import type { Database as DatabaseType } from "better-sqlite3";
import type { Kysely } from "kysely";
import { sql } from "kysely";
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

let deps: AntiSpamDeps | null = null;

/** Explicitly wire the anti-spam service's dependencies. */
export function initAntiSpam(d: AntiSpamDeps): void {
  deps = d;
}

function getDeps(): AntiSpamDeps {
  if (!deps) {
    throw new Error("anti-spam: initAntiSpam() must be called before use");
  }
  return deps;
}

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

export function checkCommitmentRateLimit(
  commitment: string,
  daoId: number,
  proposalId: number,
  maxPerWindow: number,
  windowMs: number,
): boolean {
  const { getDb, kysely, logger } = getDeps();
  const database = getDb();
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;

  const query = kysely
    .selectFrom("comment_submissions")
    .select("count")
    .where("commitment", "=", commitment)
    .where("dao_id", "=", daoId)
    .where("proposal_id", "=", proposalId)
    .where("window_start", "=", windowStart)
    .compile();

  const row = database.prepare(query.sql).get(...query.parameters) as
    | { count: number }
    | undefined;

  if (row && row.count >= maxPerWindow) {
    logger.warn("commitment_rate_limit_exceeded", {
      commitment: commitment.slice(0, 16),
      daoId,
      proposalId,
      count: row.count,
      max: maxPerWindow,
    });
    return false;
  }

  return true;
}

export function recordCommentSubmission(
  commitment: string,
  daoId: number,
  proposalId: number,
  windowMs: number,
): void {
  const { getDb, kysely } = getDeps();
  const database = getDb();
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;

  const query = kysely
    .insertInto("comment_submissions")
    .values({
      commitment,
      dao_id: daoId,
      proposal_id: proposalId,
      window_start: windowStart,
      count: 1,
    })
    .onConflict((oc) =>
      oc
        .columns(["commitment", "dao_id", "proposal_id", "window_start"])
        .doUpdateSet({ count: sql`count + 1` }),
    )
    .compile();

  database.prepare(query.sql).run(...query.parameters);
}

export function flagComment(
  commentId: number,
  daoId: number,
  proposalId: number,
  flaggerCommitment: string,
  flaggerNullifier: string,
  threshold: number,
): FlagResult {
  const { getDb, kysely, logger } = getDeps();
  const database = getDb();

  const existingQuery = kysely
    .selectFrom("comment_flags")
    .select("id")
    .where("comment_id", "=", commentId)
    .where("dao_id", "=", daoId)
    .where("proposal_id", "=", proposalId)
    .where("flagger_nullifier", "=", flaggerNullifier)
    .compile();

  const existing = database
    .prepare(existingQuery.sql)
    .get(...existingQuery.parameters);

  if (existing) {
    const countQuery = kysely
      .selectFrom("comment_flags")
      .select(sql<number>`COUNT(*)`.as("cnt"))
      .where("comment_id", "=", commentId)
      .where("dao_id", "=", daoId)
      .where("proposal_id", "=", proposalId)
      .compile();

    const countRow = database
      .prepare(countQuery.sql)
      .get(...countQuery.parameters) as { cnt: number };

    logger.info("comment_flag_duplicate", { commentId, daoId, proposalId });
    return {
      success: false,
      hidden: countRow.cnt >= threshold,
      flagCount: countRow.cnt,
      threshold,
    };
  }

  const insertFlagQuery = kysely
    .insertInto("comment_flags")
    .values({
      comment_id: commentId,
      dao_id: daoId,
      proposal_id: proposalId,
      flagger_commitment: flaggerCommitment,
      flagger_nullifier: flaggerNullifier,
    })
    .compile();

  database.prepare(insertFlagQuery.sql).run(...insertFlagQuery.parameters);

  const countQuery = kysely
    .selectFrom("comment_flags")
    .select(sql<number>`COUNT(*)`.as("cnt"))
    .where("comment_id", "=", commentId)
    .where("dao_id", "=", daoId)
    .where("proposal_id", "=", proposalId)
    .compile();

  const countRow = database
    .prepare(countQuery.sql)
    .get(...countQuery.parameters) as { cnt: number };

  const hidden = countRow.cnt >= threshold;

  if (hidden) {
    const insertHiddenQuery = kysely
      .insertInto("hidden_comments")
      .values({
        comment_id: commentId,
        dao_id: daoId,
        proposal_id: proposalId,
        flag_count: countRow.cnt,
        hidden_at: sql`datetime('now')`,
      })
      .onConflict((oc) =>
        oc.columns(["comment_id", "dao_id", "proposal_id"]).doUpdateSet({
          flag_count: countRow.cnt,
          hidden_at: sql`datetime('now')`,
        }),
      )
      .compile();

    database
      .prepare(insertHiddenQuery.sql)
      .run(...insertHiddenQuery.parameters);

    logger.info("comment_auto_hidden", {
      commentId,
      daoId,
      proposalId,
      flagCount: countRow.cnt,
      threshold,
    });
  }

  logger.info("comment_flagged", {
    commentId,
    daoId,
    proposalId,
    flagCount: countRow.cnt,
    threshold,
    hidden,
  });

  return { success: true, hidden, flagCount: countRow.cnt, threshold };
}

export function getFlagStatus(
  commentId: number,
  daoId: number,
  proposalId: number,
): FlagStatus {
  const { getDb, kysely } = getDeps();
  const database = getDb();

  const flagCountQuery = kysely
    .selectFrom("comment_flags")
    .select(sql<number>`COUNT(*)`.as("cnt"))
    .where("comment_id", "=", commentId)
    .where("dao_id", "=", daoId)
    .where("proposal_id", "=", proposalId)
    .compile();

  const flagCount = database
    .prepare(flagCountQuery.sql)
    .get(...flagCountQuery.parameters) as { cnt: number };

  const hiddenQuery = kysely
    .selectFrom("hidden_comments")
    .select("comment_id")
    .where("comment_id", "=", commentId)
    .where("dao_id", "=", daoId)
    .where("proposal_id", "=", proposalId)
    .compile();

  const hidden = database
    .prepare(hiddenQuery.sql)
    .get(...hiddenQuery.parameters);

  return {
    flagged: flagCount.cnt > 0,
    hidden: !!hidden,
    flagCount: flagCount.cnt,
  };
}

export function getHiddenCommentIds(
  daoId: number,
  proposalId: number,
): number[] {
  const { getDb, kysely } = getDeps();
  const database = getDb();
  const query = kysely
    .selectFrom("hidden_comments")
    .select("comment_id")
    .where("dao_id", "=", daoId)
    .where("proposal_id", "=", proposalId)
    .compile();

  const rows = database.prepare(query.sql).all(...query.parameters) as Array<{
    comment_id: number;
  }>;

  return rows.map((r) => r.comment_id);
}