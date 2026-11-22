# Preliminary protocol-boundary findings: spikes #698–#701

> **Status: investigation / partial mitigation, not acceptance-complete.**
> These findings describe the current source and a narrow input guardrail.
> No audits, tests, benchmarks, testnet transactions, or CI were run for this
> contribution. No successful cryptographic attack or safety guarantee is
> claimed. None of #698, #699, #700, or #701 should be auto-closed by this PR.

## #700 — Exclusion-proof scaling

### What the code does today

- `circuits/exclusion_proof.circom` defines `ExclusionProof(levels)`
  with **two fixed-length Merkle authentication paths**, one against an
  historical root and another against the current root. Its constraint
  count depends on the compiled `levels`, not directly on the total number
  of active registry leaves. Actual **witness construction**, tree I/O, and
  concurrent prover memory can still grow with registry size.
- The file defines a template, but not its own `component main`; a
  benchmark must first identify the exact compiled entry point, verification
  key and artifact generation process. A source-level complexity argument is
  **not** a benchmark.
- `initExclusionProof` in
  `backend/src/services/exclusion-proof.ts` injects DB/log dependencies;
  it does **not** load proving artifacts, create warm workers, or produce
  proofs. `verifyExclusionProof` currently examines public-input format
  and local revocation records; it does **not** invoke a Groth16 verifier.
  It must **not** be treated as sufficient cryptographic proof validation.
  Building a pool around that function would not fix proving latency.
- The currently documented default voting membership tree is depth 18
  (2^18 = **262,144** addressable indices). This is a structural capacity
  limit, **not** a performance threshold measured on hardware.
- `circuits/stark/` contains a vote STARK prototype; it does not provide a
  proven drop-in exclusion-verification path.

### Small, reversible mitigation in this PR

`verifyExclusionProof` now fails fast for a non-integer, negative or
out-of-range `leafIndex` (outside 0..262143), with a clear instruction
that a larger deployment needs a versioned larger-depth exclusion circuit
and verifier. No existing valid index is changed. This prevents obviously
unsupported input from advancing to DB work; it does **not** measure,
cap, or queue actual proving jobs.

### Proposed measurement plan (not executed)

| Scenario | Browser worker | Rust prover / CLI | Relayer |
| --- | --- | --- | --- |
| 1k leaves | witness ms / proof ms / peak MiB | same | cold init / p95 / peak MiB |
| 10k leaves | same | same | same |
| 100k leaves | same | same | same |
| 250k leaves | same | same | same |
| 1, 4, 16 concurrent requests | N/A | N/A | queue depth / rejects / p95 / OOM |

Fix the artifact and witness path first, pin hardware and input distributions,
then compare fixed-depth trees, a sparse tree and sharding. Choose the first
safe limit from **observed** p95 and memory budgets, not from 262,144 alone.
Do not aggregate exclusion proofs across voters until public signals, nullifier
binding and revocation-epoch semantics have a reviewed design.

**Still needed for #700:** measured curves, a real bounded prover queue,
load/cold-start outcomes, witness-generation ownership, batching/sharding
prototype and compatibility plan. None are supplied by this PR.

## #701 — Nullifier derivation and intentional overlap

The current source does **not** support a blanket finding that vote and claim
nullifiers are identical. It deliberately reuses a *vote eligibility*
nullifier in several flows while independently deriving the *claim spending*
nullifier.

| Source / flow | Current derivation | Why it is shared or separated |
| --- | --- | --- |
| `vote_template.circom`, `vote_commit.circom` | `Poseidon(secret, daoId, proposalId)` | **Intentionally identical**: commit spends the same voting right as direct vote |
| `sybil_weighted_vote.circom`, `quadratic_vote.circom` | `Poseidon(secret, daoId, proposalId)` | **Intentionally shared** to prevent switching proof families to vote twice for the same election; only safe when election semantics are pinned |
| `claim.circom` — `voteNullifier` | `Poseidon(secret, daoId, proposalId)` | Deliberate reference to a previously cast vote; reward contract checks vote eligibility |
| `claim.circom` — `claimNullifier` | `Poseidon(secret, daoId, proposalId, 427020085613)` | Independent `CLAIM_TAG` / Poseidon arity 4 for double-claim prevention |
| `shielded_transfer.circom` | `Poseidon(spendingKey, leafIndex)` | Different note-spend preimage and Poseidon arity 2; requires scope-specific note-tree/root binding review |
| `delegation.circom` — register | Same vote nullifier | Burns the delegator's direct vote right |
| `delegation.circom` — delegated vote | `Poseidon(delegationCommitment, daoId, proposalId)` | Separate delegated right, not the identity secret |
| `delegation.circom` — reclaim | `Poseidon(RECLAIM_DOMAIN, secret, delegationCommitment, daoId, proposalId)` | Versioned reclaim family |
| `vote_v2.circom` | `Poseidon(secret, daoId, proposalId, chainId, nonce)` and separate family nullifier | Already uses a different derivation; requires version/VK-specific interpretation |

`DELEGATION_DOMAIN`, `DELEGATE_TAG_DOMAIN` and `RECLAIM_DOMAIN`
are defined in `circuits/delegation.circom`; do not change their constants
or `CLAIM_TAG` retroactively.

