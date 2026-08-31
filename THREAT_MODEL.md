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

**Frontend disclosure (issue #347)**: The frontend surfaces these revocation semantics to users — the vote-mode picker when creating a proposal, a revocation-semantics explainer in the vote dialog, and an eligibility preview on the proposal page — so the "documented per proposal" guidance above is reflected in the product UI.

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

## Vote-to-Earn Claim & Sybil Bounds (GrantFox Impact: Core feature)

Scope addition: `contracts/rewards`, `circuits/claim.circom`, `backend/src/routes/claim.ts` (`POST /api/v1/claim`), frontend `Claim` flow via `zkproof.ts`/`claimQueries.ts`.

### Architecture choice: thin rewards crate vs token extension

Requirement allowed "extend token or thin rewards crate — document choice". We chose **thin rewards crate** (`contracts/rewards`):

- **Isolation**: Token (SEP-41) upgrade risk avoided; rewards is a minimal treasury ledger (`Treasury(dao_id)`, `RewardAmount(dao_id)`) with no mint/transfer override.
- **Verifiability**: Single `claim()` entrypoint with 5 public signals `[root, voteNullifier, claimNullifier, daoId, proposalId]`; easier to audit than a token with mixed concerns.
- **Composability**: Can back any asset (native XLM, SEP-41, off-chain settlement) via `ClaimEvent`; if a DAO wants on-token mint, deployer can wire `ClaimEvent` → token `mint` off-chain or copy this module into `contracts/token`.
- See `contracts/rewards/src/lib.rs` header and `contracts/rewards/README.md`.

### Claim circuit (vote-family) & double-claim resistance

`circuits/claim.circom` (depth 18, same as vote) proves:

1. `commitment = Poseidon(secret, salt)` is in Merkle tree at `root` (private path, public root).
2. `voteNullifier = Poseidon(secret, daoId, proposalId)` — identical derivation to `vote.circom`; on-chain must be **used** (`voting.is_nullifier_used`).
3. `claimNullifier = Poseidon(secret, daoId, proposalId, CLAIM_TAG)` — **domain-separated** from vote nullifier.
   - `CLAIM_TAG = 427020085613` = `0x636c61696d` = ascii("claim"), Poseidon arity 4 vs vote arity 3.
   - Publicly stored as `ClaimNullifier(dao_id, proposal_id, claimNullifier) -> bool`; second claim with same `claimNullifier` panics `ClaimNullifierUsed` (error #5).
   - Unlinkability: observer sees both nullifiers on-chain but cannot correlate them without `secret`; Poseidon is a random oracle over BN254 Fr.
4. No vote choice — reward is per-voter, not per-choice (prevents bribery via amount correlation).

Public signals (5): `root`, `voteNullifier`, `claimNullifier`, `daoId`, `proposalId`; IC length 6. All validated `< r` and non-zero before any state read (mod-reduction attack prevention). Proof verification: `e(-A,B)*e(alpha,beta)*e(vk_x,gamma)*e(C,delta)=1` via `zkvote_groth16::verify_groth16`.

**On-chain gate (`rewards::claim`)**:

```
assert_in_field(root, voteNullifier, claimNullifier);
require !is_claimed(claimNullifier);
require voting.is_nullifier_used(voteNullifier); // only voters
require root_valid per VoteMode (Fixed: == eligible_root, Trailing: root_ok && idx >= earliest && idx >= min_valid);
require treasury >= reward;
verify Groth16([root, voteNullifier, claimNullifier, daoId, proposalId]);
mark claimed, debit treasury, increment counts, emit ClaimEvent
```

Any failure reverts; replay of `claimNullifier` always fails even with fresh proof (storage key collision).

### Sybil bounds

Grants require explicit Sybil mitigation for rewards; we enforce a **layered defense** (on-chain caps + policy gates + relayer limits). No single layer is sufficient.

#### 1. SBT-age gating (policy + optional on-chain window)

- **Threat**: Attacker mints many SBTs immediately before proposal, votes, claims.
- **Mitigation**: 
  - *Policy*: DAO `membership_open = false` by default; admin vets members. For open DAOs, frontend + docs require **SBT age ≥ 7 days** before `proposal.created_at` to be eligible for rewards. Relayer can be configured to check `registry.get_dao` + `membership_sbt` mint timestamp (if available) and reject claims from fresh SBTs with `Sybil: SBT too recent`.
  - *Future on-chain*: `membership_sbt` stores `MintedAt(dao_id, address) -> timestamp`; `rewards::claim` would require `now - minted_at >= MIN_SBT_AGE`. Not yet active to avoid breaking existing DAOs without timestamps; documented as next hardening.
- **Residual**: If DAO keeps `membership_open = true` and `MIN_SBT_AGE = 0`, Sybil is higher — admin is advised to close membership or fund small pools (see funding caps).

#### 2. Quadratic / funding caps (on-chain)

Rewards are **flat per voter** (not per token weight) to avoid whale amplification, but flat rewards are Sybil-vulnerable; we bound total exposure:

- `MAX_REWARD_PER_CLAIM = 10_000 * 1e7` (10k tokens, 7 decimals) — enforced in `set_reward`.
- `MAX_FUNDING_CAP = 1_000_000_000 * 1e7` (1B tokens) — enforced in `fund_treasury`; cumulative `Treasury(dao_id)` cannot exceed cap.
- `DEFAULT_REWARD = 100 * 1e7` — used if `RewardAmount` not set; keeps default low.
- Per-proposal accounting: `ClaimedCount(dao_id, proposal_id)` and `TotalClaimed(dao_id)` allow off-chain monitoring of Sybil spikes; admin can pause funding (stop `fund_treasury`) if claim rate anomalous.
- **QV variant** (documented for future): If DAO wants stake-weighted rewards, replace flat reward with `reward = sqrt(stake) * base` and fund cap `Σ sqrt(stake) * base ≤ cap`; current flat version is equivalent to QV with `stake = 1` per SBT (one-person-one-vote).

Funding caps are **per DAO** — compromise of one DAO treasury does not affect others.

#### 3. Relayer anonymity + rate limits

- `POST /api/v1/claim` sits behind `claimLimiter` (10/min/IP, hashed IP via SHA256), same as `voteLimiter`; prevents burst Sybil via single IP.
- Relayer never requires voter `Address` or wallet signature for claims; only `daoId, proposalId, voteNullifier, claimNullifier, root, proof`. No linkage to on-chain account in request logs (logs use `daoId/proposalId` only, proof redacted).
- Simulation errors are coarse-grained (`Reward already claimed`, `Vote not found`) to avoid leaking which nullifier was used.

#### 4. Funding caps vs Sybil profit

With flat reward `R` and cap `C`, attacker needs `N = floor(C / R)` Sybil identities to drain pool. With `C = 1e6 * 1e7`, `R = 100 * 1e7`, `N = 10,000`. At `R=10` (smaller rewards), `N=100,000`. Combined with SBT-age + admin vetting, cost to create 10k vetted SBTs exceeds reward.

Admin guidance per DAO (documented for frontend tooltip):
- For high-value pools (>1M), set `membership_open=false` and vet members manually.
- For open pools, set `R ≤ 50` and `C ≤ 100k * R`; monitor `ClaimedCount`.
- Consider shortening proposal lifetime if membership churn >30 roots (eviction risk; see Root History).

### Anonymity preservation (claim)

- Commitment remains private (computed inside circuit).
- Vote and claim nullifiers are unlinkable without `secret`; contract checks vote nullifier **used** but does not link claimer address.
- Relayer route `/api/v1/claim` uses same anonymity set as `/vote` (relayer key pays fee); no `require_auth` on claimer.
- No additional PII in `ClaimEvent` beyond nullifiers (already public for votes).

### Code alignment — claim

- `circuits/claim.circom`: Poseidon(4) with `CLAIM_TAG`, root === merkleProof.root, voteNullifier === Poseidon3, claimNullifier === Poseidon4.
- `contracts/rewards/src/lib.rs`: field checks first, `ClaimNullifierUsed` before cross-contract call, `NotVoted` via `is_nullifier_used`, root checks mirror `voting` (Fixed/Trailing), `TreasuryInsufficient` before proof verify, `VerifyOverride` for tests.
- `backend/src/routes/claim.ts`: `POST /api/v1/claim` + alias `/claim`, `GET /api/v1/claim/status/*`, `GET /api/v1/claim/treasury/*`; validates BN254 fields, rejects all-zero proof, generic error mode respects `RELAYER_GENERIC_ERRORS`.
- `frontend/src/lib/zkproof.ts`: `generateClaimProof`, `calculateClaimNullifier`, `calculateVoteNullifier`.
- `frontend/src/components/ClaimRewards.tsx` + `frontend/src/queries/claimQueries.ts` use `relayerFetch("/api/v1/claim", ...)`.

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
See [`docs/post-quantum-evaluation.md`](docs/post-quantum-evaluation.md) and [`docs/post-quantum-roadmap.md`](docs/post-quantum-roadmap.md) for the STARK circuit evaluation (Cairo/Miden vs Groth16) and multi-phase transition roadmap.

- Coercion resistance: implement re-voting window and registrar tally filter (see #96).
- Tally proofs: add `verify_tally_proof` contract entrypoint and circuit for universal verifiability (see #94).

## Mitigations Applied (#167)

- **Merkle second-preimage attack**: leaves were previously inserted as raw,
  unhashed commitments at tree depth `levels`, making a leaf value and an
  internal-node hash indistinguishable — an attacker who found `C1, C2` with
  `Poseidon(C1, C2) == C_target` could register `C1`/`C2` as members, then
  present `C_target` as a forged leaf. Every leaf is now domain-tagged —
  `leafHash = Poseidon(LEAF_DOMAIN, leaf)`, `LEAF_DOMAIN = 1` — before
  entering the tree, in `circuits/merkle_tree.circom`,
  `frontend/src/lib/merkletree.ts`, and
  `contracts/membership-tree/src/lib.rs`. Verified by
  `test_leaf_is_domain_separated_before_tree_insertion` in
  `contracts/membership-tree/src/test.rs`, which reconstructs the on-chain
  root off-chain using the domain-tagged hash.
- **Groth16 proof malleability**: `(A, B, C)` and `(-A, -B, C)` both satisfy
  the same pairing check; if proof bytes were ever used as a dedup/uniqueness
  key, the two representations would look like distinct submissions.
  `backend/src/services/stellar.ts`'s `canonicalizeProof()` now reduces A's
  Y-coordinate to the lower half of the BN254 base field (negating both A
  and B together, C untouched) before a proof is stored or submitted, so
  both malleable forms of a proof always canonicalize identically.
- **Proof coordinate field-range validation**: `proof.a`/`b`/`c` were
  previously only checked for the all-zeros point at infinity.
  `backend/src/validation/schemas.ts` now also rejects any coordinate that
  isn't a valid BN254 base-field (Fq) element. This is a cheap early
  rejection of malformed input — full curve/subgroup membership
  verification remains the Soroban host's job at proof-verification time
  (unchanged), since a hand-rolled EC membership check without a vetted
  curve library would be a correctness/security risk of its own.

### Explicitly deferred (not addressed by #167)

- **Relayer front-running / proof-to-relayer binding**: this threat model
  already documents relayer front-running as an accepted, low-severity risk
  ("tally unaffected because votes are additive") rather than something the
  system currently prevents. Binding a proof to a specific relayer would
  mean adding `relayer_address` as a new circuit public signal, which
  cascades into the Groth16 verifier's on-chain check and a new trusted
  setup — a change that touches the same failure surface as a new
  cryptographic parameter set and needs its own dedicated, carefully
  reviewed pass rather than being bundled into this one.
- **Circuit constraint-count optimization** (tracked separately, #123): a
  multi-week circuit-engineering task independent of the security fixes
  above.
## Voter Deanonymization at Registration (Issue #122)

**Threat**: during credential/registration flows where a voter submits an
identity commitment tied to an authenticated request (e.g. a signed wallet
challenge), the admin/issuer observes the `(voter_identifier, commitment)`
pair directly. Even though the commitment itself is later used unlinkably
inside the ZK proof (per the "What Relays Learn" section above), the
*registration* step itself leaks the mapping to whoever operates the
issuer, defeating anonymity for anyone who trusts that operator less than
they trust "the protocol".

**Mitigation (implemented as a primitive, not yet wired into registration
routes)**: `backend/src/services/blindSignature.ts` implements RSA blind
signatures (Chaum, 1983), the "simpler alternative to full OT" the issue
calls out:

1. The voter blinds their commitment with a fresh random blinding factor
   before sending it to the issuer: `blinded = commitment * r^e mod n`.
2. The issuer authenticates the voter (via whatever eligibility check is
   already in place) and signs the *blinded* value — it never sees the
   real commitment.
3. The voter unblinds the returned signature locally, obtaining a valid
   issuer signature over their original, never-disclosed commitment.
4. The voter can later present `(commitment, signature)` — e.g. alongside
   their Merkle-inclusion / vote proof — to prove eligibility without the
   issuer being able to link it back to the blinded value from step 1.

**Privacy guarantee (formal sketch)**: for a uniformly random blinding
factor `r` coprime to `n`, `r^e mod n` is uniformly distributed over
`Z_n*` (since `x -> x^e mod n` is a bijection on `Z_n*` when
`gcd(e, phi(n)) = 1`, which RSA key generation guarantees). Multiplying the
commitment by a uniform, secret unit therefore yields a blinded value whose
distribution is statistically independent of the commitment itself
("perfect blinding" in the standard RSA blind signature literature). This
is exercised directly by the unlinkability tests in
`backend/test/blind-signature.test.js` (chi-square uniformity test across
fixed vs. varying underlying messages, and 100% collision-free sampling
across repeated blindings of the same message).

**Residual scope / what's left out**: this landing implements and tests
the cryptographic primitive only. Wiring it end-to-end (new registration
HTTP endpoints for the blind/sign exchange, DB schema for issued
credentials, revocation/one-credential-per-voter enforcement without the
issuer learning the commitment, frontend integration) is a materially
larger change with its own migration and abuse-prevention design (e.g.
preventing a single eligible voter from requesting many blind signatures)
and is intentionally out of scope for this PR — see the PR description for
the full list of deferred acceptance criteria.
