-- Rollback Migration 017: Relayer Approval Records

DROP VIEW IF EXISTS inactive_relayer_approvals;
DROP VIEW IF EXISTS active_relayer_approvals;
DROP TABLE IF EXISTS relayer_approval_audit;
DROP TABLE IF EXISTS relayer_approval_secrets;
DROP TABLE IF EXISTS relayer_approval_records;
