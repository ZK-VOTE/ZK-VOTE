// Unit tests for the refactored anti-spam service (#358).
//
// These tests exercise the service through its injected dependency surface
// (`initAntiSpam`) with an in-memory SQLite database and a real Kysely
// builder over it — no `data/zkvote.db`, no `db.js`/`kysely.js` module
// globals. They prove the refactor's acceptance criterion: a service that
// can be unit-tested with mocks.

import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import {
  initAntiSpam,
  checkCommitmentRateLimit,
  recordCommentSubmission,
  flagComment,
  getFlagStatus,
  getHiddenCommentIds,
  type AntiSpamDeps,
} from "../../src/services/anti-spam.js";
import type { DB } from "../../src/generated/db-types.js";

/** In-memory database with the three anti-spam tables. */
function makeDb() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE comment_submissions (
      commitment TEXT NOT NULL,
      dao_id INTEGER NOT NULL,
      proposal_id INTEGER NOT NULL,
      window_start INTEGER NOT NULL,
      count INTEGER DEFAULT 0,
      PRIMARY KEY (commitment, dao_id, proposal_id, window_start)
    );
    CREATE TABLE comment_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER NOT NULL,
      dao_id INTEGER NOT NULL,
      proposal_id INTEGER NOT NULL,
      flagger_commitment TEXT NOT NULL,
      flagger_nullifier TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(comment_id, dao_id, proposal_id, flagger_nullifier)
    );
    CREATE TABLE hidden_comments (
      comment_id INTEGER NOT NULL,
      dao_id INTEGER NOT NULL,
      proposal_id INTEGER NOT NULL,
      flag_count INTEGER DEFAULT 0,
      hidden_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (comment_id, dao_id, proposal_id)
    );
  `);
  return database;
}

/** Build a mock dependency set; each test can override specific members. */
function mockDeps(
  database = makeDb(),
  overrides: Partial<AntiSpamDeps> = {},
): AntiSpamDeps & { database: Database.Database; kysely: Kysely<DB> } {
  const kysely = new Kysely<DB>({
    dialect: new SqliteDialect({ database }),
  });
  const base: AntiSpamDeps = {
    getDb: () => database,
    kysely,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      log: () => {},
    },
  };
  return { database, kysely, ...base, ...overrides };
}

test("anti-spam: writes go through the injected deps, not module globals", () => {
  // Re-init with a fresh in-memory DB; the service must write/read ONLY
  // through the injected handles (the production wiring from another test
  // file may still be present in module state — this overwrites it).
  const { database, kysely, logger } = mockDeps();
  const spy: string[] = [];
  initAntiSpam({
    getDb: () => database,
    kysely,
    logger: { ...logger, log: (l, e, m) => spy.push(e) },
  });

  recordCommentSubmission("bb22", 2, 7, 60_000);
  recordCommentSubmission("bb22", 2, 7, 60_000);

  // The row must exist in OUR database instance (injected getDb honored).
  const row = database
    .prepare("SELECT count FROM comment_submissions WHERE commitment = ?")
    .get("bb22") as { count: number };
  assert.equal(row.count, 2);
  assert.equal(checkCommitmentRateLimit("bb22", 2, 7, 2, 60_000), false);
  assert.ok(spy.includes("comment_flagged") === false);

  database.close();
  void kysely.destroy();
});

test("anti-spam: commitment rate limit counts per window and allows new windows", () => {
  const { database, kysely } = mockDeps();
  initAntiSpam({ getDb: () => database, kysely, logger: mockDeps().logger });

  const windowMs = 60_000;
  recordCommentSubmission("aa11", 1, 42, windowMs);
  recordCommentSubmission("aa11", 1, 42, windowMs);

  // Under the limit → allowed.
  assert.equal(checkCommitmentRateLimit("aa11", 1, 42, 3, windowMs), true);

  // One more record hits the cap → blocked for the same window.
  recordCommentSubmission("aa11", 1, 42, windowMs);
  assert.equal(checkCommitmentRateLimit("aa11", 1, 42, 3, windowMs), false);

  // A different proposal is unaffected (per-proposal scoping).
  assert.equal(checkCommitmentRateLimit("aa11", 1, 43, 3, windowMs), true);

  database.close();
  void kysely.destroy();
});

test("anti-spam: flags accumulate, duplicate flagger is rejected, auto-hide at threshold", () => {
  const { database, kysely, logger } = mockDeps();
  initAntiSpam({ getDb: () => database, kysely, logger });

  const flag = (nullifier: string) =>
    flagComment(7, 1, 42, `commitment-${nullifier}`, nullifier, 2);

  // First flag: recorded, not yet hidden.
  assert.deepEqual(flag("n1"), {
    success: true,
    hidden: false,
    flagCount: 1,
    threshold: 2,
  });

  // Same flagger again → duplicate rejected (UNIQUE constraint path).
  assert.equal(flag("n1").success, false);

  // Second distinct flagger reaches the threshold → auto-hidden.
  assert.deepEqual(flag("n2"), {
    success: true,
    hidden: true,
    flagCount: 2,
    threshold: 2,
  });

  assert.deepEqual(getFlagStatus(7, 1, 42), {
    flagged: true,
    hidden: true,
    flagCount: 2,
  });
  assert.deepEqual(getHiddenCommentIds(1, 42), [7]);
  // Other DAO/proposal scopes see nothing.
  assert.deepEqual(getHiddenCommentIds(1, 43), []);

  database.close();
  void kysely.destroy();
});
