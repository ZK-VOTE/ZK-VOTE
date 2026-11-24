# Canonical Public Signal Registry (v1.0.0)

## Overview & Background

In Groth16 zk-SNARK verification on Soroban (and EVM precompiles), public signals must match an exact, deterministic index order.
If signals are transposed (e.g. `daoId` swapped with `proposalId`, or `nullifier` swapped with `daoId`), a cryptographic pairing check may succeed against an invalid semantic statement—allowing votes or actions to be silently credited to the wrong election scope.

This document is the human-readable view of the **authoritative, versioned Public Signal Registry**. The machine-readable source of truth is `shared/protocol-manifest.json`; `scripts/generate-bindings.mjs` renders its signal tuples into the frontend, backend and SDK bindings and into the Rust verifier. `scripts/drift-guard.mjs` compares the manifest against this document, the circom `component main {public [...]}` declarations and the contract/frontend counts, so an order or count change fails CI before a vote is ever cast.

---

## 1. Canonical Circuit Family Registries

### 1.1 Base Vote Circuit Family (`vote.circom`, `vote_template.circom`, `vote_d10..d25.circom`)

- **Total Public Signals**: 6 (`nPublic = 6`, `IC.length = 7`)
- **Endianness Encoding**: 32-byte Big-Endian per scalar field element (BN254 Fq)

| Index | Signal Name | Type | Encoding | Semantics & Range Constraints |
|---|---|---|---|---|
| `0` | `root` | `signal input` | 32-byte BE hex | Membership Merkle tree root (Poseidon) |
| `1` | `nullifier` | `signal output` | 32-byte BE hex | Poseidon(secret, daoId, proposalId) double-vote prevention |
| `2` | `daoId` | `signal input` | 32-byte BE hex | Target DAO identifier / scope |
| `3` | `proposalId` | `signal input` | 32-byte BE hex | Target Proposal identifier within DAO |
| `4` | `voteChoice` | `signal input` | 32-byte BE hex | Binary or scalar choice (`voteChoice * (voteChoice - 1) === 0`) |
| `5` | `numCandidates` | `signal input` | 32-byte BE hex | Number of ballot options (Previously mislabeled as `Commitment`) |

> [!IMPORTANT]
> **Signal 5 Semantic Correction**: In historical conversion scripts (`convert_proof_to_soroban_be.js`), signal index 5 was erroneously labeled `Commitment`. In the canonical circuit specification (`vote_template.circom`), index 5 is `numCandidates`. Big-Endian serialization maps directly to `--num_candidates` in Soroban invocations.

---

### 1.2 Quadratic Voting Circuit Family (`quadratic_vote.circom`)

- **Total Public Signals**: 6
- **Endianness Encoding**: 32-byte Big-Endian per scalar field element

| Index | Signal Name | Type | Encoding | Semantics & Difference from Base Vote |
|---|---|---|---|---|
| `0` | `root` | `signal input` | 32-byte BE hex | Membership Merkle root |
| `1` | `daoId` | `signal input` | 32-byte BE hex | **Swapped Slot**: DAO ID occupies slot 1 |
| `2` | `nullifier` | `signal output` | 32-byte BE hex | **Swapped Slot**: Nullifier occupies slot 2 |
| `3` | `proposalId` | `signal input` | 32-byte BE hex | Target Proposal ID |
| `4` | `voteChoice` | `signal input` | 32-byte BE hex | Candidate index / election choice |
| `5` | `creditsRemaining` | `signal output` | 32-byte BE hex | Remaining voter quadratic voice credits |

> [!CAUTION]
> **Cross-Circuit Incompatibility**: `quadratic_vote` transposes `daoId` (index 1) and `nullifier` (index 2). Proofs generated for quadratic voting must never be passed to base vote verification endpoints; contract entry points MUST validate circuit identifier before decoding public signals.

---

### 1.3 Comment Circuit Family (`comment_v2.circom`)

- **Total Public Signals**: 7 (`nPublic = 7`, `IC.length = 8`)
- **Endianness Encoding**: 32-byte Big-Endian per scalar field element

