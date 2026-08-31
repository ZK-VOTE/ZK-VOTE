-- ============================================
-- Rollback Migration 001 (Postgres): Drop initial schema
-- Parity target: ../001_initial_schema.down.sql
-- ============================================

DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS daos;
DROP TABLE IF EXISTS metadata;
DROP TABLE IF EXISTS partition_registry;
DROP TABLE IF EXISTS _migrations;
