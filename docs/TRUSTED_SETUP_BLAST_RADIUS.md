# Trusted Setup Blast-Radius & Toxic-Waste Analysis (SPIKE-061 & SPIKE-120)

## 1. Executive Summary

In the Groth16 zero-knowledge proof system, soundness relies upon the "1-of-N" trusted setup assumption.
If all contributors to a circuit's Phase 2 parameter generation collude—or if a single party generates the parameters using compromised entropy—an adversary holding the toxic waste can forge valid proofs for arbitrary statements without knowledge of private witnesses.

Historically, ceremony documentation focused on process rather than **blast radius and risk quantification**.
This document maps every deployed circuit artifact to its trusted setup origin, quantifies the exploit economics per forgery class, identifies correlated-compromise sets across depth variants, and establishes an exploit-prioritized migration plan.

---

## 2. Ceremony-to-Circuit Mapping & Provenance

Phase 1 (Powers of Tau) provides universal polynomials, while Phase 2 generates circuit-specific `.zkey` proving keys and verification keys:

| Circuit Artifact | Merkle Depth | Phase 1 Source | Phase 2 MPC Status | Correlated Set Group | Primary Risk Factor |
|---|---|---|---|---|---|
| `bridge.circom` | 15 | Hermez Powers of Tau (2^20) | Local single-run (DEV) | Group A (Cross-Chain) | Cross-chain asset drain & double-mint |
| `tally.circom` | 20 | Hermez Powers of Tau (2^20) | Local single-run (DEV) | Group B (Aggregation) | Silent electoral outcome inversion |
| `vote_d10.circom` | 10 | Hermez Powers of Tau (2^16) | Derived / Local | Group C (Vote Depths) | Single ballot forgery |
| `vote_d15.circom` | 15 | Hermez Powers of Tau (2^16) | Derived / Local | Group C (Vote Depths) | Single ballot forgery |
| `vote_d20.circom` | 20 | Hermez Powers of Tau (2^18) | Dedicated MPC (Batch 1) | Group C (Vote Depths) | Single ballot forgery |
| `vote_d25.circom` | 25 | Hermez Powers of Tau (2^20) | Derived / Local | Group C (Vote Depths) | Single ballot forgery |
| `quadratic_vote.circom` | 20 | Hermez Powers of Tau (2^18) | Local single-run (DEV) | Group D (Quadratic) | Voice credit inflation |
| `comment_v2.circom` | 20 | Hermez Powers of Tau (2^16) | Phase 2 MPC (Batch 2) | Group E (Social) | Forum impersonation & spam |
| `delegation_vote.circom` | 20 | Hermez Powers of Tau (2^18) | Local single-run (DEV) | Group F (Delegation) | Unauthorized proxy voting |

---

## 3. Exploit Economics & Blast Radius Quantification

The damage caused by toxic-waste leakage varies radically by circuit family:

### 3.1 Class 1: Bridge Proof Forgery (`bridge.circom`) — CRITICAL
- **Exploit Economics**: Direct financial extraction. An attacker mints bridged voting power or assets on Stellar/Soroban without locking backing collateral on the source chain.
- **Blast Radius**: Systemic protocol insolvency. Uncapped financial loss.
- **Priority**: Rank 1 (Immediate re-ceremony or bridge circuit deprecation).

### 3.2 Class 2: Tally Aggregation Forgery (`tally.circom`) — HIGH
- **Exploit Economics**: Governance capture. A compromised tally proof allows an attacker to declare any proposal passed or failed with an arbitrary vote margin, bypassing millions of honest voter ballots in a single transaction.
- **Blast Radius**: Full treasury and DAO governance takeover.
- **Priority**: Rank 2.

### 3.3 Class 3: Quadratic Voting Credit Inflation (`quadratic_vote.circom`) — MEDIUM-HIGH
- **Exploit Economics**: Ballot skewing. An adversary can forge proofs asserting they possess $10^6$ voice credits while having staked $1$, skewing quadratic elections.
- **Blast Radius**: Election integrity loss in quadratic DAOs.
- **Priority**: Rank 3.

### 3.4 Class 4: Base Vote Proof Forgery (`vote_d10..d25.circom`) — MEDIUM
- **Exploit Economics**: Sybil ballot casting. The attacker can forge a vote for a fabricated secret without being in the Merkle membership tree. However, on-chain nullifier tracking still enforces that each forged nullifier can only be used once per election.
- **Blast Radius**: Limited to the attacker's ability to submit multiple transactions within proposal deadlines.
- **Priority**: Rank 4.

---

## 4. Depth Variant Forensics & Correlated-Compromise Sets (Absorbed SPIKE-120)

### 4.1 The Shared-Entropy Vulnerability
Because compiling multiple Merkle tree depths (`d10`, `d15`, `d20`, `d25`) requires distinct R1CS constraint matrices, each depth variant technically requires an independent Phase 2 ceremony.
In practice, automated scripts (`compile.sh`, `rebuild-all.sh`) frequently reuse local entropy seeds across depth builds.
- **Correlated Set**: If `vote_d10` through `vote_d25` are compiled on the same operator machine in sequence, any entropy exhaustion or malware on that machine compromises **all four depth variants simultaneously**.

### 4.2 Template-Ceremony Policy
1. **Independent Randomness**: No two depth variants may share Phase 2 entropy.
2. **Registry Trust Tiering**: The on-chain `circuit-registry` contract must record ceremony metadata (`Phase2ContributorsCount`, `CeremonyHash`, `TrustTier: DEV | PROD_MPC`).
3. Contract verifiers must reject verification keys categorized under `TrustTier::DEV` for production proposals with treasury value $> 10,000$ XLM.

---

## 5. Prioritized Migration Roadmap: PLONK / Halo2 Universal Setup

Because Groth16 requires maintaining toxic-waste records for every newly compiled circuit or parameter tweak, the protocol shall eliminate circuit-specific trusted setups according to the following schedule:

```mermaid
graph TD
    A[SPIKE-061 Blast-Radius Audit] --> B[Phase 1: Migrate Bridge to Universal Setup (PLONK)]
    A --> C[Phase 2: Migrate Tally to Universal Setup]
    B --> D[Phase 3: Multi-Party MPC Refresh for Base Vote (d20)]
    C --> D
    D --> E[Phase 4: Full Halo2/STARK Migration across all circuits]
```

1. **Immediate Action (Q4 2026)**:
   - Run 20-party MPC for `bridge.circom` and `tally.circom`.
   - Update `circuit-registry` to pin ceremony transcript hashes.
2. **Universal Setup Acceleration (Q1 2027)**:
   - Implement universal PLONK / Halo2 verification for `bridge` and `tally`, completely removing circuit-specific Phase 2 ceremonies.
