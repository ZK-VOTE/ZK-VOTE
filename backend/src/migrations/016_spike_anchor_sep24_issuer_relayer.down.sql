-- Rollback SPIKE-094, SPIKE-095, SPIKE-090, SPIKE-092

DROP TABLE IF EXISTS transaction_fees;
DROP TABLE IF EXISTS flow_migrations;
DROP TABLE IF EXISTS pending_flows;
DROP TABLE IF EXISTS issuer_rotations;
DROP TABLE IF EXISTS sep24_completions;
DROP TABLE IF EXISTS deposit_trustlines;
DROP TABLE IF EXISTS deposit_misroutes;
DROP TABLE IF EXISTS muxed_deposits;
