# Circuit Soundness Audit Checklist & Forgery Prevention Methodology

## 1. Overview & Soundness Framework

In zero-knowledge circuit development, constraint count metrics alone (such as `circom --info`) indicate proving cost, NOT cryptographic soundness.
An **under-constrained circuit** admits witnesses that satisfy all equations while representing an untrue computational statement—enabling proof forgery without breaking the underlying cryptography.

This document establishes the mandatory **Circuit Soundness Audit Checklist** and **Forgery Test Harness Specification** for all circuits in ZK-VOTE.

---

## 2. Core Audit Checklist

Every circuit in `circuits/` must pass the following 6-step soundness checklist before deployment:

### 2.1 Boolean & Discrete Domain Enforcement
- [ ] Any signal expected to represent a boolean (`0` or `1`) MUST have an explicit quadratic constraint:
  $$x \cdot (x - 1) = 0$$
- [ ] Boolean signals MUST NOT rely on implicit downstream constraints or `LessThan` checks alone.
- [ ] Candidate selection selectors must verify $\sum s_i = 1$ and each $s_i \in \{0, 1\}$.

### 2.2 Range Check & Field-Aliasing Protection
- [ ] All numeric comparisons (`LessThan`, `GreaterEqThan`) operate within a fixed bit-width $k$ (e.g. 32 or 64 bits).
- [ ] Inputs to comparison gadgets MUST be constrained to $< 2^k$ via `Num2Bits(k)` decomposition before comparison to prevent field-aliasing attacks ($x \pmod q$).
- [ ] No arithmetic division or inversion ($x^{-1}$) without explicit non-zero constraints ($x \neq 0$).

### 2.3 Conditional Control Flow & Branching Soundness
- [ ] Circom `if (...)` statements only execute during witness generation; they DO NOT produce R1CS constraints!
- [ ] Any runtime branching logic (e.g. path selection in Merkle trees, proof branch selection) MUST use arithmetic multiplexers (`Mux1`, `Switch2`, or linear interpolation $y = c \cdot a + (1 - c) \cdot b$).
- [ ] Audit finding: In `exclusion_proof.circom`, branch selection using `if (pathIndices[i] == 0)` must be replaced with `Mux1` to prevent path confusion attacks.

### 2.4 Cryptographic Hashes & Placeholder Audits
- [ ] All hash invocations (Poseidon, SHA-256) must connect output signals with `<==` (constrained assignment).
- [ ] No testing or placeholder components (e.g., `merkle_tree.circom:143` `Sha3Hasher` linear sum) may exist in production circuits.
- [ ] Domain separation tags (`daoId`, `proposalId`, `scopeTag`) must be directly fed into the nullifier hash inputs.

### 2.5 Witness Binding & Free Variable Audit
- [ ] Every intermediate signal declared MUST appear on the left-hand side of at least one `<==` or `===` constraint.
- [ ] Unconstrained witness variables (`signal input` that does not participate in constraint graph) are strictly forbidden.
- [ ] Signatures and public keys (e.g. in `did_attribute_binding.circom`) must be verified on-circuit or bound via canonical commitment hashes.

### 2.6 Merkle Proof Path Consistency
- [ ] Merkle path elements must enforce that every step correctly swaps left/right based on boolean `pathIndices[i]`.
- [ ] Path indices must be constrained to binary values at each level.

---

## 3. Forgery-Attempt Test Harness Specification

Unit testing with honest inputs only verifies correctness, not soundness.
All circuits must be accompanied by negative forgery suites adhering to this harness:

```javascript
describe('Soundness & Forgery Harness: vote_template', () => {
    test('FORGERY ATTEMPT: voteChoice = 2 must be rejected by constraints', async () => {
        const mutatedInput = { ...validInput, voteChoice: 2 };
        await expect(circuit.calculateWitness(mutatedInput, true))
            .rejects.toThrow();
    });

    test('FORGERY ATTEMPT: voteChoice = p - 1 (field-aliasing) must fail', async () => {
        const pMinusOne = '21888242871839275222246405745257275088696311157297823662689037894645226208582';
        const mutatedInput = { ...validInput, voteChoice: pMinusOne };
        await expect(circuit.calculateWitness(mutatedInput, true))
            .rejects.toThrow();
    });

    test('FORGERY ATTEMPT: Non-binary pathIndices must fail Merkle check', async () => {
        const mutatedInput = { ...validInput };
        mutatedInput.pathIndices[0] = 2;
        await expect(circuit.calculateWitness(mutatedInput, true))
            .rejects.toThrow();
    });

    test('FORGERY ATTEMPT: Dropping nullifier constraint admits multiple votes', async () => {
        // Assert that two distinct secrets cannot produce the same nullifier for the same (daoId, proposalId)
    });
});
```

---

## 4. Priority Circuit Audit Order by Blast Radius

Audits and remediation must be executed in descending order of financial and governance impact:

1. **`bridge.circom`**: Cross-chain asset & vote bridging. Blast radius: unlimited synthetic minting.
2. **`tally.circom`** and **`tally_universal.circom`** (ZV-112 / #952): Batch vote aggregation, including the versioned per-semantics (yes/no, QV, weighted) tally templates. Blast radius: arbitrary election outcome manipulation, or a tally proven under one proof family being accepted as another's result if the on-chain semantics-tuple/VK pinning in `contracts/voting/src/lib.rs` (`set_proposal_semantics`, `set_semantics_vk`) is ever bypassed. Not yet compiled against the pinned circom toolchain or witness-tested - see `docs/recursive-proof-architecture.md` §8.
3. **`vote_template.circom` & depth variants**: Individual ballot cast. Blast radius: single ballot forgery.
4. **`quadratic_vote.circom`**: Quadratic credit spending. Blast radius: credit inflation.
5. **`exclusion_proof.circom`**: Non-membership proofs. Blast radius: unauthorized proposal execution.
6. **`comment_v2.circom`**: Discussion & reputation. Blast radius: forum spam / identity spoofing.

---

## 5. CI Audit Gate & Remediation Policy

1. **Automated Constraint Linter**: CI runs static analysis verifying zero unconstrained signals (`circom-analyzer` / `ecne` / `r1cs-analyzer`).
2. **Mandatory Negative Suite**: PRs touching `.circom` files must add or maintain corresponding negative tests in `*.test.js`.
3. **Emergency Circuit Deprecation Playbook**:
   - If an under-constraint bug is confirmed in an active on-chain circuit:
     1. Invoke `voting::deprecate_circuit(circuit_id)` to halt affected proposal execution.
     2. Deploy patched circuit with new verification key.
     3. Initiate expedited MPC ceremony (or universal PLONK transition).
