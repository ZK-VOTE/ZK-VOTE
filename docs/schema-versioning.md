# Database Schema Versioning

## Overview

The ZKVote backend uses SQLite (via `better-sqlite3`) for persistent storage, with a
Postgres-compatible parity track for production deployments.  Schema versioning ensures
databases created by different versions of the backend remain compatible and safe to use.

## Current Version: 19

`SCHEMA_VERSION` is the single source of truth and lives in
`backend/src/services/schema-version.ts`.  It must equal the count of applied migration
pairs.  A drift guard (`checkSchemaDrift()`) runs at startup and in CI.

## Version History

| Version | SQLite migration(s)                              | Summary                                                |
|---------|--------------------------------------------------|--------------------------------------------------------|
| 1       | 001_initial_schema                               | events, metadata, daos                                 |
| 2       | 002_add_partition_constraints                    | DAO partition constraints                              |
| 3       | 003_add_vote_receipts                            | vote_receipts table                                    |
| 4       | 004_add_analytics_indexes                        | Analytics indexes on events                            |
| 5       | 005_add_encrypted_content                        | Encrypted content support                              |
| 6       | 006_add_blind_credential_schemas                 | Blind credential schemas                               |
| 7       | 007_tenant_isolation_and_audit                   | Tenant isolation + audit tables                        |
| 8       | 008_add_backup_key_metadata                      | Backup key metadata                                    |
| 9       | 009_add_privacy_analytics                        | Privacy analytics tables                               |
| 10      | 010_canonical_proof_hash                         | Canonical proof hash column                            |
| 11      | 011_proposal_lifecycle_notifications             | Proposal lifecycle notification queue                  |
| 12      | 012_relay_metadata_encryption                    | Relay metadata encryption                              |
| 13      | 013_privacy_proof_commitments                    | Privacy proof commitment table                         |
| 14      | 014_double_entry_ledger                          | Double-entry ledger                                    |
| 15      | 015_relayer_key_lifecycle                        | Relayer key lifecycle tracking                         |
| 16      | 016_spike_anchor_sep24_issuer_relayer            | SEP-24 anchor + issuer relayer tables                  |
| 17a     | 017_onboarding_funnel_metrics                    | Onboarding funnel metrics tables                       |
| 17b     | 017_relayer_approval_records                     | Relayer approval records + secret rotation             |
| 18      | 018_pow_challenges                               | Shared PoW challenge store (ZV-074 #918)               |
| 19      | 019_submission_state_machine                     | Durable vote submission state machine (ZV-078 #921)    |

## Migration Rules

| Change Type              | Severity | Action                          |
|-------------------------|----------|---------------------------------|
| Missing table           | ERROR    | Abort startup                   |
| Missing column          | MIGRATE  | Auto-add via ALTER TABLE        |
| Column type change      | ERROR    | Abort startup                   |
| Missing NOT NULL        | WARN     | Logged, no action               |
| Missing PRIMARY KEY     | ERROR    | Abort startup                   |
| Missing index           | WARN     | Logged, no action               |
| Extra column            | WARN     | Logged, no action               |
| Extra index             | WARN     | Logged, no action               |
| SCHEMA_VERSION drift    | ERROR    | Abort startup (production)      |

## Drift Guard

`checkSchemaDrift(db)` in `backend/src/services/schema-version.ts` verifies:

1. The number of applied migrations in `_migrations` equals `SCHEMA_VERSION`.
2. Every applied SQLite migration has a Postgres parity file (when `pgMigrationsDir` is passed).

Call it in CI and in `initDb()` with `throwOnDrift: true` for production.

## Adding a New Schema Version

1. Write `backend/src/migrations/0NN_description.{up,down}.sql` (SQLite).
2. Write `backend/src/migrations/postgres/0MM_description.{up,down}.sql` (Postgres parity).
3. Bump `SCHEMA_VERSION` in `backend/src/services/schema-version.ts`.
4. Update the Version History table above.
5. Run `checkSchemaDrift()` in tests to confirm zero drift.

## Postgres Parity

The `backend/src/migrations/postgres/` directory mirrors the SQLite migrations.
Key type differences: `SERIAL`/`BIGSERIAL` instead of `AUTOINCREMENT`,
`BOOLEAN` instead of `INTEGER 0/1`, `BIGINT` instead of `INTEGER` for
epoch-ms timestamps.
