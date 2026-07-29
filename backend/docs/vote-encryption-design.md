# Vote Encryption Design (Draft)

Status: **design proposal / not implemented**. This document exists to make
progress on #116 by writing down a concrete, reviewable design; it does not
change any runtime behavior, the contract's `VoteRecord.encrypted_vote`
field, or any circuit. See "Scope and status" at the bottom for what is and
isn't covered.

## Problem

`VoteRecord.encrypted_vote` (`types.rs`) is a `BytesN<64>` with no documented
encryption scheme. Nothing today proves that those 64 bytes are a validly
formed encryption of a legal candidate index — a voter (or a buggy client)
could submit garbage in that field and it would be indistinguishable from a
real encrypted vote until/unless someone tries to decrypt and tally it. There
is also no defined process for decrypting votes for tally computation, and no
key management story for whoever holds the decryption capability.

## Goals

1. A vote's ciphertext should be *provably* an encryption of one of the
   election's valid candidate indices, without revealing which one
   (verifiable encryption).
2. No single party should be able to unilaterally decrypt any individual
   vote; decryption should require a threshold of independent authorities.
3. It should be possible to compute the tally without decrypting individual
   votes (homomorphic tally), so a compromised or coerced decryption
   authority quorum can only recover the tally, not any single voter's
   choice, beyond what the tally itself reveals.

## Non-goals (for this document)

- Circuit code, contract code, or frontend code changes.
- Choosing a production KMS/HSM vendor.
- A performance/gas budget for the additional proof — that belongs in a
  follow-up spike once the scheme below is validated against the existing
  circuit's constraint budget.

## Scheme choice: ElGamal over Paillier

Both were listed as candidates in #116. Recommendation: **exponential
ElGamal** on the same curve already used elsewhere in this codebase
(`@noble/curves`, used for the existing ZK tooling), not Paillier.

Rationale:
- ElGamal is additively homomorphic in the exponent ("exponential ElGamal"),
  which is exactly what's needed to sum encrypted votes into an encrypted
  tally without decrypting individual ballots.
- It composes naturally with Sigma-protocol-style ZK proofs (Chaum-Pedersen /
  disjunctive Schnorr proofs) for proving "this ciphertext encrypts one of
  {0, 1, ..., k-1}" — the standard technique used by Helios and Belenios,
  which the issue calls out as prior art.
- Paillier requires a separate, much larger modulus (RSA-scale) and a
  different curve/field than the rest of the ZK stack, which would mean
  carrying two incompatible algebraic settings through the circuit. ElGamal
  keeps everything in the same group already used for Pedersen commitments
  and nullifiers elsewhere in this codebase, which is significantly less
  circuit-design risk.
- Decryption is O(candidates) for exponential ElGamal (baby-step/giant-step
  or a small discrete-log table) because we only ever decrypt a *tally*, not
  an individual vote — the tally range is small and known in advance
  (0..number_of_voters), so this is not a practical concern.

Ciphertext shape (replacing the undocumented `BytesN<64>`):
`(C1, C2) = (g^r, g^m * pk^r)` where `m` is the candidate index, `pk` is the
election's threshold public key, and `r` is a fresh random nonce per vote.
Each of `C1`/`C2` is a compressed curve point; `BytesN<64>` (two 32-byte
points) already happens to be exactly the right size for this, which is a
good sign the original field was sized with something like this in mind.

## Verifiable encryption (the ZK proof)

The circuit needs to additionally prove, alongside whatever it already
proves about voter eligibility/nullifiers:

> "I know `m` and `r` such that `(C1, C2) = (g^r, g^m * pk^r)` and `m` is one
> of the `k` valid candidate indices for this proposal."

This is a standard OR-proof (disjunction) of `k` Chaum-Pedersen equality
proofs, one per candidate, made non-interactive via Fiat-Shamir. For
small-`k` elections (the common case — most DAO proposals have 2-5 options)
this is cheap; it does not scale well to elections with hundreds of options,
which is an acceptable limitation to flag rather than solve here.

## Threshold decryption

Tally decryption should require `t`-of-`n` election authorities, not any
single party:

1. **Key generation**: run a Pedersen-DKG (distributed key generation) among
   `n` designated authorities so no single party ever learns the full
   private key — each authority ends up with a share `sk_i` of the election
   private key, and the corresponding public key `pk = g^sk` is published
   and used for encryption as above.
2. **Partial decryption**: given the homomorphically-summed ciphertext
   `(C1_sum, C2_sum)`, each authority publishes a partial decryption
   `D_i = C1_sum^{sk_i}` along with a Chaum-Pedersen proof that `D_i` was
   computed correctly against their public share `pk_i` — this lets anyone
   verify authorities aren't submitting garbage without needing to trust
   them.
3. **Combination**: once `t` valid partial decryptions are collected, Lagrange
   interpolation in the exponent recovers `g^tally = C2_sum / (product of D_i
   with Lagrange coefficients)`, and the small discrete log gives `tally`.

## Key management

- DKG keys are generated **per election**, not reused, to bound the blast
  radius of any future key compromise to a single election.
- Authority long-term identity keys (used to authenticate DKG rounds and
  sign partial decryptions) are a separate concern from the per-election
  ElGamal key shares — long-term keys can be authority-held wallet keys
  already used elsewhere for admin actions in this codebase (see
  `middleware/auth.ts`), rather than inventing a new credential type.
- The published election public key `pk` and each authority's `pk_i` are
  recorded on-chain (or in the same DAO registry that already tracks
  election metadata) so encryption and partial-decryption verification are
  fully public and auditable without trusting the backend/relayer.
- The relayer never holds any decryption share — it only ever handles
  ciphertexts, consistent with its existing role as a pass-through, not a
  trusted party.

## Implementation roadmap (phases)

This is intentionally sequenced so each phase is independently reviewable
and shippable, rather than one multi-week PR:

1. **Phase 0 (this PR)** — design doc only (this document).
2. **Phase 1 — crypto primitives**: implement ElGamal encrypt/decrypt,
   Chaum-Pedersen equality proofs, and the OR-composition as a standalone,
   circuit-independent TypeScript/Rust library with unit tests and known
   test vectors. No contract or circuit changes yet.
3. **Phase 2 — DKG and threshold decryption service**: implement the DKG
   round and partial-decryption/combination logic as an offline tool used by
   election authorities, exercised against Phase 1's primitives.
4. **Phase 3 — circuit integration**: add the verifiable-encryption
   constraints to the voting circuit, gate behind a feature flag /
   circuit-version bump so existing elections using the current circuit
   are unaffected.
5. **Phase 4 — contract integration**: extend `VoteRecord`/DAO registry to
   store the election public key and per-authority shares, and add whatever
   on-chain bookkeeping is needed for authorities to submit partial
   decryptions.
6. **Phase 5 — frontend + relayer wiring**: update the voting flow to
   encrypt client-side against the published election key, and update
   `API.md` / `docs/zk-voting-protocol.md` with the finalized scheme.

Each phase should land as its own PR with its own tests; phases 3-5 in
particular are large enough that they should each get their own design
review before implementation starts, since they touch the circuit and
on-chain state.

## Scope and status of this document

Implemented in this PR: this design document only.

Explicitly **not** implemented here (left for the phases above): the
ElGamal library, the DKG/threshold-decryption tooling, circuit changes,
contract changes, and frontend changes. Nothing in the current
`encrypted_vote` field's format or handling is changed by this PR.
