# Threat Model (DaoVote)

Scope: current multi-tenant Soroban contracts (registry, membership-sbt, membership-tree, voting), JS relay, and Circom/Groth16 stack. Focus on relay/admin adversaries; users interact via a relayer to preserve anonymity.

## Actors & Trust
- **Users (members)**: generate secrets locally; rely on relay for submission; do not trust relay with identity.
- **Relay (honest-but-curious)**: sees request metadata but is expected not to tamper; cannot access user wallet keys.
- **Relay (malicious)**: may drop/delay/reorder/alter submissions; holds its own key to sign transactions.
- **Contract admin (per DAO)**: can set VK, manage membership (via SBT/tree), and create proposals; not trusted with anonymity or vote integrity beyond defined controls.
- **Chain validators**: assumed honest in execution; P25 host functions enforce cryptography.

## What Relays Learn / Can Do
- **Can learn**: IP/headers/timing, daoId/proposalId/choice/nullifier/root/commitment/proof (from POST body), relayer account balance. Nullifier is per (dao, proposal), so a relay can link retries for the same vote but not map to a member without off-chain identifiers.
- **Cannot learn**: member identity or secret; which leaf in tree corresponds to the proof; voter’s wallet address (relay pays fees).
- **Can do (malicious)**: drop or delay submissions; replay the same payload (contract rejects reused nullifier); submit malformed tx to cause failure; front-run ordering of votes (tally unaffected because votes are additive); censor specific nullifiers by withholding.
- **Cannot do (malicious)**: forge a different vote/choice without an updated proof (pairing check fails); bypass root/nullifier checks; cast votes without valid proof; read on-chain secrets (none stored).

