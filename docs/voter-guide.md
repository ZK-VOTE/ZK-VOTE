# Voter Guide: Hierarchical Deterministic (HD) Multi-Election Key Management

This guide documents the Hierarchical Deterministic (HD) key derivation hierarchy for ZKVote. It explains how voters manage a single master secret to derive unique, unlinkable identity secrets for multiple elections without compromising zero-knowledge privacy or security.

---

## 1. Overview & Problem Statement

In single-secret zero-knowledge voting protocols, voters are required to back up separate cryptographic identity secrets for every single election or DAO they participate in. Managing multiple keys creates key fatigue, increases user error, and leads to permanent loss of voting credentials.

ZKVote solves this through a **Hierarchical Deterministic (HD) Key Derivation Hierarchy** modeled after BIP-32/44 standard in blockchain wallets. With ZKVote HD identity management:
- Voters only back up **one 12-word BIP-39 seed phrase** (or 256-bit master secret).
- Each election deterministically derives a unique, circuit-compatible identity secret.
- Different elections remain **cryptographically unlinkable** without access to the master secret.

---

## 2. Key Derivation Hierarchy Architecture

```
                       master_secret
        (BIP-39 12-word mnemonic or random 256-bit BigInt)
                             │
                             ▼
  ┌─────────────────────────────────────────────────────┐
  │  Poseidon KDF:                                      │
  │  election_secret = Poseidon(master, "ZK-VOTE", id)  │
  └──────────────────────────┬──────────────────────────┘
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
   Identity Commitment                 Nullifier Hash
  Poseidon(election_secret)      Poseidon(election_secret, election_id)
```

### Hierarchy Breakdown:
1. **Master Secret (`master_secret`)**:
   - 256-bit cryptographically secure scalar field element within the BN254 curve modulus ($r$).
   - Standardized as a 12-word human-readable **BIP-39 mnemonic phrase**.
   - Backed up once by the user for all past, present, and future elections.

2. **Per-Election Derived Secret (`election_secret`)**:
   - Derived using a Poseidon-based Key Derivation Function (KDF):
     $$\text{election\_secret} = \text{Poseidon}(\text{master\_secret}, \text{hash}(\text{"ZK-VOTE"}), \text{election\_id}) \pmod r$$
   - Provides domain separation across different elections and applications.
   - Guaranteed to be a valid BN254 scalar field element ($< r$).

3. **Identity Commitment (`commitment`)**:
   - On-chain leaf registered in the Merkle membership tree:
     $$\text{commitment} = \text{Poseidon}(\text{election\_secret})$$

4. **Nullifier Hash (`nullifier`)**:
   - Unique double-voting prevention token bound to the specific proposal/election:
     $$\text{nullifier} = \text{Poseidon}(\text{election\_secret}, \text{election\_id})$$

---

## 3. Cryptographic Properties

### A. Unlinkability (Anonymity Preservation)
- For two distinct election IDs $E_1$ and $E_2$, the derived election secrets $S_{E1}$ and $S_{E2}$ are computed via non-linear Poseidon permutation rounds over BN254.
- An observer with access to $S_{E1}$ or $C_{E1}$ cannot deduce $S_{E2}$ or link $C_{E1}$ and $C_{E2}$ to the same voter without knowledge of the `master_secret`.
- Evaluates as a pseudorandom function (PRF).

### B. Circuit Compatibility
- Standard hash functions (e.g. SHA-256 or PBKDF2) generate large constraint overhead inside arithmetic SNARK circuits.
- By using **Poseidon** natively for key derivation, both off-circuit derivation in the browser UI and inside-circuit verification (in Circom/snarkjs) share identical field arithmetic over BN254.

### C. Master Secret Backup & Recovery
- Voters can recover all past and future election secrets across devices using their 12-word BIP-39 seed phrase.
- BIP-39 mnemonic phrases conform to standard 2048-word English dictionaries and include SHA-256 checksums to detect typing mistakes during restoration.

---

## 4. User Workflow in `VoterRegistration.tsx`

1. **First-Time Voter**:
   - Navigate to the Registration panel or DAO Header.
   - Click **"HD Multi-Election Identity"**.
   - Copy or download the **12-word BIP-39 backup phrase**.
   - The application automatically derives the `election_secret`, `commitment`, and `nullifier` for the current election.

2. **Restoring on a New Device**:
   - Open **"Import Key Phrase"**.
   - Paste the 12-word BIP-39 seed phrase.
   - The application instantly recovers all derived election keys for any election ID.

---

## 5. Developer API (`frontend/src/lib/crypto.ts`)

```typescript
import {
  deriveElectionSecret,
  generateMasterSecret,
  masterSecretToMnemonic,
  mnemonicToMasterSecret
} from "./lib/crypto";

// 1. Generate new BIP-39 master secret
const masterSecret = generateMasterSecret();
const mnemonic = masterSecretToMnemonic(masterSecret);

// 2. Derive per-election identity keys
const electionKeys = await deriveElectionSecret(masterSecret, "election-2026-dao-42");

console.log(electionKeys);
/*
{
  masterSecret: "...",
  electionId: "election-2026-dao-42",
  electionSecret: "...",
  commitment: "...",
  nullifier: "..."
}
*/
```
