# Database Schema Versioning

## Overview

The ZKVote backend uses SQLite (via `better-sqlite3`) for persistent storage of events,
DAO cache data, and metadata. Schema versioning ensures databases created by different
versions of the backend remain compatible and safe to use.

## Current Version: 2

## Version History

| Version | Changes                    |
|---------|----------------------------|
| 1       | Initial schema (events, metadata, daos) |
| 2       | Added anti-spam tables (comment_submissions, comment_flags, hidden_comments) and TTL optimization tables (ttl_tracking, ttl_cost_log) |

## Schema Definition

The expected schema is defined in `backend/src/services/db.ts` as the `EXPECTED_SCHEMA`
constant. The table index below is kept in sync with that constant by
`backend/test/schema-drift.test.js`; the test fails CI when they disagree.

<!-- schema-tables:start -->
- `events`
- `metadata`
- `daos`
- `comment_submissions`
- `comment_flags`
- `hidden_comments`
- `ttl_tracking`
- `ttl_cost_log`
- `auth_tokens`
- `auth_token_audit`
- `vote_submissions`
- `proposal_lifecycle_subscriptions`
- `proposal_lifecycle_notifications`
- `proof_commitments`
<!-- schema-tables:end -->

### Tables

#### `events`

Stores on-chain events with verification status for frontend notifications.

| Column       | Type    | Constraints                        |
|-------------|---------|------------------------------------|
| id          | INTEGER | PRIMARY KEY AUTOINCREMENT          |
| dao_id      | INTEGER | NOT NULL                           |
| type        | TEXT    | NOT NULL                           |
| data        | TEXT    | (nullable, JSON)                   |
| ledger      | INTEGER | (nullable)                         |
| tx_hash     | TEXT    | (nullable)                         |
| timestamp   | TEXT    | NOT NULL                           |
| verified    | INTEGER | DEFAULT 0                          |
| created_at  | TEXT    | DEFAULT CURRENT_TIMESTAMP          |

Unique constraint: `(dao_id, ledger, tx_hash, type)`

**Indexes:**
- `idx_events_dao_id` on `(dao_id)`
- `idx_events_type` on `(type)`
- `idx_events_timestamp` on `(timestamp DESC)`
- `idx_events_ledger` on `(ledger DESC)`
- `idx_events_dao_type` on `(dao_id, type)`

#### `metadata`

Key-value store for internal state tracking (e.g., last ledger, sync timestamps,
schema version).

| Column | Type | Constraints          |
|--------|------|----------------------|
| key    | TEXT | PRIMARY KEY          |
| value  | TEXT |                      |

#### `daos`

Cached DAO metadata from on-chain registry.

| Column              | Type    | Constraints               |
|--------------------|---------|---------------------------|
| id                 | INTEGER | PRIMARY KEY               |
| name               | TEXT    | NOT NULL                  |
| creator            | TEXT    | NOT NULL                  |
| membership_open    | INTEGER | DEFAULT 1                 |
| members_can_propose| INTEGER | DEFAULT 0                 |
| metadata_cid       | TEXT    | (nullable)                |
| member_count       | INTEGER | DEFAULT 0                 |
| updated_at         | TEXT    | DEFAULT CURRENT_TIMESTAMP |

#### `comment_submissions`

Tracks per-commitment comment rates for anti-spam rate limiting.

| Column       | Type    | Constraints               |
|-------------|---------|---------------------------|
| commitment  | TEXT    | PRIMARY KEY               |
| dao_id      | INTEGER | PRIMARY KEY               |
| proposal_id | INTEGER | PRIMARY KEY               |
| window_start| INTEGER | PRIMARY KEY               |
| count       | INTEGER | DEFAULT 0                 |

#### `comment_flags`

Stores community flags on comments for spam moderation.

| Column             | Type    | Constraints               |
|-------------------|---------|---------------------------|
| id                | INTEGER | PRIMARY KEY AUTOINCREMENT |
| comment_id        | INTEGER | NOT NULL                  |
| dao_id            | INTEGER | NOT NULL                  |
| proposal_id       | INTEGER | NOT NULL                  |
| flagger_commitment| TEXT    | NOT NULL                  |
| flagger_nullifier | TEXT    | NOT NULL                  |
| created_at        | TEXT    | DEFAULT CURRENT_TIMESTAMP |

Unique constraint: `(comment_id, dao_id, proposal_id, flagger_nullifier)`

