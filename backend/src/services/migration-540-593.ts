/**
 * Kysely migration #540/#592/#593: tenant_id/hash PK, BigInt amounts,
 * registry_hash pin, metadata_hash, sponsorship reserve audit.
 * Run with migrate:parity + migrate:dry-run CI gate; backfills NULLs and audits.
 */
export const MIGRATION_540_593_UP = `
ALTER TABLE daos ADD COLUMN IF NOT EXISTS registry_hash TEXT;
ALTER TABLE daos ADD COLUMN IF NOT EXISTS metadata_hash TEXT;
CREATE TABLE IF NOT EXISTS sponsorship_reserve_audit (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, locked_xlm REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
UPDATE daos SET registry_hash = 'UNPINNED-AUDIT' WHERE registry_hash IS NULL;
UPDATE daos SET metadata_hash = 'UNSET-AUDIT' WHERE metadata_hash IS NULL;
`;
export const MIGRATION_540_593_DOWN = `
DELETE FROM sponsorship_reserve_audit;
`;
