-- ============================================
-- Migration 017: Abuse-detection enforcement and dispute-case linkage (ZV-111)
-- ============================================
-- Graduated enforcement (flag -> hold -> block) for payments flagged by
-- abuseDetection.ts, plus a metadata-only case record for the dispute
-- center. Evidence bundles are restricted to payment metadata; this schema
-- intentionally has no column that could carry a vote nullifier, ballot
-- commitment, or membership proof (see docs/abuse-detection-policy.md).

CREATE TABLE IF NOT EXISTS payment_holds (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  payment_ref TEXT NOT NULL,
  action TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  patterns TEXT NOT NULL,
  confidence REAL NOT NULL,
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at TEXT,
  resolution TEXT
);

CREATE INDEX IF NOT EXISTS idx_dispute_cases_hold ON dispute_cases(hold_id);
CREATE INDEX IF NOT EXISTS idx_dispute_cases_tenant ON dispute_cases(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dispute_cases_status ON dispute_cases(status);
