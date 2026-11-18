# Operations Runbook: Relayer Key Rotation, Compromise Response & Signing Tiers

**Issues:** #177 (hot rotation), #746 (key lifecycle; absorbs SPIKE-143 tiers, SPIKE-150 compromise fund safety)
**Code:** `backend/src/services/relayer-rotation.ts` (orchestrator), `relayerKeyManager.ts` (identity fencing), `relayer-signing-policy.ts` (tiers)
**CLI:** `npm run relayer:key -- <command>` (`backend/src/relayer-key-cli.ts`)
**Design notes:** [`docs/spikes/SPIKE-746-relayer-key-lifecycle.md`](../spikes/SPIKE-746-relayer-key-lifecycle.md)

---

## 1. The one thing to understand

A relayer key is a **Stellar account**. Its transactions consume that account's
sequence numbers and must carry that account's signature. Rotating the key
therefore changes the relayer's **on-chain identity**: a new account, a new
sequence chain and a new XLM balance. It is not like swapping an API token.

Every procedure below follows from that:

| Risk | Guard |
| :--- | :--- |
| A transaction built against the old account gets signed by the new key (`tx_bad_auth`) | Cutover runs inside the sequence lock, and signing picks the key that **owns the tx source account** |
| Transactions already built or submitted under the old account | The old key **drains**: for `RELAYER_ROTATION_DRAIN_WINDOW_MS` it may sign only txs sourced from its own account |
| Cutover to an account that does not exist or is underfunded | Funding preflight: the target must exist on-chain with ≥ `RELAYER_ROTATION_MIN_FUNDING_XLM` |
| Cutover fails half-way | Automatic rollback to the old identity; manual rollback while draining |
| A compromised key keeps signing, or returns after a restart | Revoked at once and persisted in `relayer_key_revocations` |

Unsigned work (the submit queue, vote jobs) is not tied to any identity: it
builds its transaction when it gets the sequence lock, so it needs no migration.

---

## 2. Configuration

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `RELAYER_SECRET_KEY` | *(required)* | Primary relayer account |
| `RELAYER_SECONDARY_SECRET_KEY` | — | **Pre-funded** standby. Without one, a compromise halts signing |
| `RELAYER_ROTATION_DRAIN_WINDOW_MS` | `300000` | Dual-identity window after a planned cutover |
| `RELAYER_ROTATION_MIN_FUNDING_XLM` | `10` | Funding preflight threshold for a rotation target |
| `RELAYER_KEY_MAX_AGE_DAYS` | `90` | Active-key age that raises `ZKVoteRelayerKeyRotationOverdue` |
| `RELAYER_COMPROMISE_SLO_SECONDS` | `300` | Declaration-to-rotated target |
| `RELAYER_COMPROMISE_COOLDOWN_MS` | `600000` | A 2nd declaration inside this window needs a co-signer confirmation |
| `RELAYER_SWEEP_SAFE_ACCOUNT` | — | Cold account that compromised funds are swept to. Never a relayer key |
| `RELAYER_SIGNING_TIERS_ENABLED` | — | Turns the signing tier policy on |
| `RELAYER_TIER_LIMITS` | see `.env.example` | `CODE:HOT_MAX:WARM_MAX` per asset |
| `RELAYER_COSIGNER_KEYS` | — | `id:secret,…` HMAC secrets of co-signers |
| `RELAYER_BREAK_GLASS_SECRET` | — | Warm-tier break-glass (never cold) |
| `RELAYER_MIN_BALANCE_XLM` / `RELAYER_AUTO_ROTATE_LOW_BALANCE` | `5` / `true` | Low-balance failover, which goes through the same orchestrator |

**Funding lead time.** Fund a standby **before** you need it. A new account
needs the base reserve (1 XLM) plus fees; the preflight requires
`RELAYER_ROTATION_MIN_FUNDING_XLM` (10 XLM by default). On mainnet, funding
means a payment from treasury and takes at least one ledger close (~5 s) plus
however long treasury approval takes. That is why standbys are funded in
advance and `ZKVoteRelayerNoFundedStandby` pages when none is left.

---

## 3. Planned rotation

Phases: `preflight → cutover → draining → completed` (or `rolled_back` / `failed`).

```bash
export RELAYER_URL=https://relayer.example.org RELAYER_AUTH_TOKEN=...   # admin master key

# 0. Readiness: a funded standby exists, nothing is draining
npm run relayer:status

# 1. Rotate (to the best funded standby, or --target <keyId|G...>)
npm run relayer:rotate -- --actor alice --reason "quarterly rotation"

# 2. Watch the drain. New work is already on the new identity.
npm run relayer:status            # rotation.phase == "draining", drainUntil

# 3a. Let the window expire, or close it early once nothing is in flight:
npm run relayer:key -- finalize --actor alice
# 3b. Or go back while still draining:
npm run relayer:key -- rollback --actor alice --reason "new identity misbehaving"
```

