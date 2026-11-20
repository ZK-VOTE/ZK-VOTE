-- ============================================
-- Migration 008: Abuse-detection enforcement and dispute-case linkage (ZV-111, Postgres)
-- ============================================

CREATE TABLE IF NOT EXISTS payment_holds (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  payment_ref TEXT NOT NULL,
  action TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  patterns TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  thresholds_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'held',
  evidence TEXT NOT NULL,
  dispute_case_id TEXT,
  first_reviewer_id TEXT,
  first_review_at TEXT,
  first_review_reason TEXT,
  released_by TEXT,
  released_at TEXT,
  release_reason TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE INDEX IF NOT EXISTS idx_payment_holds_tenant ON payment_holds(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payment_holds_status ON payment_holds(status);
CREATE INDEX IF NOT EXISTS idx_payment_holds_payment_ref ON payment_holds(payment_ref);

CREATE TABLE IF NOT EXISTS dispute_cases (
  id TEXT PRIMARY KEY,
  class TEXT NOT NULL DEFAULT 'payment',
  tenant_id TEXT NOT NULL DEFAULT 'default',
  hold_id TEXT NOT NULL REFERENCES payment_holds(id),
  status TEXT NOT NULL DEFAULT 'open',
  evidence_bundle TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  resolved_at TEXT,
  resolution TEXT
);

CREATE INDEX IF NOT EXISTS idx_dispute_cases_hold ON dispute_cases(hold_id);
CREATE INDEX IF NOT EXISTS idx_dispute_cases_tenant ON dispute_cases(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dispute_cases_status ON dispute_cases(status);
