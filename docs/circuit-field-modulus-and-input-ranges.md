# Circuit Field Modulus & Input Range Specification

## 1. Scope & Overview

This document specifies the prime field parameters, signal domains, and valid input ranges for all zero-knowledge circuits in ZK-VOTE (covering `vote.circom`, `vote_v2.circom`, `merkle_tree.circom`, `comment.circom`, and `tally.circom`).

Circom circuits execute over the **BN254 scalar field** ($\mathbb{F}_r$). Signal values exceeding the field modulus wrap around silently modulo $r$ during witness computation. If inputs are not validated before proof generation, an application could present an out-of-field input $X \ge r$, while the circuit proves properties for $X \pmod r$, leading to modular aliasing vulnerabilities.

---

## 2. BN254 Field Constants

| Parameter | Notation | Decimal Value | Hexadecimal Value |
|-----------|----------|---------------|-------------------|
| **BN254 Scalar Field Modulus** | $r$ ($\mathbb{F}_r$) | `21888242871839275222246405745257275088548364400416034343698204186575808495617` | `0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001` |
| **BN254 Base Field Modulus** | $q$ ($\mathbb{F}_q$) | `21888242871839275222246405745257275088696311157297823662689037894645226208583` | `0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47` |

- **Circuit signals and witness computation** live entirely in $\mathbb{F}_r$. Every public signal, private signal, and intermediate node hash must be strictly $< r$.
- **Proof points ($A, B, C$)** live on the BN254 curve over base field $\mathbb{F}_q$ (G1 in $\mathbb{F}_q$, G2 in $\mathbb{F}_{q^2}$). Proof coordinate serialization is validated against $q$.

---

## 3. Signal Range Specifications

### 3.1 Voting Circuit (`vote.circom` & `vote_v2.circom`)

| Signal Name | Visibility | Mathematical Range | Verification Mechanism |
|-------------|------------|-------------------|------------------------|
| `secret` / `identitySecret` | Private | $[0, r - 1]$ | `proofService.assertValidFieldElement`, `proof.worker.ts` |
| `salt` | Private | $[0, r - 1]$ | `proofService.assertValidFieldElement`, `proof.worker.ts` |
| `blindingFactor` | Private | $[0, r - 1]$ | `proofService.assertValidFieldElement`, `proof.worker.ts` |
| `pathElements[levels]` | Private | $[0, r - 1]$ per sibling | `proofService.validateFieldElementArray`, `proof.worker.ts` |
| `pathIndices[levels]` | Private | $\{0, 1\}$ strictly binary | In-circuit $b \cdot (b - 1) = 0$, `proofService.validateBinaryPathIndices` |
| `root` / `merkleRoot` | Public | $[0, r - 1]$ | `proofService.assertValidFieldElement`, on-chain `assert_in_field` |
| `nullifier` | Public | $[1, r - 1]$ (non-zero) | `proofService.assertValidFieldElement`, on-chain replay guard |
| `daoId` | Public | $[0, 2^{64} - 1]$ | `proofService.assertValidFieldElement`, backend schema `u64` |
| `proposalId` | Public | $[0, 2^{64} - 1]$ | `proofService.assertValidFieldElement`, backend schema `u64` |
| `voteChoice` | Public | $[0, \text{numCandidates} - 1]$ | In-circuit `LessThan(32)`, `proofService` validation |
| `numCandidates` | Public | $[1, 2^{32} - 1]$ | In-circuit `LessThan(32)` non-zero check, `proofService` validation |
| `relayerAddress` | Public | $[0, r - 1]$ | In-circuit relayer binding, `proofService.assertValidFieldElement` |

---

## 4. Multi-Layer Defense Boundary

Input validation is enforced across 3 independent boundaries:

1. **Frontend Proving Boundary (`frontend/src/services/proofService.ts` & `proof.worker.ts`)**:
   - Every input payload is validated via `validateCircuitInputs()` before passing to WASM or Web Worker.
   - Values $\ge r$, negative values, or unparseable inputs immediately throw `Field element overflow`.
   - `pathIndices` elements outside $\{0, 1\}$ throw `Invalid path index: must be binary`.
2. **Circuit Constraint Boundary (`circuits/merkle_tree.circom` & `circuits/vote_template.circom`)**:
   - Algebraic constraint `pathIndices[i] * (pathIndices[i] - 1) === 0` enforces binary path selection.
   - Circomlib `LessThan(32)` constraints enforce $0 \le \text{voteChoice} < \text{numCandidates} < 2^{32}$.
3. **On-Chain Soroban Verifier Boundary (`contracts/zkvote-groth16` & ADR 0001)**:
   - Host functions and contract entrypoints assert public signals are strictly in $\mathbb{F}_r$ before pairing checks.
