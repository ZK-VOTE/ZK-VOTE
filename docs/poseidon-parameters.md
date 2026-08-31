# Poseidon Hash Parameters

ZK-VOTE hashes with Poseidon over the BN254 scalar field in three places that
must agree exactly:

| Where | What it hashes | Implementation |
|---|---|---|
| `circuits/vote_template.circom`, `circuits/merkle_tree.circom` | identity commitments, nullifiers, Merkle nodes | `circomlib/poseidon.circom` |
| `frontend/src/lib/zkproof.ts`, `circuits/utils/*.js` | the same values, off-chain | `circomlibjs` |
| `contracts/membership-tree` | Merkle roots, on-chain | Stellar P25 host `poseidon_hash`, with parameters vendored in `poseidon_params.rs` |

`circuits/POSEIDON_KAT.md` establishes that these three agree with each other.
This document covers the separate question raised by issue #91: **are the
parameters they agree on the ones the specification prescribes?** Three
implementations agreeing on a weak parameter set is still weak.

## Parameter set

All widths use the same instantiation:

| Parameter | Value | Meaning |
|---|---|---|
| Field | BN254 `Fr` | `21888242871839275222246405745257275088548364400416034343698204186575808495617` |
| `n` | 254 | field size in bits, as fed to the parameter generator |
| S-box | `x^5` | `gcd(5, p-1) = 1` over this field, so `x^5` is a permutation |
| `R_F` | 8 | full rounds (4 at each end) |
| `R_P` | 57 (`t=3`), 56 (`t=4`), 60 (`t=5`) | partial rounds |
| Security target | 128 bits | against collision and preimage attacks |

The widths ZK-VOTE instantiates:

| `t` | Inputs | Used for |
|---|---|---|
| 3 | 2 | Merkle node hash `Poseidon(left, right)` and the leaf domain hash `Poseidon(LEAF_DOMAIN, leaf)`. This is the only width the on-chain contract has parameters for. |
| 4 | 3 | vote nullifier `Poseidon(secret, daoId, proposalId)` |
| 5 | 4 | identity commitment `Poseidon(DOMAIN_TAG, secret, salt, blindingFactor)` |

## Provenance: how these values are derived, not asserted

The round constants and the MDS matrix are **not** free choices. The Poseidon
designers specify a deterministic generator seeded only by the parameters above,
so anyone can reproduce the tables from scratch. The reference generator is
`generate_parameters_grain.sage` from the designers' `hadeshash` repository,
invoked exactly as circomlibjs documents in its own source:

```
sage generate_parameters_grain.sage 1 0 254 <t> 8 <R_P> \
    0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
```

`circuits/utils/poseidon_param_audit.js` re-implements that generator and
checks the result against what circomlib ships. Run it with:

```bash
cd circuits
npm run poseidon:audit        # the widths ZK-VOTE uses
npm run poseidon:audit:all    # all 16 widths circomlib ships
```

The audit performs eight independent checks per width.

### 1-2. Round constants and MDS matrix regenerate from the seed

The generator is an 80-bit Grain LFSR in self-shrinking mode. Its initial state
encodes the field type, S-box type, `n`, `t`, `R_F` and `R_P`; the first 160
clockings are discarded. Round constants are then drawn 254 bits at a time,
**rejecting** samples `>= p` so the constants are uniform over the field.

The MDS matrix is the Cauchy matrix `M[i][j] = 1 / (x_i + y_j)` over `2t`
further samples from the same stream. These are **reduced** mod `p` rather than
rejected — a small asymmetry in the reference script, but reproducing
circomlib's matrices requires getting it right.

Both tables reproduce bit-for-bit for every width circomlib ships.

### 3-5. The MDS matrix passes the generator's three security tests

An MDS matrix is rejected by the reference generator if it admits an invariant
subspace or an infinitely long subspace trail — that is, if an attacker can
inject a difference that keeps the S-box inactive across many rounds, which
would make the permutation effectively linear over those rounds and collapse
the security argument. The generator's `algorithm_1`, `algorithm_2` and
`algorithm_3` are reimplemented and run against the shipped matrices:

- **Algorithm 1** — for each power `M^i` with `i` in `1..t-1`: reject if the
  power is a scalar matrix, if any `F_p`-eigenvector of it lies in the inactive
  subspace, or if that subspace is fixed by `M^j` for some `j <= i`.
- **Algorithm 2** — with `s = 1` this is a cyclic-vector test: the Krylov
  subspace `span{e_0, M e_0, M^2 e_0, ...}` must reach the full space. A stall
  short of dimension `t` *is* the invariant subspace the attack needs.
- **Algorithm 3** — the same condition for every power `M^r`, `r` in `2..4t`,
  which rules out trails that only close up after several rounds.

