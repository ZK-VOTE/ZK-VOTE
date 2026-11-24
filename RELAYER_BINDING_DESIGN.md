# Relayer Binding Design (#361 / ZV-029)

## Status

**Current design — enforced off-circuit.** The relayer is a caller-supplied
`Address`, bound to the submission by `relayer.require_auth()` and recorded by a
`RelayerAttributionEvent`. The vote circuit keeps **6** public signals. The
earlier 7th `relayerAddress` public signal was removed; see
"Why the 7th signal was removed" below.

Closed #361 covered *signing* (the relay signs the transaction it submits).
This design covers *end-to-end enforcement*: every anonymous submission must
carry a relayer that has authorized the call, and its identity is attributed to
the submission context. `FEATURE_361_COMPLETION_SUMMARY.md` distinguishes the
two.

## Threat and goal

A relayer sees the vote payload before submitting it. It can drop or delay it,
or try to resubmit the same proof through a different channel. The tally is
additive, so reordering does not change the result, but voters still care about
*who* carried their ballot and about not being deanonymized.

Goals:

1. A proof intercepted by a different relayer cannot be submitted as a new
   vote.
2. Anonymous vote content stays unlinkable to the relayer identity — the event
   must not reveal a voter address, secret, salt or commitment.
3. Batch submission enforces the same check as a single vote.
4. Operators can rotate the set of authorized relayers without a contract
   upgrade.

Non-goals: preventing censorship by the relayer that already holds the proof,
or preventing ordering changes within a single relayer (the tally is additive).

## Why the 7th signal was removed

An earlier iteration added `signal input relayerAddress` as a 7th public signal
to `circuits/vote.circom` and passed a **zero sentinel** for it from the
contract. That design was abandoned because:

- **A public signal binds nothing unless the verifier checks it.** A Soroban
  contract cannot learn which account signed the transaction from the proof,
  and `Env::auths()` is `#[cfg(any(test, feature = "testutils"))]` — test-only.
  There is no production equivalent. The extra signal was decorative.
- **It broke the verification key.** With 7 public signals a Groth16 key has 8
  IC points, while `VOTE_CIRCUIT_IC_LEN` and every call site still built 6/7.
  No key could be registered (`validate_vk` rejects any other IC length), so
  the whole anonymous vote path was non-functional while tests passed because
  they synthesize keys from the contract's own constant. `scripts/drift-guard.mjs`
  now fails the build on any such disagreement.

No circuit change is required, no new trusted setup is needed, and the checked-in
verification key remains valid.

## Enforced design

### 1. Caller-supplied relayer + `require_auth()`

New entrypoints take an explicit relayer:

```rust
pub fn vote_with_relayer(
    env: Env, dao_id: u64, proposal_id: u64, vote_choice: bool,
    nullifier: U256, root: U256, proof: Proof, relayer: Address,
)
pub fn vote_bls381_with_relayer(..., proof: ProofBls381, relayer: Address)
pub fn cast_votes_with_relayer(
    env: Env, dao_id: u64, proposal_id: u64,
    votes: Vec<BatchVote>, relayer: Address,
) -> u32
```

All three funnel into the shared helper `require_authorized_relayer`, which:

1. rejects the contract's own address as a sentinel relayer;
2. calls `relayer.require_auth()` — the relayer must have signed this invocation;
3. if the guardian has configured an allowlist, checks that the relayer is a
   member (`InvalidRelayerAddress` otherwise).

`require_auth()` is unconditional. When no allowlist exists, the deployment
falls back to "whoever supplied the relayer must sign for itself", so an
unconfigured deployment still works.

The proof's public signals stay at
`[root, nullifier, daoId, proposalId, voteChoice, numCandidates]` — 6 values,
7 IC points. The relayer is *never* placed in the circuit.

### 2. Attribution bound to the submission context

`emit_relayer_attribution` publishes:

```rust
RelayerAttributionEvent {
    dao_id, proposal_id,      // topics
    nullifier,                // voter's election-scoped pseudonym
    relayer,                  // account that signed the submission
    path: Symbol,             // "vote" | "batch" | "bls381"
}
```

