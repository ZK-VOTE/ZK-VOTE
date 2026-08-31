DROP INDEX IF EXISTS idx_relay_metadata_envelopes_kind;
DROP INDEX IF EXISTS idx_relay_metadata_envelopes_dao;
DROP INDEX IF EXISTS idx_relay_metadata_envelopes_key;
DROP TABLE IF EXISTS relay_metadata_envelopes;

DROP INDEX IF EXISTS idx_relay_session_capabilities_expires;
DROP INDEX IF EXISTS idx_relay_session_capabilities_dao;
DROP INDEX IF EXISTS idx_relay_session_capabilities_client;
DROP TABLE IF EXISTS relay_session_capabilities;
