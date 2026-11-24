# Assigned ZK-VOTE integration spikes — investigation and partial implementation

These four high-risk issues are not fully resolved. Do not merge until remaining acceptance criteria are satisfied.

## #702 Delegation revocation race

Confirmed source blocker: circuits/delegation_vote.circom verifies membership against a delegation root but does not bind a revocation epoch. contracts/voting/src/lib.rs declares delegation-related data types and events while explicitly stating that executable delegation entrypoints are not implemented. The requested same-ledger 20-trial register/revoke/vote experiments therefore cannot be performed against this checkout. Required: atomic on-chain live/unspent status checks at voting, complete delegation entrypoints, proof input and verifier-key versioning, and negative tests for revocation/vote ordering and delegate chains. Do not consider stale-root proof sufficient to demonstrate non-revocation.

## #704 Relayer sequence-lock contention

The relayer has one global sequence lock, shared by votes and payment batches. This branch adds bounded per-lane (vote, payment, other) queue-wait samples with p99 visibility in authenticated health details, but does not increase signing throughput. Remaining: 10/50/100% mixed-load benchmark, signer-striping privacy review, vote latency SLO, crash-recovery and exactly-once semantics. No claim of throughput fix is made.

## #705 Degraded indexer state

GET /daos already carries degraded, syncStatus and lastSync. Added explicit dataStatus and sourceAvailable flags so an empty cached list does not imply the authoritative chain has no DAOs; frontend degradation banner names DAO sync and indexer failures. Remaining: full endpoint/status behavior matrix, replay and dedup after reconnect, and end-to-end vote/payment tests in both modes.

## #706 Quote-to-execution integrity

Added 30-second HMAC-bound Horizon quote tokens (pair, canonical amount, destination quote, source and expiry), fail-closed fallback quotes, live Horizon revalidation at submission, and a 1% integer-stroop minimum-received floor. The frontend transmits tokens and invalidates them on refresh or submission. Remaining: rapid-drift/Horizon-outage integration tests, multi-worker signing-secret coordination, and replay/idempotency validation.

## Verification and blockers

The new quote-token signing/expiry unit test passes. Backend full typecheck is currently blocked by pre-existing TypeScript parse errors in the RPC endpoint-manager section of backend/src/services/stellar.ts, present in upstream HEAD. This work is not a verified complete security fix.
