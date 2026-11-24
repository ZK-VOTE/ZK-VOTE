# SPIKE-127: Durable job queue

## Decision

Money movement, reconciliation, retries, and rollups use a persisted job table with leases. In-memory queues remain valid only for best-effort work. Jobs are at-least-once and every handler must be idempotent using a stable operation key.

Each job stores type, payload, status, attempts, available time, lease owner, lease expiry, last error, and dead-letter reason. Workers claim with an atomic conditional update, renew leases, and reclaim expired leases. A permanent failure is moved to dead letter after the class-specific retry budget and raises an alert.

## Required guarantees

- Restart recovery is tested by stopping a worker after claim and before acknowledgement.
- Duplicate delivery is tested for every money-moving handler.
- Queue health exposes ready, leased, retrying, and dead-letter counts plus oldest age.
- Job payloads contain references, not secrets; access follows the same authorization and backup policy as financial state.
- Migration from inline work is per job class with a feature flag and reconciliation report.

No handler may acknowledge a job before its durable side effect and idempotency record are committed.

