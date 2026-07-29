# Post-Quantum Transition Roadmap for ZKVote

This document outlines the multi-phase engineering and cryptographic roadmap for transitioning ZKVote from classical elliptic-curve zero-knowledge proofs (BN254 Groth16) to post-quantum (PQ) resistant zero-knowledge architectures (STARKs / Lattice-based proofs).

---

## Roadmap Overview & Timelines

```
Phase 1: Hybrid PQ Commitments (Current) ──────► Phase 2: Dual Verification ──────► Phase 3: Native STARK Verification
   - SHA3-256 PQ Commitment Layer                - Groth16 + STARK Dual Proving       - Pure Post-Quantum STARK Proofs
   - Zero Browser Overhead (<20ms)                - Hybrid Relayer Verification        - Soroban Host Function Integration
   - Information-Theoretic Privacy                - Fallback Verification Path         - Deprecation of BN254 Curves
```

---

## Phase 1: Hybrid Post-Quantum Commitment Layer (Immediate Deployment)

### Objectives:
- Protect votes cast today against retroactive decryption by future quantum computers running Shor's algorithm.
- Maintain existing Soroban smart contract verification cost (~1.2M CPU cycles) and fast browser proving times (<500ms).

### Key Deliverables:
1. **Hybrid Commitment Generation**:
   - Voters generate classical Groth16 proof alongside a SHA3-256 Quantum-Resistant Hash Commitment:
     $$C_{PQ} = \text{SHA3-256}(\text{secret} \parallel \text{salt} \parallel \text{dao\_id} \parallel \text{proposal\_id})$$
   - PQ Nullifier: $N_{PQ} = \text{SHA3-256}(\text{secret} \parallel \text{proposal\_id} \parallel \text{"NULLIFIER"})$.
2. **On-Chain Log Snapshot**:
   - Store $C_{PQ}$ and $N_{PQ}$ metadata in Soroban contract events for immutable auditing.
3. **Information-Theoretic Hiding**:
   - Even if BN254 discrete logarithms are solved in 2040+, SHA3-256 commitments remain information-theoretically secure against retroactive vote un-hiding.

---

## Phase 2: Dual Proving & Relayer Verification (Mid-Term 12-18 Months)

### Objectives:
- Introduce client-side STARK proof generation (via WebAssembly) in parallel with Groth16.
- Enable off-chain / relayer dual verification to validate STARK circuit correctness in production.

### Key Deliverables:
1. **Client-Side STARK Prover**:
   - Integrate WebAssembly-compiled STARK FRI prover (Plonky3 / Winterfell) into `frontend/src/lib/postQuantum.ts`.
   - Utilize Web Workers and WASM SIMD for background proving.
2. **Dual-Proof Payload**:
   - Voters submit `{ groth16Proof, starkProof, hybridCommitment }` to relayer.
3. **Relayer Verification**:
   - Relayer verifies STARK proof off-chain before submitting Groth16 proof to Soroban host verifier.

---

## Phase 3: Native On-Chain STARK Verification (Long-Term 2-3 Years)

### Objectives:
- Complete deprecation of BN254 elliptic curves and Groth16 trusted setup.
- Enable direct STARK verification on Stellar Soroban contracts.

### Key Deliverables:
1. **Soroban STARK Verifier Contract**:
   - Deploy lightweight STARK FRI verifier on Soroban (optimized for Goldilocks or M31 field arithmetic).
2. **Full Post-Quantum Protocol**:
   - Transition DAO governance contracts to enforce STARK verifiers natively.
3. **Historical Migration Bridge**:
   - Migration utility for existing DAOs to transition Merkle membership roots from BN254 Poseidon trees to Post-Quantum SHA3 Merkle trees.

---

## NIST Post-Quantum Standards Alignment

ZKVote's post-quantum architecture aligns with NIST PQC finalized standards:
- **Hash Functions**: SHA3-256 and SHAKE256 (FIPS 202) for commitments, Merkle trees, and FRI STARK query layers.
- **Signatures**: SLH-DSA (Stateless Hash-Based Digital Signature Standard, FIPS 205) for post-quantum relayer authorization.
- **Key Encapsulation**: ML-KEM (Module-Lattice Key Encapsulation Mechanism, FIPS 203) for encrypted vote payload channels between voters and tally aggregators.
