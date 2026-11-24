# Relayer Binding — Implementation Status (#361 / ZV-029)

**Updated**: 2026-11-24
**Scope**: end-to-end relayer binding for anonymous vote submission
**Status**: implemented in the voting contract; no circuit change required

This document supersedes the earlier 7th-public-signal plan. That plan was
abandoned: a public signal alone binds nothing a Soroban contract can verify,
and it broke the verification-key IC length. The implemented design binds the
relayer at the transaction layer. See `RELAYER_BINDING_DESIGN.md`.

## Acceptance criteria

| Criterion | Status | Implementation |
|---|---|---|
| A proof intercepted by a different relayer cannot be submitted | Done | `relayer.require_auth()` + single-use, election-scoped nullifier (replay fails as `AlreadySubmitted`) |
| Anonymous vote content stays unlinkable to the relayer identity | Done | `RelayerAttributionEvent` carries only `(dao_id, proposal_id, nullifier, relayer, path)` — no voter address/secret/commitment |
| Batch submission enforces the same check as single votes | Done | `cast_votes_with_relayer` uses the same `require_authorized_relayer` / `emit_relayer_attribution` helpers |
| Contract and circuit docs explain the sentinel removal | Done | Design note in `lib.rs`, `vote.circom`, `vote_template.circom`, this file, `THREAT_MODEL.md` |
| Relayer rotation defined and implemented | Done | Guardian-only `add_relayer` / `remove_relayer` / `rotate_relayer` + allowlist storage |
| Backward compatible | Done | Legacy entrypoint signatures unchanged; opt-in `set_require_relayer_on_legacy` |

## What shipped

### Contract (`contracts/voting/src/lib.rs`)

**Errors**
- `InvalidRelayerAddress = 92` — repurposed: the supplied relayer is the
  contract itself, or is not in the configured allowlist.
- `RelayerRequired = 127` — a legacy relayer-less entrypoint was called while
  the guardian has opted into mandatory binding.

**Storage keys** (appended so existing discriminants are stable)
- `AuthorizedRelayer(Address) -> bool`
- `AuthorizedRelayerCount -> u32`
- `RelayerSetEnabled -> bool`
- `RequireRelayerOnLegacy -> bool`

**Events**
- `RelayerAttributionEvent` — `(dao_id, proposal_id, nullifier, relayer, path)`
  with `dao_id`/`proposal_id` as topics. No voter identity.
- `RelayerRotationEvent` — relayer + `"added"`/`"removed"`/`"rotated"` action.
- `RelayerPolicyEvent` — legacy-policy opt-in/out.

**Shared helpers**
- `require_authorized_relayer(env, ctx, relayer)` — rejects the contract
  address sentinel, calls `relayer.require_auth()`, checks the allowlist when
  configured.
- `emit_relayer_attribution(env, dao_id, proposal_id, nullifier, relayer, path)`.
- `check_legacy_relayer` — honours the opt-in legacy refusal.
- `relayer_set_enabled`, `is_authorized_relayer` — allowlist state.

**Entrypoints**
- `vote_with_relayer`, `vote_bls381_with_relayer`, `cast_votes_with_relayer`.
- `vote`, `vote_bls381`, `cast_votes` keep their signatures and delegate to
  `submit_vote` / `submit_vote_bls381` / `submit_vote_batch` with `relayer = None`.
- `add_relayer`, `remove_relayer`, `rotate_relayer`,
  `set_require_relayer_on_legacy` (guardian-only).
- Views: `is_authorized_relayer`, `is_relayer_set_configured`,
  `require_relayer_on_legacy`.

### Circuits (`circuits/vote.circom`, `circuits/vote_template.circom`)

No circuit logic change. Both files now document why the 7th `relayerAddress`
signal and its zero sentinel were removed. Public signals remain:

```
[root, nullifier, daoId, proposalId, voteChoice, numCandidates]   // 6
```

`NUM_PUBLIC_SIGNALS = 6`, `VOTE_CIRCUIT_IC_LEN = 7`. `scripts/drift-guard.mjs`
continues to enforce parity with the checked-in verification key.

### Documentation

- `RELAYER_BINDING_DESIGN.md` — rewritten for the enforced design.
- `FEATURE_361_COMPLETION_SUMMARY.md` — separates #361 signing from this work.
- `THREAT_MODEL.md` — relayer-binding section updated.
- In-contract design note above `NUM_PUBLIC_SIGNALS` — expanded.

## What deliberately did NOT ship

- **No 7th public signal, no new trusted setup.** The old key stays valid.
- **No change to legacy function signatures.** Every in-repo caller keeps
  compiling; `grep` found no broken callers.
- **No voter identity in any relayer event.**
- **`circuits/vote_v2.circom` was not touched** — it is out of scope for this
  ticket. Its historical `relayerAddress` signal belongs to the separate
  re-voting circuit and is not part of the enforced design described here.

## Verification

- `cargo check -p voting` passes (warnings pre-existing).
- Focused tests in `contracts/voting/src/test.rs` cover: relayer auth required,
  unauthorized relayer rejected, single/batch parity, attribution event, and
  rotation. Run with `cargo test -p voting`.

## Migration / rollout

1. Deploy the updated voting contract (no circuit artifacts change).
2. Call `add_relayer` for each authorized operator, or leave the allowlist
   unconfigured to accept any signing relayer.
3. Clients that need attribution switch to `vote_with_relayer` /
   `vote_bls381_with_relayer` / `cast_votes_with_relayer`.
4. Optionally call `set_require_relayer_on_legacy(&guardian, &true)` once all
   clients have migrated, so unauthenticated legacy submissions are refused.