| Index | Signal Name | Type | Encoding | Semantics |
|---|---|---|---|---|
| `0` | `root` | `signal input` | 32-byte BE hex | Membership Merkle root |
| `1` | `commentHash` | `signal input` | 32-byte BE hex | IPFS content multihash / SHA-256 digest |
| `2` | `authorNullifier` | `signal output` | 32-byte BE hex | Scoped author nullifier |
| `3` | `daoId` | `signal input` | 32-byte BE hex | DAO scope |
| `4` | `proposalId` | `signal input` | 32-byte BE hex | Proposal scope |
| `5` | `timestamp` | `signal input` | 32-byte BE hex | Block timestamp boundary |
| `6` | `reputationRoot`| `signal input` | 32-byte BE hex | Sybil resistance reputation Merkle root |

---

### 1.4 Delegation Circuit Family (`delegation_vote.circom`)

- **Total Public Signals**: 6
- **Endianness Encoding**: 32-byte Big-Endian

| Index | Signal Name | Type | Encoding | Semantics |
|---|---|---|---|---|
| `0` | `root` | `signal input` | 32-byte BE hex | Delegator membership root |
| `1` | `delegationNullifier` | `signal output` | 32-byte BE hex | Nullifier proving delegation assignment |
| `2` | `delegateeKey` | `signal input` | 32-byte BE hex | Delegatee public key hash |
| `3` | `daoId` | `signal input` | 32-byte BE hex | DAO ID |
| `4` | `proposalId` | `signal input` | 32-byte BE hex | Proposal ID |
| `5` | `weight` | `signal output` | 32-byte BE hex | Delegated voting weight |

---

### 1.5 Tally and Bridge Families (`tally.circom`, `bridge.circom`)

- **Tally**: `[resultCommitment, batchRoot, startVotes, endVotes, daoId, proposalId]` (6 signals)
- **Bridge**: `[sourceChainId, targetChainId, sourceRoot, targetNullifier, transferHash]` (5 signals)

---

## 2. Big-Endian Conversion Pipeline Specifications

All signals submitted to the Soroban host functions (`crypto::bn254_verify`) require 256-bit Big-Endian byte arrays:

1. **SnarkJS Public Signals Output**: Array of decimal strings representing field elements $F_q$.
2. **BE Encoding Format**: Each decimal string is converted to a 64-character zero-padded hex string (32 bytes), MSB first.
3. **Soroban Vec<BytesN<32>> Structure**: Index in the Soroban vector matches the registry index identically.

```javascript
// Canonical big-endian signal conversion helper
function encodePublicSignalsBE(publicSignals) {
    return publicSignals.map(sig => {
        const hex = BigInt(sig).toString(16).padStart(64, '0');
        return hex;
    });
}
```

---

## 3. Negative Testing & Misordering Defense

To prevent silent miscounting:
1. **Differential Slot Negative Testing**: Contracts and test suites must explicitly assert failure when:
   - `daoId` and `proposalId` are swapped.
   - `root` and `nullifier` are swapped.
   - Non-canonical field elements ($x \ge p$) are supplied.
2. **Drift Guards**: Contract entrypoints enforce:
   ```rust
   if public_signals.len() != NUM_PUBLIC_SIGNALS {
       return Err(Error::InvalidPublicSignalCount);
   }
   ```

---

## 4. Signal Registry Governance & Safe Onboarding

When sister spikes introduce new public signals (e.g., `epoch` in SPIKE-002, `snapshotRoot` in SPIKE-057, VK-versioning in SPIKE-046):

1. **Append-Only Policy**: New signals MUST be appended to the end of the public signal list to preserve index compatibility for existing verification keys, or require an explicit VK version bump.
2. **Registry Update Before Merging**: No circuit PR may be merged without updating this `docs/SIGNAL_REGISTRY.md` file.
3. **Parity Test Expansion**: Add matching vector tests in `circuits/soroban_be_parity.test.js` asserting the new index and semantics.
4. **Soroban Contract Parameter Update**: Update contract struct definitions and test harnesses synchronously.