Rules:
- At most **one** identity drains at a time; another rotation is refused with `drain_in_progress`.
- `finalize` is refused unless the sequence lock is idle (no in-flight submissions).
- If verification of the new identity fails during cutover, the orchestrator **rolls back by itself**. Look for `zkvote_relayer_rotations_completed_total{outcome="rolled_back"}`.
- Low-balance failover (`POST /admin/relayer/check-balances`) uses this same path, so it never cuts over to an unfunded standby.

---

## 4. Compromise response (target: inside `RELAYER_COMPROMISE_SLO_SECONDS`)

Do this as soon as a relayer secret is believed exposed (leaked env, paste,
unexpected signatures). Speed matters more than root cause.

```bash
# 1. Declare. Revocation is immediate and persisted; a funded standby takes
#    over, or signing halts (fail closed) if there is none.
npm run relayer:compromise -- --key G...COMPROMISED --declared-by alice --reason "secret in public paste"

# 2. A SECOND person issues a sweep approval on their own machine
#    (RELAYER_COSIGNER_ID / RELAYER_COSIGNER_SECRET set) and sends the token:
npm run relayer:key -- approve --action sweep:G...COMPROMISED

# 3. Sweep the remaining XLM to RELAYER_SWEEP_SAFE_ACCOUNT
npm run relayer:key -- sweep --key G...COMPROMISED --requested-by alice --confirmation <token>

# 4. Remove the compromised secret from the secrets backend (Fly/Vault),
#    then reconstitute (§6).
```

What happens at declaration:
1. **Revoke.** From that instant the key signs nothing except a sweep. This covers its drain window too.
2. **Rotate without waiting for the queue.** The flip does *not* queue behind the FIFO sequence lock. If it did, every request queued ahead of it would hit the revoked key and fail. Only the submission in flight at that moment can fail, and it fails loudly (refused signature or `tx_bad_auth`).
3. **Report.** Signatures the compromised key made that may still be pending are listed in `rotation.invalidatedSignatures`. Vote jobs retry under the new identity; the on-chain nullifier stops a retried vote from counting twice.
4. **Measure.** `timeToRotatedMs` and `sloMet` are returned and exported (`zkvote_relayer_compromise_time_to_rotated_seconds`).

If the response says `"status": "halted"`, there was no funded standby.
Signing is stopped; go straight to §6.

Griefing guards (a declaration or sweep can itself be the attack):
- Unknown keys are rejected. Repeat declarations of the same key are idempotent.
- A second declaration inside `RELAYER_COMPROMISE_COOLDOWN_MS` needs a co-signer `confirmation` from someone other than the declarer, so one stolen admin token cannot burn through every standby.
- Declaring a standby only burns that key: no rotation, no funds move.
- The sweep destination comes **only** from `RELAYER_SWEEP_SAFE_ACCOUNT`. It needs a confirmer who is neither the declarer nor the requester, and the tx shape (pay/merge to the safe account only) is checked again at signing time.

Emergency stop without declaring a compromise (e.g. a co-signer sees something wrong):
```bash
npm run relayer:key -- halt --reason "investigating" --actor bob   # refuses all non-sweep signing
npm run relayer:key -- resume --actor bob
```

---

## 5. Signing tiers

The tier is derived from the transaction's operations, never from a caller label:

| Tier | Condition | Authority |
| :--- | :--- | :--- |
| hot | value ≤ hot limit, no privileged ops | hot key alone |
| warm | value ≤ warm limit | + 1 co-signer approval (or audited break-glass) |
| cold | above warm, **or** any privileged op (`setOptions`, `accountMerge`, trust flags) | + 2 distinct co-signers |

Approvals are HMACs bound to the exact tx hash, tier and expiry, so one cannot
be replayed onto another transaction. Value split across operations is summed.
Attempts are counted in `zkvote_relayer_signing_refused_total` and page through
`ZKVoteRelayerSigningTierBypassAttempts`.

---

## 6. Reconstitution (after a compromise or a halt)

