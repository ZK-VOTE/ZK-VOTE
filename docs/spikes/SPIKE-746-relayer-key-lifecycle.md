# SPIKE-746: Relayer Key Lifecycle — Hot Rotation, Signing Tiers, Compromise Response

**Status:** Investigation complete; implemented on `fix/746-relayer-key-lifecycle`
**Absorbs:** SPIKE-143 (tiered signing), SPIKE-150 (compromise fund safety)
**Runbook:** [`docs/ops/RELAYER_KEY_ROTATION.md`](../ops/RELAYER_KEY_ROTATION.md)

## Correction to the issue premise

§1 of the issue says rotation is restart-based. That has been stale since #177:
`relayerKeyManager.rotateActiveKey` hot-swaps the active key, and the
`relayerKeypair` proxy in `stellar.ts` delegates to it. The real defect was that
the hot swap was a **bare pointer flip**:

- It was not fenced against the sequence lock. A route that read the source
  account, then signed after the flip, produced a tx sourced from the old
  account and signed by the new key, which fails on-chain with `tx_bad_auth`.
  Reproduced in the fake-ledger harness.
- It accepted unfunded and revoked targets, and a revoked key came back after
  a restart.
- `relayerKeyTransactionsTotal.inc()` used an undeclared label, so
  `relayerKeyManager.signTransaction` threw on every call (payments path).

## Q1 — Identity model

The relayer key is an **account**. Its transactions are bound to its sequence
chain and signature, so rotation changes the relayer's on-chain identity.
Implications for queues:

| State | Bound to an identity? | Handling |
| :--- | :--- | :--- |
| Queued, unsigned work (submit queue, vote jobs) | No: built when it gets the lock | Nothing to migrate |
| Critical section (read account → build → sign → submit) | Yes | Cutover runs inside the sequence lock |
| Signed / submitted, awaiting confirmation | Yes (old account) | Drain window: old key signs only its own source account |
| Persisted sequence hint | Yes | Namespaced per public key |

There is therefore no queue migration table. The identity-bound state is the
lock and the drain window, and `015_relayer_key_lifecycle` persists only the
audit trail and revocations.

## Q2 — Dual-identity window

| Phase | Active key signs | Old key signs | Exit |
| :--- | :--- | :--- | :--- |
| preflight | everything | — | target funded, nothing else draining |
| cutover | — (inside the lock) | — | identity resync verified, otherwise auto-rollback |
| draining | all new work | only txs sourced from its own account | `RELAYER_ROTATION_DRAIN_WINDOW_MS` (default 5 min), `finalize` (lock idle only), or `rollback` |
| completed | everything | nothing (idle standby) | — |

The window is bounded on purpose: only one identity drains at a time, and a
new rotation is refused until it closes, which caps sequence-management
complexity at two chains.

## Q3 — Funding choreography

- Minimum: base reserve 1 XLM + fees; preflight requires `RELAYER_ROTATION_MIN_FUNDING_XLM` (10).
- An account that does not exist is treated as **0 XLM**, never "unknown". The
  manager's `checkBalance` previously left it `null`, which ranked as a viable
  standby for low-balance failover. Fixed and tested.
- Lead time: at least one ledger close (~5 s) after the treasury payment, plus
  however long approval takes. Since that is outside an incident SLO, standbys
  are pre-funded and `ZKVoteRelayerNoFundedStandby` pages when none is left.
- Low-balance auto-failover goes through the orchestrator (preflight, fence,
  rollback); it previously swapped the pointer directly.

## Q4 — Compromise rotation SLO

Order: revoke (persisted) → rotate to the first funded standby, or halt →
report invalidated in-flight signatures → two-person sweep.

**Finding:** the first implementation fenced the compromise flip on the FIFO
sequence lock with a 30 s timeout. The key was already revoked, so every
request queued ahead of the flip failed. Measured in the harness without
retries: **40 of 40** queued requests failed. Waiting buys nothing once the key
is revoked, so the compromise flip is now unfenced: **at most the one in-flight
request fails** (asserted). The fence-timeout setting was removed.

| Measurement | Value | Source |
| :--- | :--- | :--- |
| Declaration → rotated, in process | < 1 s (asserted) | `compromise under a queued backlog…` |
| Requests failed by a compromise under backlog | ≤ 1 | same |
| Default SLO | 300 s | `RELAYER_COMPROMISE_SLO_SECONDS` |

The in-process figure excludes human detection and response time, which
dominate. The SLO has to be validated with a **live, timed testnet drill**
using only the runbook (runbook §7). That drill has not been run as part of
this spike.

## Q5 — Rollback

- Automatic: a cutover whose identity verification fails reverts inside the
  same fence, before any new work signs under the new identity. Tested under
  load with zero lost or duplicated submissions.
- Manual: `rollback` during the drain window returns to the draining identity.
- A revoked key is never restored by rollback.
- Backup restores can undo revocations (they live in SQLite). This is
  documented in `ENCRYPTED_BACKUPS.md` §5 with a check step.

## Tiered signing (SPIKE-143)

The tier comes from the operations (summed value per asset; privileged ops
are always cold), never from a caller label. Approvals are HMACs bound to the
tx hash, tier and expiry.

| Option | Added latency per signature | Ops cost | Fit |
| :--- | :--- | :--- | :--- |
| Application gate (implemented) | in-process HMAC check, negligible vs RPC/ledger time | co-signer secrets + CLI | hot/warm/cold today |
| Stellar multisig (account signers + thresholds) | a co-signer round-trip before submit: human-bound for cold | signer management on-chain | cold tier; strongest guarantee |
| MPC / threshold EdDSA | a multi-party protocol per signature (*not measured here*) | separate infra + ceremony | future, removes the single hot key |
| HSM / KMS | one remote call per signature (*not measured here*) | non-goal (separate track) | key custody, not authority |

Only the application gate was benchmarked, and only implicitly, through the
test suite's runtime. The MPC and HSM rows are qualitative. Measure them
before choosing one for the hot path.

Bypass tests: hash-bound approvals, expiry, unknown co-signers, splitting
across operations, privileged ops at any amount, break-glass on cold, sweep
purpose misuse.

## Sweep & griefing (SPIKE-150)

- Sweep destination comes only from config (`RELAYER_SWEEP_SAFE_ACCOUNT`) and
  must not be a hot key. It needs a confirmer distinct from the declarer and
  the requester, and the tx shape is checked again at signing.
- A fake declaration can only burn a key and move signing to another funded
  standby of ours; it cannot move funds. Repeats are idempotent, and a second
  declaration inside the cooldown needs a co-signer, so one stolen admin token
  cannot exhaust the standbys.
- A co-signer halt stops all signing except a sweep.

## Key-age alerting

`zkvote_relayer_active_key_age_seconds` was previously set only on key events.
An untouched key therefore kept the age from its last event, and
`ZKVoteRelayerKeyRotationOverdue` could never fire for the key nobody rotates.
It is now computed at scrape time (tested).

## Open items

- Live timed compromise drill on testnet (owner: ops).
- Cluster mode: key state is per process; rotation in cluster mode is via a rolling restart for now.
- Value moved inside Soroban contract invocations is invisible to the tier policy.
- HSM/MPC remain separate tracks.
