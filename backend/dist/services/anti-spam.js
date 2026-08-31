import { initDb } from "./db.js";
import { log } from "./logger.js";
import { kysely } from "./kysely.js";
import { sql } from "kysely";
export function checkCommitmentRateLimit(commitment, daoId, proposalId, maxPerWindow, windowMs) {
    const database = initDb();
    const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
    const query = kysely
        .selectFrom("comment_submissions")
        .select("count")
        .where("commitment", "=", commitment)
        .where("dao_id", "=", daoId)
        .where("proposal_id", "=", proposalId)
        .where("window_start", "=", windowStart)
        .compile();
    const row = database.prepare(query.sql).get(...query.parameters);
    if (row && row.count >= maxPerWindow) {
        log("warn", "commitment_rate_limit_exceeded", {
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
export function recordCommentSubmission(commitment, daoId, proposalId, windowMs) {
    const database = initDb();
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
        .onConflict((oc) => oc
        .columns(["commitment", "dao_id", "proposal_id", "window_start"])
        .doUpdateSet({ count: sql `count + 1` }))
        .compile();
    database.prepare(query.sql).run(...query.parameters);
}
export function flagComment(commentId, daoId, proposalId, flaggerCommitment, flaggerNullifier, threshold) {
    const database = initDb();
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
            .select(sql `COUNT(*)`.as("cnt"))
            .where("comment_id", "=", commentId)
            .where("dao_id", "=", daoId)
            .where("proposal_id", "=", proposalId)
            .compile();
        const countRow = database
            .prepare(countQuery.sql)
            .get(...countQuery.parameters);
        log("info", "comment_flag_duplicate", { commentId, daoId, proposalId });
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
        .select(sql `COUNT(*)`.as("cnt"))
        .where("comment_id", "=", commentId)
        .where("dao_id", "=", daoId)
        .where("proposal_id", "=", proposalId)
        .compile();
    const countRow = database
        .prepare(countQuery.sql)
        .get(...countQuery.parameters);
    const hidden = countRow.cnt >= threshold;
    if (hidden) {
        const insertHiddenQuery = kysely
            .insertInto("hidden_comments")
            .values({
            comment_id: commentId,
            dao_id: daoId,
            proposal_id: proposalId,
            flag_count: countRow.cnt,
            hidden_at: sql `datetime('now')`,
        })
            .onConflict((oc) => oc.columns(["comment_id", "dao_id", "proposal_id"]).doUpdateSet({
            flag_count: countRow.cnt,
            hidden_at: sql `datetime('now')`,
        }))
            .compile();
        database
            .prepare(insertHiddenQuery.sql)
            .run(...insertHiddenQuery.parameters);
        log("info", "comment_auto_hidden", {
            commentId,
            daoId,
            proposalId,
            flagCount: countRow.cnt,
            threshold,
        });
    }
    log("info", "comment_flagged", {
        commentId,
        daoId,
        proposalId,
        flagCount: countRow.cnt,
        threshold,
        hidden,
    });
    return { success: true, hidden, flagCount: countRow.cnt, threshold };
}
export function getFlagStatus(commentId, daoId, proposalId) {
    const database = initDb();
    const flagCountQuery = kysely
        .selectFrom("comment_flags")
        .select(sql `COUNT(*)`.as("cnt"))
        .where("comment_id", "=", commentId)
        .where("dao_id", "=", daoId)
        .where("proposal_id", "=", proposalId)
        .compile();
    const flagCount = database
        .prepare(flagCountQuery.sql)
        .get(...flagCountQuery.parameters);
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
export function getHiddenCommentIds(daoId, proposalId) {
    const database = initDb();
    const query = kysely
        .selectFrom("hidden_comments")
        .select("comment_id")
        .where("dao_id", "=", daoId)
        .where("proposal_id", "=", proposalId)
        .compile();
    const rows = database.prepare(query.sql).all(...query.parameters);
    return rows.map((r) => r.comment_id);
}
//# sourceMappingURL=anti-spam.js.map