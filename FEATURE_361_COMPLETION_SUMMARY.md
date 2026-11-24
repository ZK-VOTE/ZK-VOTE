# Feature #361 — Relay Request Signing: Completion Summary

**Date**: 2026-11-24 (updated for #361 / ZV-029 relayer-binding work)
**Subject**: what closed #361 actually delivered, and what end-to-end
enforcement added afterwards.

## Two different things

| | Closed #361 | This ticket (#361 follow-up / ZV-029) |
|---|---|---|
| Name | Relay request signing | End-to-end relayer binding |
| Guarantee | The relay signs the transaction it submits | Every anonymous submission has an authorized, attributed relayer; a replayed proof is rejected |
| Mechanism | Backend signs the tx with `relayerKeypair` | `relayer.require_auth()` on a caller-supplied `Address`, optional guardian allowlist, attribution event, single-use nullifier |
| Circuit | Touched (7th signal added in the original attempt) | No circuit change — signal count stays at 6 |
| Status | Closed | Implemented |

**#361 was about signing, not enforcement.** A signed transaction identifies
the fee-paying relay but does not, by itself, bind the relayer to the vote
submission in the contract: the original approach tried to add a 7th
`relayerAddress` circuit signal, which a Soroban contract cannot verify
(`Env::auths()` is test-only) and which broke the verification-key IC length.
The signal was removed and a zero sentinel was passed in its place — decorative
and, worse, destructive.

This ticket closes the gap: the contract now takes the relayer as a call
argument and calls `relayer.require_auth()` on it.

## What #361 delivered (prior context — still true)

- The backend relay signs outgoing vote transactions with `relayerKeypair`
  (`backend/src/services/stellar.ts`, `backend/src/routes/voting.ts`).
- The old design notes and status documents recorded the 7th-signal plan;
  those documents have now been rewritten to match reality.
- Threat model documented relayer front-running as an accepted, bounded risk
  (tally is additive; the nullifier is single-use).

## What end-to-end enforcement delivered now

1. **Caller-supplied relayer + auth.** `vote_with_relayer`,
   `vote_bls381_with_relayer`, `cast_votes_with_relayer` take an `Address` and
   call `require_authorized_relayer`, which calls `relayer.require_auth()`.
2. **No circuit signal.** Public signals stay at 6; `VOTE_CIRCUIT_IC_LEN = 7`.
   No new trusted setup, no VK regeneration, drift guard still passes.
3. **Attribution without deanonymization.** `RelayerAttributionEvent` carries
   `(dao_id, proposal_id, nullifier, relayer, path)`. The voter is represented
   only by the nullifier already present in `VoteEvent`; no voter address,
   secret, salt or commitment is emitted.
4. **Replay rejection.** The nullifier is consumed (CEI) before proof
   verification, so a proof intercepted and resubmitted by a different relayer
   fails with `AlreadySubmitted`. This is the enforceable form of the old
   "proof bound to relayer" claim.
5. **Batch parity.** The batch entrypoint uses the same shared helpers as the
   single-vote path; one attribution event per ballot.
6. **Rotation.** Guardian-only `add_relayer` / `remove_relayer` /
   `rotate_relayer` maintain an opt-in allowlist. With no allowlist, any
   signing relayer is accepted; with one, only members pass.
7. **Backward compatibility.** Legacy `vote` / `vote_bls381` / `cast_votes`
   signatures are unchanged and keep working. A guardian can opt in to
   `set_require_relayer_on_legacy(true)` to refuse them.

## Acceptance-criteria check

- ✅ A proof intercepted by a different relayer cannot be submitted —
  single-use election-scoped nullifier, explicit in code comments and docs.
- ✅ Anonymous vote content remains unlinkable to the relayer identity —
  attribution carries only the public nullifier plus the relayer address.
- ✅ Batch submission enforces the same check — shared helpers, same errors.
- ✅ Contract and circuit docs updated to explain the sentinel removal.
- ✅ Rotation defined and implemented.
- ✅ Focused tests added (`contracts/voting/src/test.rs`); `cargo check -p voting`
  passes.

## Residual limitations

- Legacy relayer-less entrypoints remain callable by default for compatibility;
  enforcement on those paths requires the guardian opt-in flag.
- `circuits/vote_v2.circom` (separate re-voting circuit) is out of scope and
  still contains its historical `relayerAddress` signal; it is not part of the
  enforced design here and needs its own dedicated change.
- No circuit recompilation or KAT was needed because the circuit did not change.

## References

- `RELAYER_BINDING_DESIGN.md` — current design and rationale for removing the
  7th signal.
- `RELAYER_BINDING_IMPLEMENTATION_STATUS.md` — shipped scope and verification.
- `THREAT_MODEL.md` — relayer-binding threat section.
- `contracts/voting/src/lib.rs` — design note at `NUM_PUBLIC_SIGNALS`.