**Decision recommendation:** maintain the existing shared *election spending*
namespace for direct/commit/weighted/delegation-register. Add a canonical
versioned domain registry in a subsequent migration PR for **independent**
claims, note spends, delegation rights, and future proof formats. The
contract must enforce the per-election and per-domain nullifier storage key;
changing only a JavaScript helper would leave the deployed proof format
unchanged. If any circuit adds a public domain signal, its VK, verifier IC
length, backend payload and clients must change together.

**Still needed for #701:** exact deployed artifact/VK inventory, replay
attempts, cross-family collision search, historical-key audit, migration
period for in-flight commit/reveal proposals, and verified script parity.

## #699 — Voting-semantics binding

The existing proof families do not share a single statement:

| Circuit | Public statement shape (representative) |
| --- | --- |
| `vote.circom` | root, nullifier, daoId, proposalId, voteChoice, numCandidates |
| `quadratic_vote.circom` | root, daoId, proposalId, nullifier, totalCreditsSpent, allocationsHash |
| `sybil_weighted_vote.circom` | base vote signals plus snapshotTime, attestationCommitment, voteWeight |
| `weighted_vote.circom` | balanceCommitment, maxSupply, voteWeight (balance-binding component, not a complete interchangeable base ballot) |
| `tally.circom` | simple two-vote accumulator example with nullifierRoot, yesCount, noCount; no universal semantics verification |

**Design recommendation:** pin a *proposal-level* tuple
`(semanticsId, semanticsVersion, verificationKeyHash, paramsHash)` before
voting starts and reject any ballot whose proof circuit/version does not
match. Bind cost budget, candidate count, attestation root and snapshot
parameters to the appropriate public signals. No proof-family conversion
or tally-by-reinterpretation is safe without a protocol migration.
Treat the existing verification-key snapshot protection as a starting point,
not proof that all cross-family routes reject a wrong key.

**Still needed for #699:** implemented tuple and verification gates, new
artifacts, differential math tests, mixed-ballot rejection evidence,
on-chain tally integration and cost measurements.

**Follow-up (ZV-112 / Issue #952):** implements the tuple and verification
gates and on-chain integration as an *additive* path alongside the existing
yes/no-only `submit_recursive_tally`/`verify_tally_proof`, which are
untouched:

- `circuits/tally_universal.circom` - one template per semantics (yes/no,
  QV, weighted), each exposing `(semanticsId, semanticsVersion)` as public
  signals.
- `contracts/voting/src/lib.rs` - `set_proposal_semantics` (pin the tuple
  pre-vote), `set_semantics_vk` (one VK per `(dao_id, semanticsId,
  semanticsVersion)` - "mixed proof families" have no VK to verify against
  under each other's tuple), `submit_universal_tally` (rejects a mismatched
  tuple before attempting Groth16 verification).
- `circuits/universal-tally-reference.js` / `circuits/universal-tally.test.js`
  - the differential math tests and mixed-proof-family rejection evidence,
  runnable as pure JS.
- `circuits/universal-tally.benchmark.js` - a *static constraint-count
  estimate*, explicitly not a measured proving/verification cost; the
  circom 2.1.8 compiler was not available in the environment this was
  written in (see `circuits/COMPILATION.md`), so the circuit itself has not
  been compiled or witness-tested, and no trusted setup / VK exists yet.
  **#699 is therefore still not acceptance-complete** - see
  `docs/recursive-proof-architecture.md` §8 for the full remaining list.

## #698 — BN254 verifier boundary

The reported absence of adversarial coverage is partly outdated:
`docs/bn254-edge-case-findings.md` already describes a corpus of more
than 50 cases in
`contracts/zkvote-groth16/tests/bn254_edge_case_corpus.rs`. Its **present
pass/fail status was not checked** in this contribution.

Current verifier source also includes:

- `validate_nullifier` and `assert_in_field` to check canonical public
  scalar inputs at caller boundaries (callers must actually invoke them).
- Explicit zero/identity rejection for proof A/B/C before BN254 pairing.
- A four-pairing-term arity check; G2 parsing/subgroup handling is currently
  delegated to the Soroban host implementation.
- A `testutils` verifier stub guarded against WASM deployment; test builds
  with this feature do **not** validate real pairing behavior.

**Decision recommendation:** keep scalar canonicalization at every
entry-point boundary, reject identity proofs and invalid encodings, and
capture the exact host-version behavior for G2 subgroup points. Classify
failures separately from arithmetic-budget exhaustion; do not map a host
trap to a successful verification result. Any new curve check must be
measured on the actual Soroban protocol/host version before rollout.

**Still needed for #698:** reproducible execution results for the
adversarial corpus and integration entries, field/curve input matrix,
metering deltas, explicit error-code observations, a proof-malleability
campaign and independent cryptographic review. No such results are
claimed here.

---

## Safe scope and migration rule

This is a **partial investigation** plus the #700 fast-rejection guard.
It intentionally avoids modifying nullifier domains, public-signal shapes,
verification keys, tally math or on-chain verification without a migration
and exercised cryptographic artifacts. Tests and CI were not run at the
contributor's request. Follow-up implementation PRs and measurements are
required before any of the four issues can be marked resolved.
