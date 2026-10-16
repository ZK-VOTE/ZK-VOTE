# SPIKE-127: Durable Payout and Rollup Jobs

## Decision

Move payouts, retries, and rollups from in-process timers to a durable queue backed by the primary database or a managed queue. Each job has a stable idempotency key, attempt counter, lease expiry, next-attempt time, and terminal outcome.

## Processing contract

Workers claim jobs with a lease, renew while processing, and recover expired leases. Retries use bounded exponential backoff with jitter. A unique business key prevents duplicate payouts, while a dead-letter state preserves the reason and operator action required. Rollups checkpoint their input range so restart resumes without double counting.

Metrics must expose queued, running, retried, dead-lettered, and completed jobs. Shutdown drains leases before exit. Tests must kill a worker at each side-effect boundary and verify exactly-once business outcomes.

