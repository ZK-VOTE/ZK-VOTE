# EPIC-008: Governance data warehouse

The transactional indexer remains the source of event truth. Versioned rollups are derived tables with a recorded source cursor, schema version, computed-at timestamp, and reorg invalidation range. Analytics APIs declare freshness and consistency guarantees and never rebuild large histories in request handlers.

Small-set suppression is enforced in the query service, before serialization: configurable minimum cohort sizes, bucket rounding, and query budgets apply to every route and export. Exports require an audited role, purpose, expiry, and redaction profile; download tokens are single-use and never expose raw wallet identifiers.

Reconciliation continuously compares rollup counts and sums with indexed chain events. A mismatch marks the affected rollup stale, blocks exports that depend on it, and schedules a deterministic rebuild. Retention jobs remove expired derived data and verify that backup retention and crypto-shredding follow the same policy.