#### `hidden_comments`

Comments that have been auto-hidden after reaching the flag threshold.

| Column       | Type    | Constraints               |
|-------------|---------|---------------------------|
| comment_id  | INTEGER | PRIMARY KEY               |
| dao_id      | INTEGER | PRIMARY KEY               |
| proposal_id | INTEGER | PRIMARY KEY               |
| flag_count  | INTEGER | DEFAULT 0                 |
| hidden_at   | TEXT    | DEFAULT CURRENT_TIMESTAMP |

#### `ttl_tracking`

Tracks last renewal time and remaining TTL for each contract entry, enabling
priority-based renewal scheduling.

| Column            | Type    | Constraints               |
|------------------|---------|---------------------------|
| entry_id         | TEXT    | PRIMARY KEY               |
| contract_id      | TEXT    | NOT NULL                  |
| dao_id           | INTEGER |                           |
| method           | TEXT    |                           |
| last_renewed_at  | TEXT    |                           |
| remaining_ledgers| INTEGER |                           |
| urgency          | TEXT    | DEFAULT 'unknown'         |

Indexes: `idx_ttl_tracking_urgency` (urgency), `idx_ttl_tracking_contract` (contract_id)

#### `ttl_cost_log`

Records each TTL renewal cycle for cost monitoring and optimization.

| Column           | Type    | Constraints               |
|-----------------|---------|---------------------------|
| id              | INTEGER | PRIMARY KEY AUTOINCREMENT |
| cycle_id        | TEXT    | NOT NULL                  |
| cycle_start     | TEXT    |                           |
| cycle_end       | TEXT    |                           |
| entries_renewed | INTEGER | DEFAULT 0                 |
| entries_skipped | INTEGER | DEFAULT 0                 |
| tx_count        | INTEGER | DEFAULT 0                 |
| total_fee_xlm   | REAL    | DEFAULT 0.0               |
| status          | TEXT    | DEFAULT 'pending'         |

Indexes: `idx_ttl_cost_cycle` (cycle_id)

## Validation Mechanism

On every startup, `initDb()` performs the following checks:

1. **Table existence** — Each expected table must exist. Missing tables cause startup
   to abort with `Database schema validation failed`.
2. **Column existence** — Each expected column must exist. Missing columns are
   automatically added via `ALTER TABLE ADD COLUMN`.
3. **Column types** — Declared types are compared (normalized for equivalent types
   like `INT`/`INTEGER`, `VARCHAR`/`TEXT`). Type mismatches cause startup abort.
4. **Index existence** — All defined indexes must exist. Missing indexes are logged
   as warnings. Extra unnamed indexes are silently ignored; extra named indexes
   are logged as warnings.
5. **Extra columns** — Columns present in the database but not in the expected
   schema are logged as warnings.

## Migration Rules

| Change Type              | Severity | Action                          |
|-------------------------|----------|---------------------------------|
| Missing table           | ERROR    | Abort startup                  |
| Missing column          | MIGRATE  | Auto-add via ALTER TABLE       |
| Column type change      | ERROR    | Abort startup                  |
| Missing NOT NULL        | WARN     | Logged, no action              |
| Missing PRIMARY KEY     | ERROR    | Abort startup                  |
| Missing index           | WARN     | Logged, no action              |
| Extra column            | WARN     | Logged, no action              |
| Extra index             | WARN     | Logged, no action              |

## Adding a New Schema Version

To add a new schema version (e.g., version 2):

1. Increment `CURRENT_SCHEMA_VERSION` in `db.ts`
2. Update `EXPECTED_SCHEMA` with new tables, columns, or indexes
3. Add migration logic to `applyMigrations()` if the change cannot be handled
   by the generic auto-add-column mechanism
4. Update this document with the new schema description
5. Add test cases covering the migration from the previous version

Missing tables or columns like the anti-spam and TTL tracking tables are auto-created
by the `CREATE TABLE IF NOT EXISTS` DDL in `initDb()`.

## Testing

Schema validation tests are in `backend/test/db.test.js`.
Anti-spam tests are in `backend/test/anti-spam.test.js`.
TTL optimization tests are in `backend/test/ttl.test.js`.
Run them with:

```bash
cd backend
npx tsx --test test/db.test.js test/anti-spam.test.js test/ttl.test.js
```

Or run all tests:

```bash
npm test
```