1. `POST /admin/relayer/generate` (or register a key from the secrets backend).
2. Fund it from treasury to at least `RELAYER_ROTATION_MIN_FUNDING_XLM`; on test networks use `POST /admin/relayer/fund`.
3. `npm run relayer:rotate -- --target <newKeyId> --actor ...` (the preflight confirms funding).
4. Provision and fund a **new standby** so the next compromise does not halt.
5. Update `RELAYER_SECRET_KEY` / `RELAYER_SECONDARY_SECRET_KEY` in the secrets backend so a restart comes up on the new identities. The old secret also stays refused at boot through `relayer_key_revocations`.

> **Backups:** revocations live in SQLite. Restoring a snapshot taken before a
> compromise would drop that revocation. After any restore, check
> `relayer_key_revocations` against the incident log and re-declare anything
> missing. See `docs/ENCRYPTED_BACKUPS.md` §5.

---

## 7. Drills

The procedures above are rehearsed by `backend/tests/relayer-key-lifecycle.test.ts`
against a fake ledger that enforces Stellar's source/sequence/signature rules:

| Drill | Test |
| :--- | :--- |
| Rotation under load, 0 lost / 0 duplicated | `rotation under load: two planned rotations lose and duplicate nothing` |
| Funding gap | `funding-gap drill…`, `funding gap: a missing standby account reads as 0 XLM…`, `low-balance failover goes through the orchestrator…` |
| Rollback (automatic and manual) | `rollback drill: …` |
| Compromise under load, timed vs SLO | `compromise drill under load…`, `compromise under a queued backlog…` |
| Halt when no funded standby | `compromise with no funded standby halts signing…` |
| Fake declaration / griefing | `fake-declaration drill…`, `repeated declaration of the same key is idempotent` |
| Reconstitution | `reconstitution rehearsal…` |
| Tier bypass | `tier bypass: …` (5 tests) |
| Key-age alerting | `readiness flags an active key older than the max age`, `key-age gauge keeps ageing…` |

These prove the logic, not your operational response time. Run the §4
procedure as a **live drill on testnet** at least quarterly, with the runbook
only, and record the declaration-to-rotated time it returns.

---

## 8. Metrics & alerts (`monitoring/prometheus/zkvote-alerts.yml`)

| Alert | Fires when |
| :--- | :--- |
| `ZKVoteRelayerKeyRotationOverdue` | `zkvote_relayer_active_key_age_seconds > zkvote_relayer_key_max_age_seconds` (age is computed at scrape time) |
| `ZKVoteRelayerNoFundedStandby` | no standby can take over: a compromise would halt |
| `ZKVoteRelayerDrainStuck` | an identity has been draining for 30 minutes |
| `ZKVoteRelayerRotationRolledBack` | a rotation rolled back or failed |
| `ZKVoteRelayerCompromiseDeclared` | a compromise was declared |
| `ZKVoteRelayerCompromiseSloBreached` | declaration-to-rotated exceeded the SLO (or halted) |
| `ZKVoteRelayerSigningHalted` | signing is stopped |
| `ZKVoteRelayerSigningTierBypassAttempts` | repeated tier/sweep/revoked-identity refusals |

Other series: `zkvote_relayer_rotation_phase`, `zkvote_relayer_rotation_duration_seconds`,
`zkvote_relayer_draining_keys`, `zkvote_relayer_funded_standby_keys`,
`zkvote_relayer_signing_tier_total`, `zkvote_relayer_sweeps_total`,
`zkvote_relayer_key_balance_xlm`, `zkvote_relayer_key_transactions_total`.

---

## 9. Known limits

- **Cluster mode:** key state lives in each process. With `CLUSTER_ENABLED`, a rotation flips only the worker that served the request. Rotate on a single-process deployment, or restart the workers on the new secrets.
- **Soroban value:** tiers see native/asset payment value. Value moved inside a contract invocation is not visible to the policy; contract-level limits must cover it.
- **Already-submitted txs** from a compromised key cannot be recalled; they land or expire within their timebounds.
- HSM/KMS signing is a separate track (`docs/ops/KMS_RELAY_KEY_RUNBOOK.md`).


## Scheduled lifecycle drill and evidence

The nightly-stress workflow runs backend/tests/relayer-key-lifecycle.test.ts
against its deterministic fake ledger. This synthetic drill exercises funded
standby ranking, hot swap and sequence fencing with concurrent submissions,
compromise revocation, fail-closed behavior, two-person sweep approval, and
safe-account-only sweep shape. The run publishes TAP output plus a versioned
JSON and Markdown timeline report as a 90-day artifact.

The synthetic drill does not prove production key custody or replace a timed
testnet incident exercise. Operations must still schedule a live testnet
compromise-and-sweep rehearsal, record the declaration-to-rotation duration,
and obtain operator sign-off before claiming the live response SLO is met.
