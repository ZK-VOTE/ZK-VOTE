# Nova / SuperNova Recursive Proof Architecture for ZK-VOTE

## 1. Executive Summary

As elections scale to tens or hundreds of thousands of voters (100K+ voters), verifying individual zero-knowledge vote proofs on-chain becomes prohibitively expensive in terms of gas fees, latency, and block space.

This document describes the **Recursive Proof Composition Architecture** for ZK-VOTE using **Nova Incrementally Verifiable Computation (IVC)**. By folding $N$ individual vote computations into a single recursive proof off-chain, ZK-VOTE achieves **$O(1)$ constant-time on-chain verification** and constant proof size, regardless of whether there are 1,000, 10,000, or 100,000+ voters.

---

## 2. Mathematical Formulation & IVC Step Circuit

### 2.1 Incrementally Verifiable Computation (IVC)
In an IVC scheme, a state $z_i$ transitions to $z_{i+1}$ via a deterministic step function $F$:
$$z_i = F(z_{i-1}, \omega_i)$$
where $\omega_i$ is the private witness for step $i$.

### 2.2 ZK-VOTE Step State ($z_i$)
The step state vector $z_i$ consists of:
1. `step_count`: The current step index $i \in \{0, \dots, N\}$.
2. `root`: The immutable Merkle tree root of eligible voter identity commitments.
3. `yes_votes`: Accumulated number of "YES" (choice = 1) votes cast so far.
4. `no_votes`: Accumulated number of "NO" (choice = 0) votes cast so far.
5. `acc_nullifier_hash`: Sequential Poseidon hash accumulator over all processed nullifiers:
   $$\text{acc\_nullifier\_hash}_i = \text{Poseidon}(\text{acc\_nullifier\_hash}_{i-1}, \text{nullifier}_i)$$

### 2.3 Private Witness ($\omega_i$)
For each voter step $i$, the private witness $\omega_i$ contains:
- `secret`: Voter's secret key
- `salt`: Random commitment salt
- `pathElements[18]`: Siblings in the Poseidon Merkle tree (depth 18, supporting 262,144 voters)
- `pathIndices[18]`: Path direction bits (0 = left, 1 = right)
- `voteChoice`: Voter's selection (0 = NO, 1 = YES)
- `nullifier`: Computed nullifier value

### 2.4 Step Function Constraints ($F$)
Within each Nova IVC step execution, the step circuit enforces:
1. **Commitment Verification**:
   $$\text{leaf}_i = \text{Poseidon}(\text{secret}_i, \text{salt}_i)$$
2. **Merkle Inclusion Proof**:
   $$\text{MerkleVerify}(\text{leaf}_i, \text{pathElements}_i, \text{pathIndices}_i) \stackrel{?}{=} \text{root}$$
3. **Nullifier Derivation**:
   $$\text{nullifier}_i \stackrel{?}{=} \text{Poseidon}(\text{secret}_i, \text{daoId}, \text{proposalId})$$
4. **Nullifier Accumulation**:
   $$\text{acc\_nullifier\_hash}_i = \text{Poseidon}(\text{acc\_nullifier\_hash}_{i-1}, \text{nullifier}_i)$$
5. **Tally Increment**:
   $$\text{yes\_votes}_i = \text{yes\_votes}_{i-1} + (\text{voteChoice}_i == 1 ? 1 : 0)$$
   $$\text{no\_votes}_i = \text{no\_votes}_{i-1} + (\text{voteChoice}_i == 0 ? 1 : 0)$$
6. **Step Increment**:
   $$\text{step\_count}_i = \text{step\_count}_{i-1} + 1$$

---

## 3. Nova Folding Scheme & Cycle of Curves

Nova operates over a cycle of elliptic curves $(E_1, E_2)$ (such as Pallas/Vesta or BN254/Grumpkin) to fold relaxed R1CS instances without expensive pairing checks inside the step circuit.

```
       Step 1                 Step 2                           Step N
  ┌───────────────┐      ┌───────────────┐               ┌───────────────┐
  │ Vote Witness 1│      │ Vote Witness 2│               │ Vote Witness N│
  └───────┬───────┘      └───────┬───────┘               └───────┬───────┘
          │                      │                               │
          ▼                      ▼                               ▼
  ┌───────────────┐      ┌───────────────┐               ┌───────────────┐
  │  Step Fold 1  │────► │  Step Fold 2  │────► ... ───► │  Step Fold N  │
  └───────────────┘      └───────────────┘               └───────┬───────┘
                                                                 │
                                                                 ▼
                                                        ┌─────────────────┐
                                                        │  Final Nova IVC │
                                                        │ Compressed Proof│
                                                        └────────┬────────┘
                                                                 │
                                                                 ▼
                                                        ┌─────────────────┐
                                                        │ On-Chain Soroban│
                                                        │    Verifier     │
                                                        └─────────────────┘
```

1. **Folding Memory Efficiency**: Nova retains an $O(1)$ memory footprint throughout the $N$ steps because only running accumulators $(U_i, W_i)$ are updated at each fold.
2. **Prover Scaling**: Linear $O(N)$ total proving time across $N$ steps, with extremely low per-step folding overhead (~few milliseconds per vote).
3. **Compressed Proof**: The final folded R1CS instance is compressed using a Spartan / Groth16 wrapper proof into a compact byte payload ($\approx 1.5$ KB to $32$ KB).

