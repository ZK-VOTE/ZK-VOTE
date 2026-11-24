# Circuit Registry Rotation Runbook

The circuit registry contract (`contracts/circuit-registry/src/lib.rs`) is the
**single source of truth** for Groth16 verification keys (VKs), circuit
versions, public-signal counts, and ceremony transcript hashes. The backend
service (`backend/src/services/circuit-registry.ts`) and all clients resolve VKs
through it. No code path may synthesize a key outside explicit test mode.

## Roles and safety properties

| Property | Value |
| --- | --- |
| Governance | Address set in `__constructor`; required for register, ceremony-hash, migration, and finalization calls |
| Proposal quorum | `required_approvals > 0`, enforced on-chain; each approver authenticates independently |
| Timelock | `execute_after = proposed_at + timelock_duration`; execution before this timestamp reverts with `VkProposalTimelockNotElapsed` |
| Cancellation | Proposer or governance only, while status is `Pending` |
| Replay protection | A proposal executes once; status becomes `Executed` and cannot be approved/executed again |
| Fail closed | If `CIRCUIT_REGISTRY_CONTRACT_ID` is unset or any registry read fails, VK endpoints return **503** and never invent a key |

## Rotation procedure

1. **Prepare the new artifact.** Complete the trusted-setup ceremony for the
   new circuit and record the canonical transcript hash (see
   `docs/trusted-setup-ceremony.md`). Build the new WASM hash.

2. **Publish the ceremony hash (governance).**
   `set_ceremony_hash(circuit_id, circuit_type, ceremony_transcript_hash)` writes
   `DataKey::CeremonyHash(circuit_id, circuit_type)`. This is additive: it does
   not change `register_circuit`. An empty hash reverts with
   `InvalidCeremonyHash`.

3. **Propose.** `POST /circuits/vk/propose` (auth required) with
   `circuitId`, `circuitType`, `newVk`, `newWasmHash`, `timelockDuration`,
   `requiredApprovals`, and optional `daoId`. On-chain this calls
   `propose_vk_upgrade`, which emits `VkProposalCreatedEvent` and records
   `execute_after`.

4. **Approve.** Collect `requiredApprovals` distinct approvals via
   `POST /circuits/vk/:proposalId/approve`. Progress is visible on
   `GET /circuits/vk/proposal/:proposalId`.

5. **Wait out the timelock.** The relayer clock and the Soroban ledger timestamp
   must both be past `execute_after`. Do not shorten the timelock to expedite a
   release.

6. **Execute.** `POST /circuits/vk/:proposalId/execute`. The contract atomically
   swaps `vk`/`wasm_hash`, sets `registered_at`, increments
   `DataKey::CircuitVersion(circuit_id, circuit_type)`, and emits
   `VkProposalExecutedEvent`. The backend service immediately invalidates its
   resolved-VK cache for that DAO + circuit + type and clears the version cache
   as a safety net.

7. **Verify.** `GET /circuits/vk/:circuitId/:version?daoId=<id>` must return the
   new key, the incremented version, and a `hash` equal to the canonical
   SHA-256 preimage (domain `zkvote-vk-v1`, circuitId, version, ceremony hash,
   stable-stringified VK). Requesting the previous version returns **410 Gone**
   with `{ "isStale": true, "currentVersion": N }`.

## Cache invalidation

- **Backend:** `resolveVk()` caches by `daoId + circuitId + circuitType + version`.
  `invalidateVkCache()` (all) or `invalidateVkCache({ daoId, circuitId,
  circuitType, version })` (scoped) and `invalidateVersionCache(circuitId)` drop
  entries. `executeVkUpgrade()` invalidates automatically after a successful
  proposal execution.
- **Verification/polling:** `POST /circuits/verify-version` checks the DAO's
  proposal; if its status is `Executed`, the corresponding caches are
  invalidated before answering. Clients should call this endpoint before
  generating a proof.
- **Client:** `frontend/src/lib/zkproof.vkcache.ts` caches the full circuit
  binding (circuitId, circuitType, version, `numPublicSignals`, ceremony hash,
  and the canonical hash) and rejects any key whose recomputed hash does not
  match the backend record. `applyRotation()` or `invalidateVKCache(scope)`
  must be called when a 410/rotation is observed. The SDK
  (`packages/sdk/src/keys.ts`) exposes `CircuitBinding` and `computeVkHash()` so
  witnesses and proofs bind to the same instance.

## Fail-closed behaviour

- Production (`RELAYER_TEST_MODE` unset/false) with no contract ID: all VK and
  version reads throw `CircuitRegistryUnavailableError` → HTTP **503** with
  `{ "code": "CIRCUIT_REGISTRY_UNAVAILABLE" }`. There is no local VK fallback
  and no `mock_hash_*` template.
- A stale version → HTTP **410** with `StaleVkError` details.
- Explicit test mode (`RELAYER_TEST_MODE=true`, or injected `testMode: true`)
  may use a deterministic mock provider, but every response is labelled
  `"source": "test-mode-mock"` and must never be deployed.

## Recovery / rollback

There is no in-place VK rollback. To revert, propose a fresh upgrade with the
previous VK and ceremony hash and run the full timelock + quorum flow again.
This preserves the monotonic version and the audit trail. Cancelling a pending
proposal (`POST /circuits/vk/:proposalId/cancel`) is safe and does not change
the active key.

## Operational checklist

- [ ] New ceremony transcript published and hash recorded on-chain
- [ ] `requiredApprovals` ≥ 2 and distinct approver keys available
- [ ] Timelock duration matches DAO policy (see DAO governance config)
- [ ] `GET /circuits/vk/proposal/dao/:daoId` shows the proposal
- [ ] Execution confirmed; version incremented; old version returns 410
- [ ] Client caches invalidated; sample proof verifies against the new binding
