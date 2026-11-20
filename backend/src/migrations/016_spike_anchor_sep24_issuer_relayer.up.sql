-- SPIKE-094: Muxed-Account Deposit Attribution (#761)
-- SPIKE-095: SEP-24 Interactive Flow Session Security (#762)
-- SPIKE-090: USDC/EURC Issuer Rotation (#759)
-- SPIKE-092: Relayer Fee Economics (#760)

-- ── SPIKE-094: Muxed Deposit Routing ─────────────────────────────────────
-- Track deposits attributed to muxed accounts with proper routing information

CREATE TABLE IF NOT EXISTS muxed_deposits (
  deposit_id TEXT PRIMARY KEY,
  destination TEXT NOT NULL,          -- M... or G...
  base_account TEXT NOT NULL,         -- Always G...
  mux_id TEXT,                        -- NULL for G..., set for M...
  asset TEXT NOT NULL CHECK (asset IN ('USDC', 'EURC')),
  amount TEXT NOT NULL,
  anchor_txn_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('exchange', 'anchor')),
  attributed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(destination, anchor_txn_id)
);

CREATE INDEX idx_muxed_deposits_destination ON muxed_deposits(destination);
CREATE INDEX idx_muxed_deposits_base_account ON muxed_deposits(base_account);
CREATE INDEX idx_muxed_deposits_asset_date ON muxed_deposits(asset, attributed_at DESC);

-- Track deposit misroutes for audit and relayer fee adjustments
CREATE TABLE IF NOT EXISTS deposit_misroutes (
  incident_id TEXT PRIMARY KEY,
  deposit_id TEXT NOT NULL,
  original_destination TEXT NOT NULL,
  correct_destination TEXT NOT NULL,
  reason TEXT NOT NULL,
  resolved_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (deposit_id) REFERENCES muxed_deposits(deposit_id)
);

CREATE INDEX idx_deposit_misroutes_deposit_id ON deposit_misroutes(deposit_id);

-- Record trustline ownership for deposit destination validation
CREATE TABLE IF NOT EXISTS deposit_trustlines (
  account TEXT NOT NULL,
  asset TEXT NOT NULL CHECK (asset IN ('USDC', 'EURC', 'XLM')),
  issuer TEXT,                        -- NULL for XLM
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- SQLite PRIMARY KEY/UNIQUE constraints cannot contain expressions
  -- (unlike the Postgres flavor of this migration, which coalesced NULL
  -- issuer to '' here); plain-column composite key, see
  -- idx_deposit_trustlines_account_asset for the (account, asset) lookup
  -- actually used by muxed-deposit-router.ts.
  PRIMARY KEY (account, asset, issuer)
);

CREATE INDEX idx_deposit_trustlines_account_asset ON deposit_trustlines(account, asset);

-- ── SPIKE-095: SEP-24 Session Security ──────────────────────────────────
-- Secure session management for interactive deposit/withdrawal flows

CREATE TABLE IF NOT EXISTS sep24_completions (
  session_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  asset TEXT NOT NULL CHECK (asset IN ('USDC', 'EURC')),
  account TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id, transaction_id)
);

CREATE INDEX idx_sep24_completions_account_asset ON sep24_completions(account, asset);

-- ── SPIKE-090: Issuer Rotation ──────────────────────────────────────────
-- Track asset issuer changes and pending flow migrations

CREATE TABLE IF NOT EXISTS issuer_rotations (
  rotation_id TEXT PRIMARY KEY,
  asset TEXT NOT NULL CHECK (asset IN ('USDC', 'EURC')),
  old_issuer TEXT NOT NULL,
  new_issuer TEXT NOT NULL,
  effective_at INTEGER NOT NULL,      -- Unix timestamp in ms
  reason TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_issuer_rotations_asset_date ON issuer_rotations(asset, effective_at DESC);

-- Track pending payment flows across issuer rotations
CREATE TABLE IF NOT EXISTS pending_flows (
  flow_id TEXT PRIMARY KEY,
  asset TEXT NOT NULL CHECK (asset IN ('USDC', 'EURC')),
  account TEXT NOT NULL,
  amount TEXT NOT NULL,
  flow_type TEXT NOT NULL CHECK (flow_type IN ('deposit', 'withdrawal')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'paused', 'migrated')),
  issuer TEXT NOT NULL,
  rotation_id TEXT,                   -- Set when paused for rotation
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rotation_id) REFERENCES issuer_rotations(rotation_id)
);

CREATE INDEX idx_pending_flows_status_asset ON pending_flows(status, asset);
CREATE INDEX idx_pending_flows_account ON pending_flows(account);

-- Track flow migrations to new issuer
CREATE TABLE IF NOT EXISTS flow_migrations (
  flow_id TEXT NOT NULL,
  from_issuer TEXT NOT NULL,
  to_issuer TEXT NOT NULL,
  migrated_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (flow_id, migrated_at),
  FOREIGN KEY (flow_id) REFERENCES pending_flows(flow_id)
);

CREATE INDEX idx_flow_migrations_flow_id ON flow_migrations(flow_id);

-- ── SPIKE-092: Relayer Fee Economics ────────────────────────────────────
-- Track transaction fees for historical trend analysis and surge detection

CREATE TABLE IF NOT EXISTS transaction_fees (
  tx_hash TEXT PRIMARY KEY,
  fee_per_op INTEGER NOT NULL,        -- Stroops per operation
  op_count INTEGER NOT NULL,
  total_fee INTEGER NOT NULL,         -- Total stroops
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_transaction_fees_date ON transaction_fees(submitted_at DESC);
CREATE INDEX idx_transaction_fees_date_range ON transaction_fees(submitted_at) WHERE submitted_at > datetime('now', '-24 hours');
