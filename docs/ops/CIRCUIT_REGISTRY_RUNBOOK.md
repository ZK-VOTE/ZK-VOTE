# Circuit Registry Operations Runbook

The on-chain `circuit-registry` contract is the single source of truth for
verification keys (VKs). The relayer, frontend and SDK must never synthesize a
VK or a VK hash. Mock fallbacks are gated behind `CIRCUIT_REGISTRY_ALLOW_MOCK=true`
**and** `RELAYER_TEST_MODE=true`; any other configuration fails closed with 503.

## Configuration

| Variable | Required in production | Purpose |
|---|---|---|
| `CIRCUIT_REGISTRY_CONTRACT_ID` | yes | Soroban contract id (`C...`) |
| `CIRCUIT_REGISTRY_ALLOW_MOCK` | no (default `false`) | Enables mock fallbacks **only** in test mode |
| `VOTING_VK_VERSION` | no | Pinned proposal version used by the frontend preflight |

`GET /circuits/vk/:circuitId/:version` returns a canonical `hash` computed from
`{circuitId, circuitType, version, vk, numPublicSignals}` and a `hashScheme:
"registry-v1"` marker. Clients verify that hash before caching. A stale version
returns **410**, a not-yet-published version returns **404**, and registry
unavailability returns **503** — never a fabricated all-zero VK.

## VK rotation procedure

1. `POST /circuits/vk/propose` with the new VK, wasm hash, timelock and quorum.
2. Collect approvals via `POST /circuits/vk/:proposalId/approve`.
3. After the timelock, `POST /circuits/vk/:proposalId/execute`. The contract
   increments its per-circuit version counter and emits
   `VkProposalExecutedEvent`. The relayer writes a durable revocation record and
   removes cached VK rows in the same request.
4. Confirm every replica serves the new version:
   `GET /circuits/vk/:circuitId` must show the incremented `currentVersion`.
5. Clients requesting the old version get 410 and clear their local cache. The
   SDK exposes `invalidateRegistryVK()` for operators/tools that need to push
   invalidation immediately.

## Migrating existing frontend VK files

Older deployments shipped static VK JSON (e.g. `frontend/src/lib/verification_key_soroban.json`)
and derived hashes locally. To migrate:

1. For each circuit file, register the VK on-chain with `register_circuit`
   (governance only), passing `num_public_signals` and the ceremony transcript
   hash from `transcript-registry` as provenance.
2. Replace local VK loads with `fetchVersionedVK(circuitId, version)`. Keep the
   JSON file only as an offline fallback, and mark it with the registry hash so
   `fetchVersionedVK` can compare it before use.
3. Delete any `mock_hash_*` / `local_vk_hash_*` constants from clients. They are
   no longer produced by the relayer and will fail the hash check.
4. Re-run the frontend VK cache tests (`zkproof.vkcache.test.ts`) and the
   registry DI tests (`backend/test/di/circuit-registry.test.ts`).

## Failure modes

- **Registry down:** VK endpoints return 503; verification fails closed. Do not
  set `CIRCUIT_REGISTRY_ALLOW_MOCK` in production to "fix" an outage.
- **Stale cached VK:** 410 from the relayer; `invalidateVKCache` (frontend) or
  `invalidateRegistryVK` (SDK) clears the entry. Re-fetch after rotation.
- **Proposal key mismatch:** the contract's `approvers` vector is authoritative;
  the backend parses `approvals` only for display. Use `getVkProposal` to
  confirm the on-chain approval count before executing.
- **Ceremony provenance:** `circuit-registry` does not yet store a ceremony
  transcript hash directly; verify the VK hash against
  `contracts/transcript-registry::is_vk_attested(vk_hash)` before registration.
