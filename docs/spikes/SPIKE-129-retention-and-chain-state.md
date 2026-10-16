# SPIKE-129: Retention, Deletion, and Immutable Chain State

## Decision

Separate data into four outcomes: purge from live stores, redact in retained operational records, cryptographically shred backup keys where isolation permits, and suppress future processing. On-chain votes, nullifiers, and contract events are immutable and must never be promised as deletable.

## Required inventory

The inventory must cover SQLite/Postgres rows, indexer projections, request and audit logs, analytics/fraud stores, WAL/Litestream replicas, encrypted backups, support exports, and on-chain identifiers. Every field must record purpose, owner, retention period, deletion mechanism, and restore behavior.

## Operational contract

A deletion request is verified, recorded with a non-PII request id, executed across every mutable store, and checked by a completeness query. Backup restore drills must prove that deleted data cannot reappear in active stores. Legal review is required for the on-chain explanation and the final retention schedule.

No deletion workflow may claim to remove chain state; the user-facing response must explain what is removed, what is redacted, and what remains public or pseudonymous.