The audit runs these against the values actually shipped, not only against the
ones it derived, so a tampered vendored copy is caught even if the derivation
were somehow bypassed.

### 6-8. Round numbers meet the published bounds

`R_F` and `R_P` are checked against `sat_inequiv_alpha` from the designers'
`calc_round_numbers.py`, which is the maximum of four bounds:

- **statistical / differential** — 6 full rounds suffice at this field size;
- **interpolation attack** — Section 5.5.1 of the paper;
- **Gröbner-basis attacks** — Section 5.5.2, two variants.

For every width in use the binding constraint is the statistical bound at
`R_F >= 6`, and the shipped `R_F = 8` clears it. The audit additionally strips
the designers' recommended margin back off (`R_F - 2`, `R_P / 1.075`) and
confirms the inequality *still* holds, which is what demonstrates the shipped
numbers carry the full recommended margin rather than sitting on the boundary.

## Where the checks live

| Check | Location |
|---|---|
| Derivation, matrix security, round numbers | `circuits/utils/poseidon_param_audit.js` |
| Executable assertions (31 tests) | `circuits/poseidon_params.test.js` (`npm test` in `circuits/`) |
| Golden vectors + digest | `circuits/utils/poseidon_params_golden.json`, regenerated by `npm run poseidon:golden` |
| On-chain vendored copy | `contracts/membership-tree/src/poseidon_params.rs` — its test module hashes the vendored tables and compares against the golden digest |

The golden digest is what keeps the two languages honest. It is a SHA-256 over
the MDS matrix row-major followed by the round constants round-major, each
element as 32 big-endian bytes. Order is part of the commitment, so a
transposed or reordered table fails just as loudly as a changed value. If the
Rust test goes red, either the vendored copy drifted or the derivation did —
neither should ever happen silently.

## Known cryptanalysis and the current margin

Poseidon has been under sustained algebraic cryptanalysis, and the Ethereum
Foundation ran a dedicated Poseidon Cryptanalysis Initiative. The results that
matter for these parameters:

- **Gröbner-basis attacks exploiting subspace trails** (Grassi et al., ToSC
  2025) refine the round-count estimates for Poseidon and Poseidon2. Depending
  on the instantiation, the original analysis can *under*- or *over*-estimate
  the rounds needed. Follow-up work extending the framework to nonlinear
  subspaces roughly doubles the number of internal rounds an attack can cover.
- The conclusion of that line of work is that Poseidon, Poseidon2 and Neptune
  remain secure against the presented attacks at their published round counts.

The practical consequence for ZK-VOTE is not that the parameters need changing,
but that the margin should be *monitored*: the audit prints the required round
count next to the shipped one, so a future result that raises the bound shows up
as a concrete number to compare against rather than an argument to relitigate.

### Poseidon2

Poseidon2 keeps the same round structure and security analysis but replaces the
external linear layer with a fixed, sparse matrix and the internal layer with a
diagonal one, cutting constraints meaningfully — most of the win is in the
partial rounds, where the dense `t x t` MDS multiply becomes a diagonal one.

It is **not** adopted here, for one decisive reason: the Merkle tree is hashed
on-chain by the Stellar Protocol 25 host function
`env.crypto().poseidon_hash(inputs, "BN254")`, which implements Poseidon with
the circomlib parameters. There is no host function for Poseidon2. Switching
the circuits to Poseidon2 would mean the on-chain root and the in-circuit root
stop matching, and the only way to close that gap would be to implement
Poseidon2 in contract code — trading a host-accelerated hash for a metered one,
which costs far more than the circuit saves.

Poseidon2 becomes worth revisiting if and when the host exposes it. Until then
the constraint budget is better spent where this PR spends it: on Merkle depth
selection (#93), which removes whole Poseidon invocations rather than making
each one cheaper.

## References

- Grassi, Khovratovich, Rechberger, Roy, Schofnegger. *POSEIDON: A New Hash
  Function for Zero-Knowledge Proof Systems*. USENIX Security 2021.
  <https://eprint.iacr.org/2019/458>
- Reference parameter generator (`generate_parameters_grain.sage`,
  `calc_round_numbers.py`): <https://extgit.iaik.tugraz.at/krypto/hadeshash>
- Grassi, Khovratovich, Schofnegger. *Poseidon2: A Faster Version of the
  Poseidon Hash Function*. <https://eprint.iacr.org/2023/323>
- Grassi et al. *Poseidon and Neptune: Gröbner Basis Cryptanalysis Exploiting
  Subspace Trails*. IACR ToSC 2025. <https://eprint.iacr.org/2025/954>
- Poseidon Cryptanalysis Initiative: <https://www.poseidon-initiative.info/>
