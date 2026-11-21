-- Migration 008: SEP-24 Session Persistence (ZV-119)
-- Store SEP-24 interactive sessions in shared database so they survive
-- process restarts and are accessible across replicas.

CREATE TABLE IF NOT EXISTS sep24_sessions (
    session_id UUID PRIMARY KEY,
    asset VARCHAR(10) NOT NULL CHECK (asset IN ('USDC', 'EURC')),
    account VARCHAR(56) NOT NULL,
    original_origin VARCHAR(512) NOT NULL,
    popup_nonce CHAR(32) NOT NULL,
    popup_nonce_consumed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_activity_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    
    -- Audit trail
    created_by_ip VARCHAR(45),
    
    CONSTRAINT sep24_sessions_check_expiry CHECK (expires_at > created_at)
);

-- Session tokens table (supports rotation)
CREATE TABLE IF NOT EXISTS sep24_session_tokens (
    id SERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES sep24_sessions(session_id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL, -- SHA-256 hex
    issued_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    rotated_from_token_id INTEGER REFERENCES sep24_session_tokens(id),
    is_current BOOLEAN NOT NULL DEFAULT TRUE,
    revoked_at TIMESTAMP WITH TIME ZONE,
    
    CONSTRAINT sep24_token_unique UNIQUE (token_hash),
    CONSTRAINT sep24_token_active CHECK ((is_current = TRUE AND revoked_at IS NULL) OR (is_current = FALSE))
);

-- Completions table already exists (from sep24-session-security.ts)
-- but we'll ensure it references the new sessions table
CREATE TABLE IF NOT EXISTS sep24_completions (
    id SERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES sep24_sessions(session_id),
    transaction_id VARCHAR(64) NOT NULL,
    asset VARCHAR(10) NOT NULL,
    account VARCHAR(56) NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT sep24_completion_unique UNIQUE (transaction_id)
);

-- Audit log for security events
CREATE TABLE IF NOT EXISTS sep24_security_events (
    id SERIAL PRIMARY KEY,
    session_id UUID REFERENCES sep24_sessions(session_id),
    event_type VARCHAR(50) NOT NULL,
    details JSONB,
    ip_address VARCHAR(45),
    user_agent TEXT,
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_sep24_sessions_account ON sep24_sessions(account);
CREATE INDEX IF NOT EXISTS idx_sep24_sessions_expires_at ON sep24_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sep24_sessions_created_at ON sep24_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sep24_session_tokens_session_id ON sep24_session_tokens(session_id);
CREATE INDEX IF NOT EXISTS idx_sep24_session_tokens_current ON sep24_session_tokens(session_id, is_current) WHERE is_current = TRUE;
CREATE INDEX IF NOT EXISTS idx_sep24_completions_session_id ON sep24_completions(session_id);
CREATE INDEX IF NOT EXISTS idx_sep24_security_events_session_id ON sep24_security_events(session_id);
CREATE INDEX IF NOT EXISTS idx_sep24_security_events_occurred_at ON sep24_security_events(occurred_at DESC);

-- Registry pins table (ZV-118)
CREATE TABLE IF NOT EXISTS registry_pins (
    dao_id INTEGER PRIMARY KEY,
    registry_id VARCHAR(56) NOT NULL,
    code_hash CHAR(64) NOT NULL, -- SHA-256 hex of WASM
    version INTEGER NOT NULL DEFAULT 1,
    pinned_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    pinned_by VARCHAR(56),
    last_verified_at TIMESTAMP WITH TIME ZONE,
    
    CONSTRAINT registry_pins_unique_registry UNIQUE (registry_id, code_hash)
);

-- Registry pin rotation audit log (ZV-118)
CREATE TABLE IF NOT EXISTS registry_pin_audit (
    id SERIAL PRIMARY KEY,
    dao_id INTEGER NOT NULL,
    old_registry_id VARCHAR(56),
    old_code_hash CHAR(64),
    new_registry_id VARCHAR(56) NOT NULL,
    new_code_hash CHAR(64) NOT NULL,
    rotated_by VARCHAR(56) NOT NULL,
    reason TEXT,
    rotated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_registry_pin_audit_dao_id ON registry_pin_audit(dao_id, rotated_at DESC);
CREATE INDEX IF NOT EXISTS idx_registry_pins_registry_id ON registry_pins(registry_id);
