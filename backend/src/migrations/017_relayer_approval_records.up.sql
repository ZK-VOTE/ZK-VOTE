-- Migration 017: Relayer Approval Records and Secret Rotation
-- Issue #962: Store approval records with tier/tx hash/expiry
-- Enables audit trail and compromise revocation

-- Approval records table
CREATE TABLE IF NOT EXISTS relayer_approval_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id TEXT NOT NULL UNIQUE,
  cosigner_id TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('hot', 'warm', 'cold')),
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  revocation_reason TEXT,
  secret_version INTEGER NOT NULL DEFAULT 1,
  
  -- Audit fields
  issuer_identity TEXT,
  request_id TEXT,
  
  -- Indexes for lookups
  INDEX idx_approval_tx_hash (tx_hash),
  INDEX idx_approval_expires (expires_at),
  INDEX idx_approval_cosigner (cosigner_id),
  INDEX idx_approval_secret_version (secret_version)
);

-- Approval secret versions table
-- Tracks approval secret rotation with overlap windows
CREATE TABLE IF NOT EXISTS relayer_approval_secrets (
  version INTEGER PRIMARY KEY,
  cosigner_id TEXT NOT NULL,
  secret_key TEXT NOT NULL, -- Stored encrypted in production
  activated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deprecated_at TEXT,
  revoked_at TEXT,
  revocation_reason TEXT,
  
  -- Overlap window for in-flight transactions
  overlap_window_ms INTEGER NOT NULL DEFAULT 300000, -- 5 minutes
  
  INDEX idx_secret_cosigner (cosigner_id),
  INDEX idx_secret_active (cosigner_id, activated_at, deprecated_at)
);

-- Approval audit events table
-- Records all approval lifecycle events for security monitoring
CREATE TABLE IF NOT EXISTS relayer_approval_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'approval_issued',
    'approval_used',
    'approval_revoked',
    'secret_rotated',
    'secret_compromised',
    'approval_rejected'
  )),
  approval_id TEXT,
  cosigner_id TEXT NOT NULL,
  tx_hash TEXT,
  tier TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT,
  reason TEXT,
  metadata TEXT, -- JSON blob for additional context
  
  INDEX idx_audit_timestamp (timestamp),
  INDEX idx_audit_event_type (event_type),
  INDEX idx_audit_cosigner (cosigner_id)
);

-- View for active approvals
CREATE VIEW IF NOT EXISTS active_relayer_approvals AS
SELECT 
  r.*,
  (r.used_at IS NULL AND r.revoked_at IS NULL AND datetime(r.expires_at) > datetime('now')) as is_valid,
  s.version as secret_version,
  s.deprecated_at as secret_deprecated_at
FROM relayer_approval_records r
LEFT JOIN relayer_approval_secrets s ON r.secret_version = s.version
WHERE r.revoked_at IS NULL;

-- View for expired/revoked approvals (for cleanup)
CREATE VIEW IF NOT EXISTS inactive_relayer_approvals AS
SELECT *
FROM relayer_approval_records
WHERE revoked_at IS NOT NULL 
   OR datetime(expires_at) <= datetime('now')
   OR used_at IS NOT NULL;