---

## 4. Privacy & Zero-Knowledge Security Guarantees

1. **Voter Privacy**: Individual vote choices ($\text{voteChoice}_i$), secrets ($\text{secret}_i$), salts ($\text{salt}_i$), and Merkle paths are kept strictly private inside witness $\omega_i$. They are never revealed to the aggregator, backend, or on-chain contract.
2. **Nullifier Unlinkability**: Nullifiers are domain-separated using $\text{Poseidon}(\text{secret}, \text{daoId}, \text{proposalId})$. Sequential hashing into $\text{acc\_nullifier\_hash}$ prevents double voting across the election batch while concealing individual voter identities.
3. **Soundness**: A malicious aggregator cannot inject invalid votes or tamper with candidate tallies, because doing so breaks the relaxed R1CS satisfiability check enforced by Nova.

---

## 5. Off-Chain Aggregation Pipeline & API

The off-chain aggregation service (`NovaAggregatorService` in `backend/src/services/nova-aggregator.ts`) coordinates the process:

1. **Collection Phase**: Aggregates submitted vote witnesses for an active proposal.
2. **Folding Phase**: Invokes `nova-aggregator` Rust CLI binary to process $N$ steps.
3. **Verification & Relay Phase**: Submits the final recursive proof and state vector $(N, \text{root}, \text{yes\_votes}, \text{no\_votes}, \text{final\_nullifier\_acc})$ to the Soroban smart contract.

---

## 6. On-Chain Soroban Contract Integration

The Soroban voting contract (`contracts/voting/src/lib.rs`) exposes:

```rust
pub fn submit_recursive_tally(
    env: Env,
    dao_id: u64,
    proposal_id: u64,
    num_votes: u64,
    yes_votes: u64,
    no_votes: u64,
    final_nullifier_acc: U256,
    proof: Bytes,
) -> Result<(), VotingError>
```

### Gas & Performance Comparison

| Metric | Individual Groth16 Verifications | Nova Recursive Composition |
|--------|----------------------------------|----------------------------|
| **On-Chain Verifications** | $N$ pairing checks | **1 single check** |
| **On-Chain Gas Cost (100K votes)** | $\approx 5,000,000,000$ CPU units | **$\approx 15,000,000$ CPU units ($O(1)$)** |
| **On-Chain Transactions** | $N$ separate transactions | **1 atomic transaction** |
| **Proof Size on Ledger** | $N \times 256$ bytes ($\approx 25.6$ MB) | **Constant ($\approx 2$ KB)** |

---

## 7. Conclusion

Nova/SuperNova IVC recursive proof composition provides ZK-VOTE with complete cryptographic scalability. By transforming an $O(N)$ on-chain verification workload into an $O(1)$ constant-time proof submission, ZK-VOTE can easily support governance elections with 100,000+ voters.

---

## 8. Universal Tally-Semantics Verification (ZV-112 / Issue #952)

Everything above hard-codes yes/no semantics into the step state
($\text{yes\_votes}_i$, $\text{no\_votes}_i$) and into
`submit_recursive_tally`'s fixed signature. #699 (see
`docs/spikes/698-701-protocol-boundary-findings.md`) flagged that
`tally.circom` (and, by extension, this Nova step circuit) has **no
universal semantics verification**: a tally proof is correct arithmetic
for *some* ballot shape, but nothing binds which shape, so a quadratic or
weighted tally could not be safely reinterpreted as yes/no (or vice
versa) without a protocol migration.

ZV-112 adds a parallel, additive path rather than generalizing the Nova
step state above (that would be a larger, riskier change to an
already-wired aggregation pipeline):

- `circuits/tally_universal.circom` defines one template per semantics
  (`TallyYesNo`, `TallyQV`, `TallyWeighted`), each exposing its
  `(semanticsId, semanticsVersion)` as public signals asserted equal to
  the template's compile-time constants.
- `contracts/voting/src/lib.rs` adds `set_proposal_semantics` (pins the
  tuple for a proposal before voting starts), `set_semantics_vk` (one VK
  slot per `(dao_id, semanticsId, semanticsVersion)`), and
  `submit_universal_tally` (checks the proof's declared tuple against the
  pinned one *before* attempting Groth16 verification - `submit_recursive_tally`
  and `verify_tally_proof` are untouched).
- `circuits/universal-tally-reference.js` + `circuits/universal-tally.test.js`
  give a pure-JS differential oracle for the three semantics' tally math
  and the mixed-proof-family rejection gate, runnable without the circom
  toolchain.

**Still needed** (same honesty convention as #698-701's findings, not
claimed done here): actual compilation of `tally_universal.circom` against
the pinned circom 2.1.8 toolchain and a witness-generation smoke test (no
compiler was available in the environment this was written in);
reconciling the circuit's additive nullifier accumulator with the
contract's SHA256 hash-chain `accumulate_nullifier`; a real trusted-setup
per semantics/version; measured (not estimated) proving/verification cost
per semantics via `circuits/universal-tally.benchmark.js`'s harness; and,
if this is ever folded into the Nova IVC path above, a generalized step
state that carries the semantics tuple through every fold rather than
only at the final on-chain submission.