## What Contract Admins Learn / Can Do
- **Can learn**: proposal metadata, tallies, events (nullifier values are public on-chain), membership state they already manage. No access to secrets.
- **Can do**: set/rotate VK for their DAO; create proposals; mint/revoke/reinstate SBTs via membership contracts; initialize tree params per DAO; emit events; pause new proposals by withholding VK; choose vote mode (Fixed/Trailing) when creating proposals.
- **Cannot do**: see voter identities; override votes or edit tallies (no admin entrypoint); accept proofs without proper VK/root/nullifier checks; change VK for an existing proposal (vk_hash is snapshotted and enforced); bypass nullifier replay protection.
- Nullifier domain separation: circuit expects `nullifier = H(secret, dao_id, proposal_id)`; on-chain storage keyed by `(dao_id, proposal_id, nullifier)` to prevent reuse across proposals/DAOs. Election identity is `(dao_id, proposal_id)` — never a flat global `NullifierUsed(hash)` map (issue #64). Legacy global entries, if any, migrate via `migrate_nullifier`. Backend nullifier queries must include both election IDs (`GET /nullifier/:daoId/:proposalId/:nullifier`).

## Code Alignment Checks (current repo)
- `contracts/voting/src/lib.rs`: no admin override path; nullifier checked first; VK hash snapshotted per proposal; root checks enforce snapshot/trailing rules; proof verification bound to public signals (dao/proposal/root/nullifier/choice/commitment); set_vk gated by registry admin.
- `contracts/membership-*`: SBT gating and tree registration restrict membership actions to admin + members per DAO; no entrypoints expose commitments or secrets beyond events with roots/nullifiers.
- Backend: relay receives full vote payload and logs processing lines; does not require user keys; health/ready endpoints expose relayer address/contract IDs only when auth is provided; input validation guards hex/field bounds/all-zero proofs.

## Assumptions & Residual Risks
- Users trust that relay will not log/link IPs to nullifiers; current code logs processing messages and returns detailed simulation errors (could correlate attempts).
- Censorship is possible by a malicious relay (dropping votes) or admin (revoking members, withholding VK); anonymity remains but availability can be impacted.
- Nullifiers are public on-chain; reuse across proposals/DAOs is prevented but nullifier values can be correlated by observers for the same proposal (expected).
- Timing/ordering leakage: observers (including relay) can see when votes land; no batching/cover traffic today.
- Admin can select vote_mode to broaden eligibility (Trailing) or limit (Fixed); this is intentional but should be documented per proposal.

## Root History Eviction (MAX_ROOTS = 30)
The membership-tree contract maintains a FIFO history of the last 30 Merkle roots per DAO. When membership changes occur (adds/removes), old roots are evicted.

**Operational Impact:**
- **Fixed mode**: Proposals store `eligible_root` at creation. If this root is evicted before all members vote, the `root_ok` check may fail even for eligible members. However, Fixed mode stores the root value directly in the proposal, so this primarily affects the contract's ability to verify the root is still in history.
- **Trailing mode**: Proofs must use a root from the current history (last 30). Members who cached proofs with old roots will be unable to vote once their root is evicted.

**Guidance for DAOs:**
- DAOs with frequent membership changes (>30 changes during a proposal's voting period) may strand some voters.
- Consider proposal duration vs. expected membership change rate.
- Frontend could warn when root age approaches eviction threshold.
- For high-activity DAOs, consider shorter voting windows or coordinating membership changes.

## Fixed Mode Revocation Semantics (Intentional Behavior)
In **Fixed mode**, a proposal's eligible root is snapshotted at proposal creation time. This has an important security implication:

**Behavior**: A member who is revoked (SBT burned, commitment removed from tree) AFTER a Fixed-mode proposal is created can still vote on that proposal if:
1. They cached a valid ZK proof generated before revocation
2. The proof uses the `eligible_root` stored in the proposal
3. Their nullifier hasn't been used

**Rationale**: This is intentional for voter privacy. If revoked members couldn't vote on already-open proposals, the admin could determine who has/hasn't voted by timing revocations. The Fixed mode snapshot provides a consistent eligibility boundary.

**Contrast with Trailing Mode**: In Trailing mode, the contract also checks `min_root` (the root at which the member was added). This ensures revoked members cannot vote even on older proposals, because their `min_root` will be invalidated when they're removed. Trailing mode provides stronger revocation guarantees at the cost of some privacy (admin can influence eligibility mid-proposal by revoking members).

## BN254 Public Signal Constraints

All public signals passed to Groth16 verification **must** be less than the BN254 scalar field modulus (Fr):

```
r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
  = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
```

**Why This Matters:**

When public signals are converted to field elements (`Fr::from(x)`), values ≥ r are reduced modulo r. This creates a critical vulnerability:
- If `nullifier = r + 1` is submitted, it's stored as `r + 1` in storage but verifies as `1` in the pairing check
- An attacker could submit `nullifier = 1` for a second vote - different storage key but same proof verification
- This bypasses double-vote protection

**Validation in Contracts:**

Both voting and comments contracts validate **all** public signals using the shared `zkvote_groth16::assert_in_field()` helper:

```rust
// contracts/zkvote-groth16/src/lib.rs
pub fn assert_in_field(env: &Env, value: &U256) {
    if !is_in_field(env, value) {
        panic_with_error!(env, Groth16Error::SignalNotInField);
    }
}
```

**Vote Circuit Public Signals (5 total):**
1. `nullifier` - Must be non-zero AND < r
2. `root` - Merkle tree root, must be < r
3. `dao_id` - DAO identifier (u64, always < r)
4. `proposal_id` - Proposal identifier (u64, always < r)
5. `vote_choice` - Boolean encoded as 0 or 1 (always < r)

**Backend Validation:**

The backend also validates field bounds before submitting to the contract. See `backend/src/validation/schemas.ts` for Zod schemas that check hex string length and prevent all-zero proofs.

**Frontend Validation:**

Use the validation helpers in `frontend/src/types/index.ts`:
```typescript
import { assertValidFieldElement, assertValidNullifier, BN254_FR_MODULUS } from '@/types';

// Validates value < BN254_FR_MODULUS
assertValidFieldElement(root, 'root');

// Validates non-zero AND < BN254_FR_MODULUS
assertValidNullifier(nullifier);
```

## Coercion Resistance (#96)

**Threat:** A coercer forces a voter to reveal their identity secret and vote for a specific candidate. With deterministic credentials the coercer can then verify the voter complied.

**Mitigation — Fake (Panic) Credentials:**
The client exposes `generateFakeZKCredentials()` (`frontend/src/lib/zk.ts`). This produces a structurally valid credential pair (random secret + salt → Poseidon commitment) that the voter can "reveal" to the coercer. The resulting ZK proof passes the circuit but is rejected on-chain because the fake commitment is not in the membership Merkle tree.

**Properties:**
- The coercer cannot distinguish a fake credential from a real one without access to the membership tree.
- The voter's real credential (derived deterministically from their wallet signature) remains usable after the coercion ends.
- Re-voting: because nullifiers are per `(dao_id, proposal_id)`, a voter who submitted a coerced vote with a *real* credential cannot vote again. Full JCJ coercion resistance requires a separate re-voting window; this implementation covers the fake-credential generation step only.

**Residual Risks:**
- If the coercer holds the voter's wallet, they can derive the real credential directly — fake credentials only help when the coercer asks the voter to "sign and show" rather than holding the device.
- Full re-voting protection (latest vote overrides earlier) requires on-chain support not yet implemented.
- A voter who panics and uses a fake credential still loses their effective vote (the nullifier slot for real credentials remains open, but they must re-vote with the real credential before the deadline).

**Planned — Full JCJ Integration:**
- Registrar-side filtering to strip fake-commitment votes from the tally.
- Re-voting window so the real vote can override a coerced submission.
- "Panic mode" UI button in `VoteModal` to switch to fake credentials before signing.

## Next Hardening Steps
- Relay: structured logging with redaction; configurable log retention; coarser error responses; optional cover traffic/backoff to reduce correlation; explicit anti-censorship monitoring (missing votes vs submissions).
- Contracts: coarse error codes to avoid fine-grained leakage; optional per-contract versioning + upgrade events; ensure membership/admin checks stay isolated.
- Ops: monitor relayer availability; document user guidance (do not mix identifiable transactions around anonymous voting).

## Post-Quantum Risk Assessment & Hybrid Defense Model (Issue #115)

### Quantum Threat Vectors to ZKVote Primitives
Quantum computing presents two distinct threat paradigms for cryptographic systems:

1. **Shor's Algorithm ($O(n^3)$ Polynomial Time Breakdown)**:
   - **Target**: Discrete Logarithm Problem (DLP) over elliptic curves (BN254 curve, pairing-based Groth16 zk-SNARKs).
   - **Impact**: Shor's algorithm completely breaks BN254 curve discrete logarithm and pairing security.
   - **System Property at Risk**: **Long-Term Vote Privacy & Voter Anonymity**. An adversary with a quantum computer can solve the discrete log of published Groth16 proofs or commitment signatures, recovering the underlying voter secrets and opening historical vote choices recorded on-chain.
   - **Soundness Impact**: An attacker could forge Groth16 proofs without possessing valid Merkle membership branches, violating soundness.

2. **Grover's Algorithm ($O(\sqrt{N})$ Quadratic Speedup)**:
   - **Target**: Cryptographic hash functions (Poseidon, SHA-256, SHA3-256).
   - **Impact**: Grover's algorithm reduces preimage and collision resistance strength by half (e.g. 256-bit hash has ~128-bit quantum security).
   - **System Property at Risk**: Minimal risk if output size is $\ge 256$ bits. Poseidon-256 and SHA3-256 maintain 128-bit post-quantum security against Grover's algorithm, which remains practically infeasible to attack.

### System Property Risk Matrix

| System Property | Primitive Used | Quantum Vulnerability | Shor/Grover Risk Level | Hybrid / PQ Defense |
| :--- | :--- | :--- | :--- | :--- |
| **Vote Choice Confidentiality** | BN254 Groth16 Proof | Broken by Shor's algorithm | **CRITICAL (Long-term)** | Hybrid Hash Commitment + STARKs |
| **Voter Anonymity / Leaf Privacy** | Poseidon Merkle Tree + BN254 | BN254 broken by Shor's; Poseidon ~128-bit PQ | **HIGH** | Post-Quantum SHA3 Merkle Layer |
| **Double-Voting Prevention** | Nullifier Hash ($H(secret, dao, prop)$) | Dependent on Poseidon hash collision resistance | **LOW** | 256-bit PQ Nullifier ($H_{SHA3}$) |
| **On-chain Tally Soundness** | Soroban Smart Contract Verification | Groth16 verifier broken by Shor's | **HIGH (Future)** | STARK / FRI Proof Verifier |

### Hybrid Post-Quantum Commitment Scheme
To protect votes cast today against quantum decryption decades in the future, ZKVote employs a **Hybrid PQ Commitment Layer**:
- Alongside classical BN254 Poseidon commitments, each vote produces a **Quantum-Resistant Hash Commitment** $C_{PQ} = \text{SHA3-256}(secret \parallel salt \parallel dao\_id \parallel proposal\_id)$.
- Information-theoretic hiding / preimage resistance of SHA3-256 is unaffected by Shor's algorithm, ensuring that recorded on-chain vote transcripts cannot be retroactively opened even if BN254 curve discrete log is solved.

### Post-Quantum Migration Strategy
See [`docs/post-quantum-evaluation.md`](file:///home/uche/ZK-VOTE/docs/post-quantum-evaluation.md) and [`docs/post-quantum-roadmap.md`](file:///home/uche/ZK-VOTE/docs/post-quantum-roadmap.md) for the STARK circuit evaluation (Cairo/Miden vs Groth16) and multi-phase transition roadmap.

- Coercion resistance: implement re-voting window and registrar tally filter (see #96).
- Tally proofs: add `verify_tally_proof` contract entrypoint and circuit for universal verifiability (see #94).
