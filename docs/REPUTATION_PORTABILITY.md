# Anonymous Reputation Portability Spike

This prototype lets a user prove reputation from one DAO to another without disclosing their account or exact score.

## Flow

1. A source DAO attester signs or publishes a reputation commitment.
2. The holder keeps `subjectSecret`, `score`, and `attestationSalt` private.
3. `reputation_attestation.circom` proves the commitment opens correctly and `score >= minScore`.
4. The target DAO receives a scoped `reputationNullifier` for replay protection.
5. Revocation is represented by `revocationNonce`; changing it invalidates previous proofs.

## Selective Disclosure

The public verifier learns only:

- source DAO
- target DAO
- attester key hash
- minimum score threshold
- attestation commitment
- scoped reputation nullifier

It does not learn the exact score, account address, or voting commitment.

## Prototype Artifacts

- `circuits/reputation_attestation.circom`
- `frontend/src/lib/zk.ts` reputation proof input builder

Closes #314 when paired with the prototype implementation.

---

## Sybil Resistance: Trust Tiers, Score Lifecycle, and Farming Economics (SPIKE-042)

### Problem Statement

The original portability design has three exploitable gaps:

1. **Cross-context laundering** — an attestation issued in a low-trust context (e.g. a hobbyist
   forum DAO) can port into a high-stakes election because the circuit has no per-election
   issuer allowlist.
2. **Revocation is not binding in-circuit** — `revocationNonce` invalidates *future* proofs but
   an already-generated proof with the old nonce remains valid; the on-chain verifier cannot
   distinguish a pre-revocation from a post-revocation proof.
3. **Double-counting** — overlapping attestations from multiple issuers who attest the same
   underlying attribute inflate vote weight when summed.

### Issuer Trust Tiers

Each election contract maintains an on-chain **issuer allowlist** keyed by election ID:

```
allowlist[electionId] → Set<issuerKeyHash>
allowlist_tier[issuerKeyHash] → { minScore, maxWeightContribution }
```

The `reputation_attestation.circom` circuit gains a new public input `electionId` and a new
public output `issuerKeyHash`. The on-chain verifier checks `issuerKeyHash ∈ allowlist[electionId]`
before accepting the proof. Issuers absent from the allowlist are rejected at verification time,
not at proof-generation time.

**Tier definitions (reference)**:

| Tier | Examples | maxWeightContribution |
|---|---|---|
| 0 — untrusted | Unknown issuers | 0 (rejected) |
| 1 — community | Hobbyist DAOs, informal groups | 0.25× base weight |
| 2 — verified | KYC providers, established DAOs | 1.0× base weight |
| 3 — sovereign | Government identity anchors | 2.0× base weight |

### Revocation Binding

To make revocation binding in-circuit the attestation commitment must include the current
revocation epoch:

```
attestationCommitment = Poseidon(subjectSecret, score, attestationSalt, revocationEpoch)
```

The **revocation epoch** is a monotonically increasing counter published on-chain by the issuer.
The circuit takes `revocationEpoch` as a public input; the verifier checks that it equals the
issuer's current epoch at proof-verification time. A proof generated before the issuer incremented
the epoch fails on-chain because the public `revocationEpoch` no longer matches.

Migration: existing commitments that omit `revocationEpoch` are treated as epoch 0 and must be
re-attested before use in tier-2 or tier-3 elections.

### Overlap-Resistant Weight Formula

To prevent double-counting when multiple issuers attest the same attribute:

1. Each issuer attests a **category** (`category_key`), e.g. `"identity.age_verified"`.
2. The on-chain tally stores one weight slot per `(voter_nullifier, category_key)` pair.
3. Multiple attestations for the same category are *max-pooled*, not summed.
4. The `reputationNullifier` is scoped to `(subjectSecret, sourceDao, targetDao, electionId, categoryKey)`
   to prevent the same attestation being submitted twice under different category labels.

### Score Farming Mitigations

| Attack | Mitigation |
|---|---|
| Mint multiple DIDs across issuers | Per-election issuer allowlist; tier caps limit total weight from any one category |
| Use a weak attestation in a high-stakes election | Tier check at on-chain verifier |
| Port a revoked attestation | Revocation epoch binding invalidates old proofs on-chain |
| Replay the same nullifier across elections | `electionId` in nullifier preimage scopes it per election |
| Launder a low-tier attestation through a mid-tier relay DAO | `issuerKeyHash` is the *original* issuer; relay DAOs cannot re-sign |

### Updated Circuit Public Inputs

```circom
// New public inputs for SPIKE-042
signal input electionId;        // Scopes allowlist and nullifier
signal input revocationEpoch;   // Current issuer epoch (checked on-chain)
signal input categoryKey;       // Attribute category for overlap-resistance
```

`reputationNullifier` preimage changes to:
```
Poseidon(subjectSecret, sourceDao, targetDao, electionId, categoryKey)
```

### Governance

Allowlist updates (adding/removing issuers, changing tiers) go through the DAO's standard
proposal flow with a 48-hour timelock. Emergency revocation of a compromised issuer bypasses
the timelock but requires a 2/3 multisig quorum from the governance committee.

### Open Action Items (SPIKE-042 resolution)

- [x] Document trust tier model and allowlist schema (this section)
- [x] Define revocation epoch binding mechanism
- [x] Define overlap-resistant weight formula
- [x] Document score farming mitigations
- [ ] Update `reputation_attestation.circom` to include `electionId`, `revocationEpoch`, `categoryKey`
- [ ] Add on-chain allowlist storage and verifier check to `voting` contract
- [ ] Add governance timelock for allowlist mutations
- [ ] Write integration tests: low-tier attestation rejected in high-tier election
- [ ] Write integration test: revoked attestation (epoch mismatch) rejected on-chain
- [ ] Update `THREAT_MODEL.md` to cover cross-context attribute laundering
