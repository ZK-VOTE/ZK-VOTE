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
- Nullifier domain separation: circuit expects `nullifier = H(secret, dao_id, proposal_id)`; on-chain storage keyed by `(dao_id, proposal_id, nullifier)` to prevent reuse across proposals/DAOs.

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

## Next Hardening Steps
- Relay: structured logging with redaction; configurable log retention; coarser error responses; optional cover traffic/backoff to reduce correlation; explicit anti-censorship monitoring (missing votes vs submissions).
- Contracts: coarse error codes to avoid fine-grained leakage; optional per-contract versioning + upgrade events; ensure membership/admin checks stay isolated.
- Ops: monitor relayer availability; document user guidance (do not mix identifiable transactions around anonymous voting).