There is deliberately **no voter address, secret, salt, blinding factor or
commitment** in this event. The nullifier is already public in `VoteEvent`, so
attribution adds no linkability between a voter and a relayer beyond what the
submission itself reveals.

### 3. Why a different relayer cannot resubmit a proof

The nullifier is consumed in the checks-effects-interactions phase, *before*
proof verification and cross-contract calls. It is scoped to `(dao_id,
proposal_id)`. Once relayer A's submission succeeds, relayer B replaying the
byte-identical `(proof, nullifier)` tuple hits `nullifier_is_used` and fails
with `AlreadySubmitted`. Relayer attribution tells an indexer which relayer
spent the nullifier first. This is the enforceable replacement for the old
"proof bound to relayerAddress" claim.

### 4. Batch parity

`cast_votes_with_relayer` uses the same `require_authorized_relayer` and the
same `emit_relayer_attribution` helpers as the single-vote path. One event is
emitted per ballot, each carrying the batch relayer. Errors are coarse-mapped
the same way so a relayer cannot probe which ballot in a batch failed. There is
no BLS batch entrypoint; `vote_bls381_with_relayer` is the BLS single path and
uses the same helpers.

### 5. Relayer rotation

Guardian-only entrypoints maintain the allowlist:

| Entrypoint | Effect |
|---|---|
| `add_relayer(guardian, relayer)` | Add a member; first add activates the set |
| `remove_relayer(guardian, relayer)` | Remove a member; last removal deactivates the set |
| `rotate_relayer(guardian, old, new)` | Atomically remove `old` and add `new` |
| `set_require_relayer_on_legacy(guardian, required)` | Opt in to refusing legacy entrypoints |

Views: `is_authorized_relayer`, `is_relayer_set_configured`,
`require_relayer_on_legacy`. Each rotation emits a `RelayerRotationEvent`;
policy changes emit `RelayerPolicyEvent`. All writes require
`guardian.require_auth()` and `require_guardian`.

### 6. Backward compatibility

Existing `vote`, `vote_bls381`, `cast_votes` and `vote_with_circuit` signatures
are unchanged, so no in-repo caller needs updating. They delegate to shared
internal implementations (`submit_vote`, `submit_vote_bls381`,
`submit_vote_batch`) with `relayer = None`; those skip attribution because they
have no relayer argument. A guardian can set `RequireRelayerOnLegacy = true`
to make them fail with `RelayerRequired`, forcing clients onto the
`*_with_relayer` entrypoints. This is opt-in so existing deployments and tests
keep working.

## Security properties

| Property | How it is enforced |
|---|---|
| Relayer must sign | `relayer.require_auth()` in `require_authorized_relayer` |
| Unauthorized relayer rejected | Allowlist membership check (opt-in) |
| Different relayer cannot replay a proof | Single-use, election-scoped nullifier (`AlreadySubmitted`) |
| Voter stays anonymous | Attribution event carries only the nullifier + relayer |
| Batch parity | Shared helpers across single and batch entrypoints |
| Rotation without upgrade | Guardian-managed allowlist storage keys |
| IC length stable | 6 public signals; `VOTE_CIRCUIT_IC_LEN = 7`; drift guard |

## What this does NOT prevent

- Censorship by a relayer that already holds the proof.
- Front-running/ordering within a single authorized relayer (tally is additive).
- Linking a relayer to a voter beyond what the public nullifier already allows.

## Files

- `contracts/voting/src/lib.rs` — helpers, errors, storage keys, events,
  rotation entrypoints, `*_with_relayer` entrypoints, design note.
- `circuits/vote.circom`, `circuits/vote_template.circom` — documentation of
  the sentinel/7th-signal removal; signal count unchanged at 6.
- `RELAYER_BINDING_IMPLEMENTATION_STATUS.md` — what shipped vs. what did not.
- `FEATURE_361_COMPLETION_SUMMARY.md` — signing (#361) vs. enforcement.
- `THREAT_MODEL.md` — relayer-binding threat section.

## References

- `THREAT_MODEL.md` §§ "Relayer front-running", "Anonymous submission".
- `scripts/drift-guard.mjs` — circuit/contract public-signal parity check.
- Closed #361 (relay request signing) as prior context; ZV-029.
