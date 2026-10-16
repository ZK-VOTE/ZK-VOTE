# EPIC-006: Unified dispute center

All disputes enter one case record with a class (`vote`, `payment`, `moderation`, or `fork`), claimant, evidence manifest, status, deadline, adjudication quorum, and remedy. The service stores only encrypted evidence references and hashes; raw evidence is redacted or expires under the retention policy.

Automatic checks run first: ballot inclusion proofs, payment ledger reconciliation, moderation policy checks, and fork-share calculations. Cases that pass the automatic checks move to a role-scoped quorum. Every decision is append-only, appealable once before the class deadline, and produces an execution job with an idempotency key. Spam is bounded by per-wallet rate limits, refundable deposits, and class-specific quotas.

The frontend exposes file, evidence status, decision, appeal, and remedy tracking through the same case timeline. Operators must never resolve a case by editing the status directly; only a signed adjudication or verified automatic result can transition it.

