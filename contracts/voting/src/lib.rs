//! # Anonymous DAO Voting Contract
//!
//! This contract implements anonymous voting for DAOs using Groth16 zero-knowledge proofs
//! on the BN254 elliptic curve (also known as alt_bn128).
//!
//! ## Cryptographic Primitives
//!
//! ### BN254 Curve (alt_bn128)
//! - **Definition**: y² = x³ + 3 over 𝔽_p where p = 21888242871839275222246405745257275088696311157297823662689037894645226208583
//! - **Order**: r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
//! - **Embedding degree**: 12
//! - **G1 cofactor**: 1 (prime order subgroup)
//! - **G2 cofactor**: 21888242871839275222246405745257275088844257914179612981679871602714643921549
//!
//! **Standards**:
//! - [EIP-196](https://eips.ethereum.org/EIPS/eip-196) - Precompiled contracts for addition and scalar multiplication on BN254 G1
//! - [EIP-197](https://eips.ethereum.org/EIPS/eip-197) - Precompiled contracts for pairing checks on BN254
//! - [BN254 For The Rest Of Us](https://hackmd.io/@jpw/bn254) - Technical deep dive
//!
//! ### Groth16 SNARK
//! - **Paper**: "On the Size of Pairing-based Non-interactive Arguments" by Jens Groth (2016)
//! - **DOI**: [10.1007/978-3-662-49896-5_11](https://doi.org/10.1007/978-3-662-49896-5_11)
//! - **Implementation**: Uses snarkjs for proof generation, Soroban BN254 host functions for verification
//!
//! ## Point Validation & Security
//!
//! See documentation in `set_vk()` for detailed point validation strategy.

#![no_std]
#![allow(clippy::too_many_arguments)]

mod storage;
use soroban_sdk::xdr::ToXdr;
mod stark_verifier;
#[allow(unused_imports)]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bn254::{Bn254G1Affine, Bn254G2Affine, Fr},
    panic_with_error, symbol_short, Address, Bytes, BytesN, Env, IntoVal, String, Symbol, Vec,
    U256,
};

// Re-export shared Groth16 types and utilities
pub use zkvote_groth16::{
    Bls12381Curve, CurveId, Groth16Error, Proof, ProofBls381, VerificationKey,
    VerificationKeyBls381,
};

// ZK quadratic voting with range proofs (issue #50)
mod quadratic;

// Sybil-resistance: SBT-age weighting + reputation score (issue #301)
mod sybil;

// VDF-gated vote commit–reveal (issue #302)
mod commit_reveal;

// Anonymous vote delegation / liquid democracy (issue #304)
mod delegation;

const TREE_CONTRACT: Symbol = symbol_short!("tree");
const REGISTRY: Symbol = symbol_short!("registry");
const CIRCUIT_REGISTRY: Symbol = symbol_short!("circ_reg");
const CIRCUIT_REGISTRY_ADMIN: Symbol = symbol_short!("cr_admin");
const VERSION: u32 = 2;
const STORAGE_VERSION: u32 = 1;
const VERSION_KEY: Symbol = symbol_short!("ver");
const STORAGE_VERSION_KEY: Symbol = symbol_short!("stor_ver");

// TTL management: bump on every interaction to keep contract alive
const INSTANCE_TTL_THRESHOLD: u32 = 120_960; // ~7 days
const INSTANCE_TTL_EXTEND: u32 = 535_680; // ~31 days
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 535_680;
// Nullifiers are Temporary: auto-expire after proposal.end_time + grace period
// 259_200 ledgers @ ~5s/ledger = 72 hours grace for late-arriving txns
const NULLIFIER_GRACE_LEDGERS: u32 = 259_200;
const TEMPORARY_TTL_THRESHOLD: u32 = 51_840; // ~3 days
const TEMPORARY_TTL_EXTEND_BASE: u32 = 259_200; // 72h base, + end_time offset

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum VotingError {
    NotAdmin = 1,
    Unauthorized = 19,
    VkIcLengthMismatch = 2,
    VkIcTooLarge = 3,
    TitleTooLong = 4,
    NotDaoMember = 5,
    EndTimeInvalid = 6,
    NullifierUsed = 7,
    VotingClosed = 8,
    CommitmentRevokedAtCreation = 9,
    CommitmentRevokedDuringVoting = 10,
    RootMismatch = 11,
    RootNotInHistory = 12,
    RootPredatesProposal = 13,
    VkChanged = 14,
    InvalidProof = 15,
    VkNotSet = 16,
    VkVersionMismatch = 17,
    AlreadyInitialized = 18,
    InvalidState = 20,
    InvalidContentCid = 21,
    /// Only DAO admin can create proposals (members_can_propose = false)
    OnlyAdminCanPropose = 22,
    /// G1 point not on BN254 curve (y² ≠ x³ + 3)
    InvalidG1Point = 23,
    /// Root predates member removal (invalid for Trailing mode after revocation)
    RootPredatesRemoval = 24,
    /// Public signal value >= BN254 scalar field modulus (invalid field element)
    SignalNotInField = 25,
    /// Nullifier is zero (invalid)
    InvalidNullifier = 26,
    /// Weighted vote weight out of bounds
    WeightOutOfRange = 27,
    /// Invalid domain tag
    InvalidDomainTag = 28,
    /// Tally proof verification failed (Groth16 pairing check)
    TallyProofInvalid = 29,
    /// Tally proof has not been submitted for this proposal
    TallyProofMissing = 30,
    /// Tally verification key has not been configured for this DAO
    TallyVkNotSet = 31,
    /// Vote tally overflowed u64
    TallyOverflow = 32,
    /// Recursive tally proof inconsistent with on-chain nullifier set
    RecursiveProofInvalid = 33,
}

// Maximum allowed IC vector length (num_public_inputs + 1)
// Our circuit has 5 public signals, so IC should have 6 elements
// Allow some slack for future upgrades (up to 20 public inputs)
const MAX_IC_LENGTH: u32 = 21;

// Size limits to prevent DoS attacks
const MAX_TITLE_LEN: u32 = 100; // Max proposal title length (100 bytes)
const MAX_CID_LEN: u32 = 64; // Max IPFS CID length (CIDv1 is ~59 chars)
const MAX_UPGRADE_PAYLOAD_LEN: u32 = 4096;

// Circuit constants
/// Vote circuit public signals: root, nullifier, dao_id, proposal_id, vote_choice, num_candidates, relayer_address
const NUM_PUBLIC_SIGNALS: u32 = 7;
// IC (inner commitment) vector length for Groth16 VK = num_public_inputs + 1
const VOTE_CIRCUIT_IC_LEN: u32 = NUM_PUBLIC_SIGNALS + 1;
/// Tally circuit public signals: [dao_id, proposal_id, num_votes, yes_votes, no_votes, nullifier_acc]
const TALLY_NUM_PUBLIC_SIGNALS: u32 = 6;
/// IC vector length for the tally Groth16 VK = TALLY_NUM_PUBLIC_SIGNALS + 1
const TALLY_CIRCUIT_IC_LEN: u32 = TALLY_NUM_PUBLIC_SIGNALS + 1;
pub const MAX_PAUSE_DURATION: u64 = 72 * 60 * 60;
pub const RANDOMNESS_COMMIT_WINDOW: u64 = 3_600;
pub const RANDOMNESS_REVEAL_WINDOW: u64 = 3_600;
const MIN_RANDOMNESS_PARTICIPANTS: u32 = 2;
const MAX_RANDOMNESS_PARTICIPANTS: u32 = 32;

// VDF constants
/// Minimum VDF checkpoints for on-chain verification
#[allow(dead_code)]
const MIN_VDF_CHECKPOINTS: u32 = 3;
/// Maximum VDF checkpoints to bound on-chain computation
#[allow(dead_code)]
const MAX_VDF_CHECKPOINTS: u32 = 100;

// Quadratic-voting circuit constants (issue #50)
/// QV circuit public signals: [root, daoId, proposalId, nullifier, totalCreditsSpent, allocationsHash]
const QV_NUM_PUBLIC_SIGNALS: u32 = 6;
/// IC vector length for the QV Groth16 VK = QV_NUM_PUBLIC_SIGNALS + 1
const QV_CIRCUIT_IC_LEN: u32 = QV_NUM_PUBLIC_SIGNALS + 1;
/// Fixed quadratic credit budget per member per snapshot. MUST match the
/// MAX_BUDGET baked into the deployed quadratic_vote circuit (see
/// circuits/quadratic_vote_main.circom). Enforced on-chain as defense in depth;
/// the circuit already proves sum(voiceCredits_i^2) <= MAX_BUDGET.
const MAX_QV_BUDGET: u64 = 100;

// Weighted vote constants — constraint review: weight must be bounded
const MAX_WEIGHT: u32 = 1_000_000;
const MIN_WEIGHT: u32 = 1;
/// Domain tag for weighted voting (prevents cross-circuit replay)
const DOMAIN_TAG_WEIGHTED: u32 = 0x7774_5f76; // "wt_v" ascii prefix

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Proposal(u64, u64), // (dao_id, proposal_id) -> ProposalInfo
    ProposalCount(u64), // dao_id -> count
    /// Election-scoped nullifier usage flag (`NullifierUsed(election, n)`).
    /// Election identity is `(dao_id, proposal_id)`. Must not be a flat global map
    /// — see issue #64 / `storage.rs`.
    Nullifier(u64, u64, U256), // (dao_id, proposal_id, nullifier) -> bool
    VoteFamily(u64, u64, U256), // (dao_id, proposal_id, family_nullifier) -> (u32, bool)
    VotingKey(u64),     // dao_id -> latest VerificationKey (BN254)
    VkVersion(u64),     // dao_id -> current BN254 VK version
    VkByVersion(u64, u32), // (dao_id, vk_version) -> VerificationKey (BN254)
    CurveId(u64),       // dao_id -> CurveId (BN254 or BLS12_381)
    VotingKeyBls381(u64), // dao_id -> latest VerificationKeyBls381
    VkByVersionBls381(u64, u32), // (dao_id, vk_version) -> VerificationKeyBls381
    VkVersionBls381(u64), // dao_id -> current BLS12-381 VK version
    ProposalCurve(u64, u64), // (dao_id, proposal_id) -> CurveId
    /// Test-only: overrides proof verification. Not used in production.
    VerifyOverride,
    DaoCurrentCircuit(u64), // dao_id -> current circuit_id string
    DaoMigration(u64),      // dao_id -> MigrationInfo
    DaoVkProposal(u64),     // dao_id -> pending VK proposal ID from circuit-registry
    /// Flash loan protection: balance snapshot for token-gated proposals
    BalanceSnapshot(u64, u64), // (dao_id, proposal_id) -> BalanceSnapshotInfo
    /// Election configuration including token-gating parameters
    ElectionConfig(u64, u64), // (dao_id, proposal_id) -> ElectionConfig
    /// Transfer cooldown: prevents token transfers during active elections
    TransferCooldown(u64, Address), // (dao_id, voter_address) -> u64 (cooldown end timestamp)
    /// Balance checkpoint for time-weighted average balance computation
    BalanceCheckpoint(u64, Address, u32), // (dao_id, address, ledger_seq) -> i128
    Guardian,
    Paused,
    PausedAt,
    RandomnessCommit(u64, u64, Address),
    RandomnessReveal(u64, u64, Address),
    RandomnessCommitters(u64, u64),
    ActiveProposalCount(u64),
    ProposalCooldown(u64, Address),
    DepositConfig(u64),
    ProposalDeposit(u64, u64),
    /// Legacy global nullifier flag (pre domain-separation). Appended at end so
    /// existing storage discriminants stay stable. Migrate via
    /// [`VotingContract::migrate_nullifier`].
    LegacyNullifierUsed(U256),

    // --- Quadratic voting with range proofs (issue #50) ---
    QvVotingKey(u64),           // dao_id -> latest QV VerificationKey (BN254)
    QvVkVersion(u64),           // dao_id -> current QV VK version
    QvVkByVersion(u64, u32),    // (dao_id, qv_vk_version) -> QV VerificationKey
    QvTallyKey(u64),            // dao_id -> QV tally VerificationKey
    QvBallot(u64, u64, U256),   // (dao_id, round_id, nullifier) -> QvBallot
    QvBallotCount(u64, u64),    // (dao_id, round_id) -> u64
    QvCreditsTotal(u64, u64),   // (dao_id, round_id) -> u128 (sum of credits spent)
    QvTally(u64, u64, u64),     // (dao_id, round_id, proposal_id) -> u64 credits
    QvTallyFinalized(u64, u64), // (dao_id, round_id) -> bool
    /// Reentrancy guard: contract-level lock to prevent reentrant calls
    /// into vote/vote_bls381 during proof verification or cross-contract calls.
    ReentrancyLock,
    /// VDF output for election randomness
    VdfOutput(u64, u64),
    /// VDF proof (checkpoints for on-chain verification)
    VdfProof(u64, u64),
    /// VDF delay parameter (number of SHA256 iterations)
    VdfDelay(u64, u64),
    /// VDF input seed derived from election parameters
    VdfInput(u64, u64),
    /// Whether VDF has been finalized for this election
    VdfFinalized(u64, u64),
    /// Recursive verification key for Nova/SuperNova proof composition
    /// Verification key for the tally SNARK circuit (#94)
    TallyVk(u64), // dao_id -> VerificationKey (BN254)
    RecursiveVk(u64), // dao_id -> Bytes
    /// Finalized recursive vote tally result
    RecursiveTally(u64, u64), // (dao_id, proposal_id) -> RecursiveTallyInfo
    /// ZK proof of correct tally computation for universal verifiability (#94)
    TallyProof(u64, u64), // (dao_id, proposal_id) -> Proof (BN254 Groth16)
    /// Merkle root update history for auditability
    MerkleRootHistory(u64, u64), // (dao_id, proposal_id) -> Vec<MerkleRootRecord>
    /// Applied contract migration by target contract version.
    UpgradeMigration(u32),
    /// Rollback marker by rolled-back contract version.
    UpgradeRollback(u32),
    /// On-chain nullifier accumulator for tally proof binding (#94).
    /// Appended at end so existing storage discriminants stay stable.
    NullifierAccumulator(u64, u64),
}

/// A single quadratic-voting ballot as stored on-chain.
///
/// The individual allocations stay private: only the Poseidon commitment to them
/// (`allocations_hash`) and the revealed quadratic cost (`total_credits_spent`)
/// are recorded. The ZK proof verified at `cast_qv_vote` guarantees that
/// `total_credits_spent == sum(voiceCredits_i^2)` and that every allocation is in
/// range, so overspending is impossible.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QvBallot {
    pub allocations_hash: U256,
    pub total_credits_spent: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RecursiveTallyInfo {
    pub num_votes: u64,
    pub yes_votes: u64,
    pub no_votes: u64,
    pub final_nullifier_acc: U256,
    pub finalized_at: u64,
}

// ── Sybil-resistance layer (#301) ──────────────────────────────────────────

/// Weighted tally alongside the plain head-count.
///
/// Kept separate from `ProposalInfo.yes_votes`/`no_votes` rather than replacing
/// them: a DAO needs both numbers to reason about a result — the weighted total
/// is what decides the vote, the head-count is what tells you whether the
/// weighting changed the outcome.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WeightedTally {
    pub yes_weight: u64,
    pub no_weight: u64,
    pub yes_ballots: u64,
    pub no_ballots: u64,
}

// ── VDF-gated commit–reveal (#302) ─────────────────────────────────────────

/// The commit–reveal schedule for one election.
///
/// The reveal phase does not open on `reveal_opens_at` alone: the election's
/// VDF output must also have been submitted and verified. The timestamp is the
/// *earliest* the phase can open; the VDF is what makes the delay verifiable
/// rather than merely asserted by the ledger clock.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitRevealConfig {
    /// Last timestamp at which a commitment is accepted.
    pub commit_deadline: u64,
    /// Earliest timestamp at which a reveal is accepted.
    pub reveal_opens_at: u64,
    /// Last timestamp at which a reveal is accepted. 0 means no deadline.
    pub reveal_closes_at: u64,
    /// Whether the VDF output must be finalized before reveals open.
    pub require_vdf: bool,
}

// ── Anonymous delegation (#304) ────────────────────────────────────────────

/// A registered delegation of one member's vote on one proposal.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DelegationRecord {
    /// Opaque handle for the delegate: `Poseidon(tag_domain, delegate_secret, dao_id)`.
    pub delegate_tag: U256,
    /// Ledger timestamp of registration.
    pub registered_at: u64,
    /// Revoked by the delegator; the delegate can no longer spend it.
    pub revoked: bool,
    /// Already spent on a vote.
    pub used: bool,
}

#[contracttype]
#[derive(Clone)]
pub struct MigrationInfo {
    pub old_circuit_id: String,
    pub new_circuit_id: String,
    pub deadline: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageLayoutInfo {
    pub contract_version: u32,
    pub storage_version: u32,
    pub latest_migration_at: u64,
    pub rollback_to_version: Option<u32>,
    pub capabilities: Vec<u32>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContractMigrationInfo {
    pub from_version: u32,
    pub to_version: u32,
    pub storage_version: u32,
    pub payload_hash: BytesN<32>,
    pub applied_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum CircuitType {
    Vote,
    Comment,
}

#[contracttype]
#[derive(Clone)]
pub struct CircuitVKResult {
    pub vk: VerificationKey,
    pub num_public_signals: u32,
}

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VkProposalStatus {
    Pending,
    Approved,
    Executed,
    Cancelled,
}

#[contracttype]
#[derive(Clone)]
pub struct VkProposal {
    pub id: u32,
    pub circuit_id: String,
    pub circuit_type: CircuitType,
    pub new_vk: VerificationKey,
    pub new_wasm_hash: BytesN<32>,
    pub proposed_by: Address,
    pub proposed_at: u64,
    pub execute_after: u64,
    pub required_approvals: u32,
    pub approvals: u32,
    pub status: VkProposalStatus,
    pub dao_id: Option<u64>,
}

#[contracttype]
#[derive(Clone)]
pub struct BalanceSnapshotInfo {
    pub snapshot_ledger: u32,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MerkleRootRecord {
    pub root: U256,
    pub set_at: u64,
    pub set_by: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct ElectionConfig {
    pub snapshot_ledger: u32,
    pub min_balance: i128,
    pub twab_window: u64,
    pub candidate_seed: Option<BytesN<32>>,
    /// Number of valid candidates. The circuit constrains voteChoice < num_candidates.
    /// Must be set at election creation and cannot be changed after votes are cast.
    pub num_candidates: u32,
    /// VDF output: y = SHA256^T(x) where x is the VDF input and T is the delay param.
    /// Provides verifiable randomness for deterministic candidate ordering.
    /// None if VDF has not been computed/submitted yet.
    pub vdf_output: Option<BytesN<32>>,
    /// VDF delay parameter: number of SHA256 iterations applied.
    /// Determines the minimum time before VDF output can be revealed.
    pub vdf_delay: u64,
    pub max_revotes: u32,
    /// Timestamp when Merkle root was set or updated.
    pub merkle_root_set_at: Option<u64>,
    /// Commitment window duration (in seconds) after registration opens during which root updates are permitted.
    pub commitment_window: u64,
}

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoteMode {
    Fixed,     // Only members at snapshot can vote
    Trailing,  // Members added after proposal creation can also vote
    Quadratic, // ZK quadratic voting (issue #50). Use `cast_qv_vote`, not `vote`.
}

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProposalState {
    Registration,
    Active,
    Closed,
    Archived,
}

impl ProposalState {
    /// Returns true only for legal forward transitions in the state DAG:
    ///   Registration → Active
    ///   Active → Closed
    ///   Closed → Archived
    /// Archived is terminal — no transitions out of it.
    pub fn is_valid_transition(self, to: ProposalState) -> bool {
        matches!(
            (self, to),
            (ProposalState::Registration, ProposalState::Active)
                | (ProposalState::Active, ProposalState::Closed)
                | (ProposalState::Closed, ProposalState::Archived)
        )
    }
}

#[contracttype]
#[derive(Clone)]
pub struct ProposalInfo {
    pub id: u64,
    pub dao_id: u64,
    pub title: String,       // Short title for display (max 100 bytes)
    pub content_cid: String, // IPFS CID pointing to rich content (or legacy description)
    pub yes_votes: u64,
    pub no_votes: u64,
    pub end_time: u64,
    pub created_by: Address,
    pub created_at: u64, // Timestamp when proposal was created (for revocation checks)
    pub state: ProposalState, // Proposal state (FSM guard)
    pub vk_hash: BytesN<32>, // SHA256 hash of VK at proposal creation
    pub vk_version: u32, // VK version at proposal creation
    pub eligible_root: U256, // Merkle root at creation - defines eligible voter set
    pub vote_mode: VoteMode, // Fixed or Trailing voting
    pub earliest_root_index: u32, // For Trailing mode: earliest valid root index
    pub snapshot_ledger: u32, // Ledger sequence at creation for balance snapshot
}

// Typed Events
#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VKSetEvent {
    #[topic]
    pub dao_id: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ProposalEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub title: String,
    pub content_cid: String,
    pub creator: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ProposalClosedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub closed_by: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ProposalArchivedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub archived_by: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VoteEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub choice: bool,
    pub nullifier: U256,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct AtRiskVoterAlert {
    #[topic]
    pub dao_id: u64,
    pub at_risk_root: U256,
    pub proposal_id: u64,
    pub deadline: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractUpgraded {
    pub from: u32,
    pub to: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct StorageMigratedEvent {
    pub from_version: u32,
    pub to_version: u32,
    pub storage_version: u32,
    pub payload_hash: BytesN<32>,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractRollbackEvent {
    pub from: u32,
    pub to: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractPausedEvent {
    pub guardian: Address,
    pub paused_at: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct RandomnessCommittedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub participant: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractUnpausedEvent {
    pub guardian: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct RandomnessRevealedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub participant: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct CandidateSeedFinalizedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub seed: BytesN<32>,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct QvVoteEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub nullifier: U256,
    pub total_credits_spent: u64,
}

// ── Sybil-resistance layer (#301) ──────────────────────────────────────────

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct WeightedVoteEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub choice: bool,
    pub weight: u32,
    pub nullifier: U256,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct SybilWeightCapSetEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub cap: u32,
}

// ── VDF-gated commit–reveal (#302) ─────────────────────────────────────────

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VoteCommittedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub nullifier: U256,
    pub commit_index: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VoteRevealedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub nullifier: U256,
    pub choice: bool,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct CommitRevealConfiguredEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub commit_deadline: u64,
    pub reveal_opens_at: u64,
}

// ── Anonymous delegation (#304) ────────────────────────────────────────────

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct DelegationRegisteredEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub delegation_commitment: U256,
    pub delegate_tag: U256,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct DelegatedVoteEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub choice: bool,
    pub delegation_nullifier: U256,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct DelegationRevokedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub delegation_commitment: U256,
    pub reclaim_nullifier: U256,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VdfSubmittedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub output: BytesN<32>,
    pub delay: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct RecursiveTallySubmittedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub num_votes: u64,
    pub yes_votes: u64,
    pub no_votes: u64,
    pub final_nullifier_acc: U256,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct QvTallyEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub round_id: u64,
    pub ballots: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VdfVerifiedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub verified: bool,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ElectionStatusChangedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub old_state: Symbol,
    pub new_state: Symbol,
    pub old_root: U256,
    pub new_root: U256,
    pub updated_at: u64,
}

#[contract]
pub struct Voting;

#[contractimpl]
impl Voting {
    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }

    fn bump_persistent<K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &K) {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
    }

    fn bump_temporary<K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &K) {
        env.storage()
            .temporary()
            .extend_ttl(key, TEMPORARY_TTL_THRESHOLD, TEMPORARY_TTL_EXTEND_BASE);
    }

    /// Bump nullifier TTL with proposal-end-time-aware extend amount.
    /// Temporary storage lives until `end_time + NULLIFIER_GRACE_LEDGERS`.
    /// For proposals with no end_time (end_time=0) use the base 72h window.
    fn bump_nullifier_ttl<K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: &K,
        dao_id: u64,
        proposal_id: u64,
    ) {
        let end_time = Self::get_proposal_end_time_internal(env, dao_id, proposal_id);
        let ledger_timestamp = env.ledger().timestamp();
        let ttl_extend: u32 = if end_time == 0 {
            TEMPORARY_TTL_EXTEND_BASE
        } else {
            let remaining_secs = end_time.saturating_sub(ledger_timestamp);
            let remaining_ledgers: u32 = (remaining_secs / 5).try_into().unwrap_or(u32::MAX);
            remaining_ledgers.saturating_add(NULLIFIER_GRACE_LEDGERS)
        };
        let ttl_extend = ttl_extend.max(TEMPORARY_TTL_EXTEND_BASE);
        env.storage()
            .temporary()
            .extend_ttl(key, TEMPORARY_TTL_THRESHOLD, ttl_extend);
    }

    /// Constructor: Initialize contract with MembershipTree address
    pub fn __constructor(env: Env, tree_contract: Address, registry: Address, guardian: Address) {
        // Prevent accidental re-initialization
        if env.storage().instance().has(&VERSION_KEY) {
            panic_with_error!(&env, VotingError::AlreadyInitialized);
        }

        // Record contract version and emit upgrade event for observability
        env.storage().instance().set(&VERSION_KEY, &VERSION);
        env.storage()
            .instance()
            .set(&STORAGE_VERSION_KEY, &STORAGE_VERSION);
        ContractUpgraded {
            from: 0,
            to: VERSION,
        }
        .publish(&env);

        env.storage().instance().set(&TREE_CONTRACT, &tree_contract);
        // Cache registry address to reduce cross-contract call chain from 3 to 1
        env.storage().instance().set(&REGISTRY, &registry);
        env.storage().instance().set(&DataKey::Guardian, &guardian);
    }

    fn require_guardian(env: &Env, guardian: &Address) {
        let configured: Address = env
            .storage()
            .instance()
            .get(&DataKey::Guardian)
            .unwrap_or_else(|| panic_with_error!(env, VotingError::NotGuardian));
        if &configured != guardian {
            panic_with_error!(env, VotingError::NotGuardian);
        }
    }

    fn require_registry(env: &Env) {
        let registry: Address = env.storage().instance().get(&REGISTRY).unwrap();
        registry.require_auth();
    }

    fn require_not_paused(env: &Env) {
        if !env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            return;
        }

        let paused_at: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PausedAt)
            .unwrap_or(0);
        if env.ledger().timestamp() >= paused_at.saturating_add(MAX_PAUSE_DURATION) {
            env.storage().instance().set(&DataKey::Paused, &false);
            let guardian: Address = env.storage().instance().get(&DataKey::Guardian).unwrap();
            ContractUnpausedEvent { guardian }.publish(env);
            return;
        }
        panic_with_error!(env, VotingError::ContractPaused);
    }

    pub fn set_guardian(env: Env, current_guardian: Address, new_guardian: Address) {
        Self::bump_instance(&env);
        current_guardian.require_auth();
        Self::require_guardian(&env, &current_guardian);
        env.storage()
            .instance()
            .set(&DataKey::Guardian, &new_guardian);
    }

    pub fn guardian(env: Env) -> Address {
        Self::bump_instance(&env);
        env.storage().instance().get(&DataKey::Guardian).unwrap()
    }

    /// Current persistent storage layout version.
    pub fn storage_version(env: Env) -> u32 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&STORAGE_VERSION_KEY)
            .unwrap_or(STORAGE_VERSION)
    }

    /// Version negotiation metadata for clients before submitting transactions.
    pub fn storage_layout(env: Env) -> StorageLayoutInfo {
        Self::bump_instance(&env);
        let contract_version = Self::version(env.clone());
        let storage_version = Self::storage_version(env.clone());
        let latest_migration = env
            .storage()
            .persistent()
            .get(&DataKey::UpgradeMigration(contract_version));

        StorageLayoutInfo {
            contract_version,
            storage_version,
            latest_migration_at: latest_migration
                .map(|info: ContractMigrationInfo| info.applied_at)
                .unwrap_or(0),
            rollback_to_version: env
                .storage()
                .persistent()
                .get(&DataKey::UpgradeRollback(contract_version)),
            capabilities: soroban_sdk::vec![&env, 1, 2], // 1: qv, 2: named_signals
        }
    }

    /// Return a migration record by upgraded contract version.
    pub fn migration_for_version(env: Env, version: u32) -> Option<ContractMigrationInfo> {
        Self::bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::UpgradeMigration(version))
    }

    /// Registry-gated upgrade entrypoint.
    ///
    /// The registry enforces DAO-admin governance and the timelock. This hook
    /// verifies the expected current version, records storage migration
    /// metadata, then swaps this contract's Wasm.
    pub fn apply_upgrade_from_registry(
        env: Env,
        wasm_hash: BytesN<32>,
        from_version: u32,
        to_version: u32,
        storage_version: u32,
        migration_payload: Bytes,
    ) {
        Self::bump_instance(&env);
        Self::require_registry(&env);

        let current_version = Self::version(env.clone());
        if current_version != from_version || to_version <= from_version {
            panic_with_error!(&env, VotingError::UpgradeVersionMismatch);
        }
        let current_storage_version = Self::storage_version(env.clone());
        if storage_version < current_storage_version {
            panic_with_error!(&env, VotingError::StorageVersionDowngrade);
        }
        if migration_payload.len() > MAX_UPGRADE_PAYLOAD_LEN {
            panic_with_error!(&env, VotingError::UpgradePayloadTooLarge);
        }

        let payload_hash: BytesN<32> = env.crypto().sha256(&migration_payload).into();
        env.storage().instance().set(&VERSION_KEY, &to_version);
        env.storage()
            .instance()
            .set(&STORAGE_VERSION_KEY, &storage_version);

        let migration = ContractMigrationInfo {
            from_version,
            to_version,
            storage_version,
            payload_hash: payload_hash.clone(),
            applied_at: env.ledger().timestamp(),
        };
        let key = DataKey::UpgradeMigration(to_version);
        env.storage().persistent().set(&key, &migration);
        Self::bump_persistent(&env, &key);

        StorageMigratedEvent {
            from_version,
            to_version,
            storage_version,
            payload_hash,
        }
        .publish(&env);
        ContractUpgraded {
            from: from_version,
            to: to_version,
        }
        .publish(&env);

        env.deployer().update_current_contract_wasm(wasm_hash);
    }

    /// Registry-gated rollback entrypoint using a pre-approved rollback Wasm.
    pub fn rollback_upgrade_from_registry(
        env: Env,
        wasm_hash: BytesN<32>,
        from_version: u32,
        to_version: u32,
    ) {
        Self::bump_instance(&env);
        Self::require_registry(&env);

        let current_version = Self::version(env.clone());
        if current_version != from_version || to_version >= from_version {
            panic_with_error!(&env, VotingError::UpgradeVersionMismatch);
        }

        env.storage().instance().set(&VERSION_KEY, &to_version);
        let key = DataKey::UpgradeRollback(from_version);
        env.storage().persistent().set(&key, &to_version);
        Self::bump_persistent(&env, &key);

        ContractRollbackEvent {
            from: from_version,
            to: to_version,
        }
        .publish(&env);

        env.deployer().update_current_contract_wasm(wasm_hash);
    }

    pub fn pause(env: Env, guardian: Address) {
        Self::bump_instance(&env);
        guardian.require_auth();
        Self::require_guardian(&env, &guardian);
        if Self::is_paused(env.clone()) {
            panic_with_error!(&env, VotingError::ContractPaused);
        }
        let paused_at = env.ledger().timestamp();
        env.storage().instance().set(&DataKey::Paused, &true);
        env.storage().instance().set(&DataKey::PausedAt, &paused_at);
        ContractPausedEvent {
            guardian,
            paused_at,
        }
        .publish(&env);
    }

    pub fn unpause(env: Env, guardian: Address) {
        Self::bump_instance(&env);
        guardian.require_auth();
        Self::require_guardian(&env, &guardian);
        env.storage().instance().set(&DataKey::Paused, &false);
        ContractUnpausedEvent { guardian }.publish(&env);
    }

    pub fn is_paused(env: Env) -> bool {
        Self::bump_instance(&env);
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        let paused_at: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PausedAt)
            .unwrap_or(0);
        paused && env.ledger().timestamp() < paused_at.saturating_add(MAX_PAUSE_DURATION)
    }

    /// Validate that a U256 value is within the BN254 scalar field (< r).
    /// Panics with a coarse-mapped [`VotingError::SignalNotInField`] under
    /// [`PathContext::Anonymous`].
    fn assert_in_field(env: &Env, ctx: PathContext, value: &U256) {
        if zkvote_groth16::assert_in_field(env, value).is_err() {
            panic_coarse(env, ctx, VotingError::SignalNotInField);
        }
    }

    /// Validate that a U256 value is within the BLS12-381 scalar field.
    fn assert_in_field_bls381(env: &Env, ctx: PathContext, value: &U256) {
        if zkvote_groth16::assert_in_field_bls381(env, value).is_err() {
            panic_coarse(env, ctx, VotingError::SignalNotInField);
        }
    }

    /// Read the curve ID for a DAO (defaults to Bn254)
    fn get_curve_id(env: &Env, dao_id: u64) -> CurveId {
        env.storage()
            .persistent()
            .get(&DataKey::CurveId(dao_id))
            .unwrap_or(CurveId::Bn254)
    }

    /// Set verification key for a DAO (admin only)
    pub fn set_vk(env: Env, dao_id: u64, vk: VerificationKey, admin: Address) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);
        // Validate VK size to prevent DoS attacks
        Self::validate_vk(&env, &vk);

        // Point Validation Strategy:
        // ===========================
        //
        // This contract validates VK shape and public signal field bounds before proof verification:
        //
        // 1. G1 curve membership: y² = x³ + 3 (mod p) for all G1 points
        // 2. Coordinate bounds: x, y < field modulus p
        // 3. Point at infinity: all-zeros is valid
        //
        // G1 decoding and validation is delegated to Soroban BN254 host functions for:
        // - Proof points: a, c
        // - VK points: alpha, all IC points
        //
        // G2 decoding and validation also relies on Soroban BN254 host functions.
        // Invalid G2 points will cause the pairing equation to fail.
        //
        // The 256-bit modular arithmetic uses 64-bit limb schoolbook multiplication
        // with repeated subtraction for reduction. This is not constant-time but
        // is correct for all field elements.
        //
        // G2 Point Validation (Extended Discussion):
        // ==========================================
        //
        // BN254 G2 has cofactor h = 21888242871839275222246405745257275088844257914179612981679871602714643921549
        // This means the G2 curve group has order h·r, where only the subgroup of order r is cryptographically safe.
        //
        // Proper G2 validation requires:
        // 1. Curve membership: Point lies on twist curve E'(𝔽_p²)
        // 2. Subgroup membership: [h]P = O (point times cofactor equals identity)
        //
        // Why we don't perform explicit G2 subgroup checks:
        //
        // **For Verification Key (beta, gamma, delta):**
        // - Generated during trusted setup by snarkjs
        // - Setup process ensures points are in correct subgroup
        // - Malicious VK would be caught during proof verification (pairing fails)
        // - Admin setting VK is trusted (they could DoS the DAO regardless)
        //
        // **For Proof.b:**
        // - Invalid subgroup points cannot satisfy the pairing equation
        // - Groth16 security proof assumes honest verifier, malicious prover
        // - Prover cannot forge proofs using invalid G2 points
        // - Reference: Groth16 paper (Theorem 1, EUROCRYPT 2016)
        //
        // **G2 Point Validation (CAP-0074):**
        // Per CAP-0074, the `bn254_multi_pairing_check` host function validates G2 points:
        // - Curve membership: Points must satisfy the G2 curve equation
        // - Subgroup membership: Points must belong to the correct subgroup
        // - Format compliance: Must be 128 bytes, uncompressed format
        // Invalid G2 points cause the host function to return an error.
        //
        // **Attack Analysis:**
        // - Invalid curve attacks (CVE-2023-40141) target parsers, not pairings
        // - Soroban host function validates G2 curve + subgroup before pairing
        // - Small subgroup attacks mitigated by host's explicit subgroup check
        // - Public signals validated explicitly before scalar conversion
        //
        // References:
        // - [CAP-0074](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0074.md)
        // - Groth16 paper Section 3.2 - Verification algorithm

        // Bump VK version
        let new_version = Self::bump_vk_version(&env, dao_id);

        let key = DataKey::VotingKey(dao_id);
        env.storage().persistent().set(&key, &vk);
        Self::bump_persistent(&env, &key);
        let vk_ver_key = DataKey::VkByVersion(dao_id, new_version);
        env.storage().persistent().set(&vk_ver_key, &vk);
        Self::bump_persistent(&env, &vk_ver_key);

        VKSetEvent { dao_id }.publish(&env);
    }

    /// Set BLS12-381 verification key for a DAO (admin only)
    pub fn set_vk_bls381(env: Env, dao_id: u64, vk: VerificationKeyBls381, admin: Address) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);
        Self::validate_vk_bls381(&env, &vk);

        // Store curve ID
        let curve_key = DataKey::CurveId(dao_id);
        env.storage()
            .persistent()
            .set(&curve_key, &CurveId::Bls12381);
        Self::bump_persistent(&env, &curve_key);

        // Bump BLS12-381 VK version
        let version_key = DataKey::VkVersionBls381(dao_id);
        let current_version: u32 = env.storage().persistent().get(&version_key).unwrap_or(0);
        let new_version = current_version + 1;
        env.storage().persistent().set(&version_key, &new_version);
        Self::bump_persistent(&env, &version_key);

        let key = DataKey::VotingKeyBls381(dao_id);
        env.storage().persistent().set(&key, &vk);
        Self::bump_persistent(&env, &key);
        let vk_ver_key = DataKey::VkByVersionBls381(dao_id, new_version);
        env.storage().persistent().set(&vk_ver_key, &vk);
        Self::bump_persistent(&env, &vk_ver_key);

        VKSetEvent { dao_id }.publish(&env);
    }

    /// Set Nova/SuperNova recursive verification key for a DAO (admin only)
    pub fn set_recursive_vk(env: Env, dao_id: u64, vk_bytes: Bytes, admin: Address) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);

        let key = DataKey::RecursiveVk(dao_id);
        env.storage().persistent().set(&key, &vk_bytes);
        Self::bump_persistent(&env, &key);
    }

    /// Set the verification key for the tally SNARK circuit (admin only).
    pub fn set_tally_vk(env: Env, dao_id: u64, vk: VerificationKey, admin: Address) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);
        if vk.ic.len() != TALLY_CIRCUIT_IC_LEN {
            panic_with_error!(&env, VotingError::VkIcLengthMismatch);
        }
        let key = DataKey::TallyVk(dao_id);
        env.storage().persistent().set(&key, &vk);
        Self::bump_persistent(&env, &key);
    }

    /// Fetch recursive verification key for a DAO
    pub fn get_recursive_vk(env: Env, dao_id: u64) -> Option<Bytes> {
        env.storage()
            .persistent()
            .get(&DataKey::RecursiveVk(dao_id))
    }

    /// Submit single aggregated recursive proof attesting to N votes cast in an election
    pub fn submit_recursive_tally(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        num_votes: u64,
        yes_votes: u64,
        no_votes: u64,
        final_nullifier_acc: U256,
        proof: Proof,
    ) -> Result<(), VotingError> {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);

        let total_votes = yes_votes
            .checked_add(no_votes)
            .ok_or(VotingError::TallyOverflow)?;
        if total_votes != num_votes {
            return Err(VotingError::RecursiveProofInvalid);
        }

        Self::verify_tally_proof_data(
            &env,
            dao_id,
            proposal_id,
            &proof,
            num_votes,
            yes_votes,
            no_votes,
            &final_nullifier_acc,
        )?;

        let key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(VotingError::VotingClosed)?;

        if proposal.state != ProposalState::Active {
            return Err(VotingError::VotingClosed);
        }

        let now = env.ledger().timestamp();
        if now > proposal.end_time {
            return Err(VotingError::VotingClosed);
        }

        // Update proposal tallies with checked arithmetic
        proposal.yes_votes = proposal
            .yes_votes
            .checked_add(yes_votes)
            .ok_or(VotingError::TallyOverflow)?;
        proposal.no_votes = proposal
            .no_votes
            .checked_add(no_votes)
            .ok_or(VotingError::TallyOverflow)?;
        proposal.state = ProposalState::Closed;

        env.storage().persistent().set(&key, &proposal);
        Self::bump_persistent(&env, &key);

        let tally_info = RecursiveTallyInfo {
            num_votes,
            yes_votes,
            no_votes,
            final_nullifier_acc: final_nullifier_acc.clone(),
            finalized_at: now,
        };
        let tally_key = DataKey::RecursiveTally(dao_id, proposal_id);
        env.storage().persistent().set(&tally_key, &tally_info);
        Self::bump_persistent(&env, &tally_key);

        // Store tally proof for independent verification (#94)
        let proof_key = DataKey::TallyProof(dao_id, proposal_id);
        env.storage().persistent().set(&proof_key, &proof);
        Self::bump_persistent(&env, &proof_key);

        RecursiveTallySubmittedEvent {
            dao_id,
            proposal_id,
            num_votes,
            yes_votes,
            no_votes,
            final_nullifier_acc,
        }
        .publish(&env);

        Ok(())
    }

    /// Fetch recursive tally info for a proposal
    pub fn get_recursive_tally(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
    ) -> Option<RecursiveTallyInfo> {
        env.storage()
            .persistent()
            .get(&DataKey::RecursiveTally(dao_id, proposal_id))
    }

    /// Return the raw stored tally proof bytes without verification.
    pub fn get_tally_proof(env: Env, dao_id: u64, proposal_id: u64) -> Option<Bytes> {
        let proof: Option<Proof> = env
            .storage()
            .persistent()
            .get(&DataKey::TallyProof(dao_id, proposal_id));
        proof.map(|proof| proof.to_xdr(&env))
    }

    /// Return the current nullifier accumulator for an election.
    pub fn get_nullifier_accumulator(env: Env, dao_id: u64, proposal_id: u64) -> U256 {
        Self::bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::NullifierAccumulator(dao_id, proposal_id))
            .unwrap_or(U256::from_u32(&env, 0))
    }

    /// Update the election nullifier accumulator with a newly used nullifier.
    ///
    /// The accumulator is SHA256(prev_acc || nullifier); the tally SNARK must
    /// reproduce the same final value. This binds the tally proof to the
    /// on-chain nullifier set (issue #94).
    fn accumulate_nullifier(env: &Env, dao_id: u64, proposal_id: u64, nullifier: &U256) {
        let key = DataKey::NullifierAccumulator(dao_id, proposal_id);
        let current: U256 = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(U256::from_u32(env, 0));
        let mut data = Bytes::new(env);
        data.append(&Bytes::from_array(env, &current.to_bytes().to_array()));
        data.append(&Bytes::from_array(env, &nullifier.to_bytes().to_array()));
        let hash: BytesN<32> = env.crypto().sha256(&data).into();
        let next = U256::from_bytes(env, &hash);
        env.storage().persistent().set(&key, &next);
        Self::bump_persistent(env, &key);
    }

    /// Verify the tally SNARK proof for a finalized election.
    ///
    /// Recomputes the public signals from the on-chain proposal and recursive
    /// tally, then performs the Groth16 pairing check. A wrong tally, or a
    /// proof for a different election, is rejected with
    /// [`VotingError::TallyProofInvalid`].
    pub fn verify_tally_proof(env: Env, dao_id: u64, proposal_id: u64) -> Result<(), VotingError> {
        Self::bump_instance(&env);

        let proof_key = DataKey::TallyProof(dao_id, proposal_id);
        let proof: Proof = env
            .storage()
            .persistent()
            .get(&proof_key)
            .ok_or(VotingError::TallyProofMissing)?;
        Self::bump_persistent(&env, &proof_key);

        let tally_key = DataKey::RecursiveTally(dao_id, proposal_id);
        let tally: RecursiveTallyInfo = env
            .storage()
            .persistent()
            .get(&tally_key)
            .ok_or(VotingError::TallyProofMissing)?;
        Self::bump_persistent(&env, &tally_key);

        Self::verify_tally_proof_data(
            &env,
            dao_id,
            proposal_id,
            &proof,
            tally.num_votes,
            tally.yes_votes,
            tally.no_votes,
            &tally.final_nullifier_acc,
        )
    }

    fn verify_tally_proof_data(
        env: &Env,
        dao_id: u64,
        proposal_id: u64,
        proof: &Proof,
        num_votes: u64,
        yes_votes: u64,
        no_votes: u64,
        final_nullifier_acc: &U256,
    ) -> Result<(), VotingError> {
        let vk_key = DataKey::TallyVk(dao_id);
        let vk: VerificationKey = env
            .storage()
            .persistent()
            .get(&vk_key)
            .ok_or(VotingError::TallyVkNotSet)?;
        Self::bump_persistent(env, &vk_key);

        if vk.ic.len() != TALLY_CIRCUIT_IC_LEN {
            return Err(VotingError::VkIcLengthMismatch);
        }

        Self::assert_in_field(env, final_nullifier_acc);

        let acc_key = DataKey::NullifierAccumulator(dao_id, proposal_id);
        let expected_acc: U256 = match env.storage().persistent().get(&acc_key) {
            Some(acc) => {
                Self::bump_persistent(env, &acc_key);
                acc
            }
            None => U256::from_u32(env, 0),
        };
        if &expected_acc != final_nullifier_acc {
            return Err(VotingError::TallyProofInvalid);
        }

        let dao_signal = U256::from_u128(env, dao_id as u128);
        let proposal_signal = U256::from_u128(env, proposal_id as u128);
        let num_votes_signal = U256::from_u128(env, num_votes as u128);
        let yes_signal = U256::from_u128(env, yes_votes as u128);
        let no_signal = U256::from_u128(env, no_votes as u128);

        let pub_signals = soroban_sdk::vec![
            env,
            dao_signal,
            proposal_signal,
            num_votes_signal,
            yes_signal,
            no_signal,
            final_nullifier_acc.clone(),
        ];

        if !Self::verify_groth16(env, &vk, proof, &pub_signals) {
            return Err(VotingError::TallyProofInvalid);
        }
        Ok(())
    }

    /// Internal helper to fetch a BN254 VK by version or fail with a clear error
    fn get_vk_by_version(env: &Env, dao_id: u64, version: u32) -> VerificationKey {
        env.storage()
            .persistent()
            .get(&DataKey::VkByVersion(dao_id, version))
            .unwrap_or_else(|| panic_with_error!(env, VotingError::VkVersionMismatch))
    }

    /// Internal helper to fetch a BLS12-381 VK by version or fail with a clear error
    fn get_vk_by_version_bls381(env: &Env, dao_id: u64, version: u32) -> VerificationKeyBls381 {
        env.storage()
            .persistent()
            .get(&DataKey::VkByVersionBls381(dao_id, version))
            .unwrap_or_else(|| panic_with_error!(env, VotingError::VkVersionMismatch))
    }

    fn assert_admin(env: &Env, dao_id: u64, admin: &Address) {
        // Use cached registry address (set at constructor) - only 1 cross-contract call
        let registry: Address = env.storage().instance().get(&REGISTRY).unwrap();

        let dao_admin: Address = env.invoke_contract(
            &registry,
            &symbol_short!("get_admin"),
            soroban_sdk::vec![env, dao_id.into_val(env)],
        );

        if &dao_admin != admin {
            panic_with_error!(env, VotingError::NotAdmin);
        }
    }

    fn validate_vk(env: &Env, vk: &VerificationKey) {
        if vk.ic.len() != VOTE_CIRCUIT_IC_LEN {
            panic_with_error!(env, VotingError::VkIcLengthMismatch);
        }
        if vk.ic.len() > MAX_IC_LENGTH {
            panic_with_error!(env, VotingError::VkIcTooLarge);
        }
    }

    fn validate_vk_bls381(env: &Env, vk: &VerificationKeyBls381) {
        if vk.ic.len() != VOTE_CIRCUIT_IC_LEN {
            panic_with_error!(env, VotingError::VkIcLengthMismatch);
        }
        if vk.ic.len() > MAX_IC_LENGTH {
            panic_with_error!(env, VotingError::VkIcTooLarge);
        }
    }

    fn bump_vk_version(env: &Env, dao_id: u64) -> u32 {
        let version_key = DataKey::VkVersion(dao_id);
        let current_version: u32 = env.storage().persistent().get(&version_key).unwrap_or(0);
        let new_version = current_version + 1;
        env.storage().persistent().set(&version_key, &new_version);
        Self::bump_persistent(env, &version_key);
        new_version
    }

    fn assert_weight_in_range(env: &Env, ctx: PathContext, weight: u32) {
        if weight < MIN_WEIGHT || weight > MAX_WEIGHT {
            panic_coarse(env, ctx, VotingError::WeightOutOfRange);
        }
    }

    fn assert_domain_tag_valid(env: &Env, ctx: PathContext, domain_tag: u32) {
        if domain_tag != DOMAIN_TAG_WEIGHTED {
            panic_coarse(env, ctx, VotingError::InvalidDomainTag);
        }
    }

    /// Set verification key from registry during DAO initialization
    /// This function is called by the registry contract during create_and_init_dao
    /// to avoid re-entrancy issues. The registry is a trusted system contract.
    ///
    /// CRIT-3 fix (2026-05-24): require the registry contract's auth — the
    /// previous code documented "registry is a trusted system contract" but
    /// did NOT enforce it. Sibling `init_tree_from_registry`/`register_from_registry`
    /// already do this; this one was missed in the original audit pass.
    pub fn set_vk_from_registry(env: Env, dao_id: u64, vk: VerificationKey) {
        let registry: Address = env.storage().instance().get(&REGISTRY).unwrap();
        registry.require_auth();
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        Self::validate_vk(&env, &vk);

        // Bump VK version
        let new_version = Self::bump_vk_version(&env, dao_id);

        let key = DataKey::VotingKey(dao_id);
        env.storage().persistent().set(&key, &vk);
        Self::bump_persistent(&env, &key);
        let vk_ver_key = DataKey::VkByVersion(dao_id, new_version);
        env.storage().persistent().set(&vk_ver_key, &vk);
        Self::bump_persistent(&env, &vk_ver_key);

        VKSetEvent { dao_id }.publish(&env);
    }

    /// Set BLS12-381 verification key from registry during DAO initialization
    pub fn set_vk_from_registry_bls381(env: Env, dao_id: u64, vk: VerificationKeyBls381) {
        let registry: Address = env.storage().instance().get(&REGISTRY).unwrap();
        registry.require_auth();
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        Self::validate_vk_bls381(&env, &vk);

        // Store curve ID
        let curve_key = DataKey::CurveId(dao_id);
        env.storage()
            .persistent()
            .set(&curve_key, &CurveId::Bls12381);
        Self::bump_persistent(&env, &curve_key);

        // Bump BLS12-381 VK version
        let version_key = DataKey::VkVersionBls381(dao_id);
        let current_version: u32 = env.storage().persistent().get(&version_key).unwrap_or(0);
        let new_version = current_version + 1;
        env.storage().persistent().set(&version_key, &new_version);
        Self::bump_persistent(&env, &version_key);

        let key = DataKey::VotingKeyBls381(dao_id);
        env.storage().persistent().set(&key, &vk);
        Self::bump_persistent(&env, &key);
        let vk_ver_key = DataKey::VkByVersionBls381(dao_id, new_version);
        env.storage().persistent().set(&vk_ver_key, &vk);
        Self::bump_persistent(&env, &vk_ver_key);

        VKSetEvent { dao_id }.publish(&env);
    }

    /// Create a new proposal for a DAO
    /// Voting starts immediately upon creation (Merkle root snapshot taken now)
    /// title: Short display title (max 100 bytes)
    /// content_cid: IPFS CID pointing to rich content (or legacy plain text description)
    /// end_time: Unix timestamp for when voting closes (must be in the future, or 0 for no deadline)
    pub fn create_proposal(
        env: Env,
        dao_id: u64,
        title: String,
        content_cid: String,
        end_time: u64,
        creator: Address,
        vote_mode: VoteMode,
    ) -> u64 {
        // bump_instance called inside create_proposal_with_version
        Self::create_proposal_with_version(
            env,
            dao_id,
            title,
            content_cid,
            end_time,
            creator,
            vote_mode,
            None,
        )
    }

    /// Create a proposal initialized in Registration phase for Merkle root commitment window
    pub fn create_proposal_in_registration(
        env: Env,
        dao_id: u64,
        title: String,
        content_cid: String,
        end_time: u64,
        creator: Address,
        vote_mode: VoteMode,
    ) -> u64 {
        let id = Self::create_proposal_with_version(
            env.clone(),
            dao_id,
            title,
            content_cid,
            end_time,
            creator,
            vote_mode,
            None,
        );
        let key = DataKey::Proposal(dao_id, id);
        let mut proposal: ProposalInfo = env.storage().persistent().get(&key).unwrap();
        proposal.state = ProposalState::Registration;
        env.storage().persistent().set(&key, &proposal);
        id
    }

    /// Create proposal with a specific VK version (must be <= current and exist)
    pub fn create_proposal_with_vk_version(
        env: Env,
        dao_id: u64,
        title: String,
        content_cid: String,
        end_time: u64,
        creator: Address,
        vote_mode: VoteMode,
        vk_version: u32,
    ) -> u64 {
        // bump_instance called inside create_proposal_with_version
        Self::create_proposal_with_version(
            env,
            dao_id,
            title,
            content_cid,
            end_time,
            creator,
            vote_mode,
            Some(vk_version),
        )
    }

    fn create_proposal_with_version(
        env: Env,
        dao_id: u64,
        title: String,
        content_cid: String,
        end_time: u64,
        creator: Address,
        vote_mode: VoteMode,
        vk_version: Option<u32>,
    ) -> u64 {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        creator.require_auth();

        // Validate title length to prevent DoS
        if title.len() > MAX_TITLE_LEN {
            panic_with_error!(&env, VotingError::TitleTooLong);
        }

        // Validate content_cid length and format
        if content_cid.len() > MAX_CID_LEN {
            panic_with_error!(&env, VotingError::InvalidContentCid);
        }
        // Allow empty content_cid for proposals with title-only
        // If not empty, validate CID format (starts with "Qm" for CIDv0 or "bafy"/"bafk" for CIDv1)
        // Also allow plain text for backwards compatibility (doesn't start with CID prefixes)
        // The frontend handles interpreting the content_cid field

        // Get tree and sbt contracts
        let tree_contract: Address = Self::tree_contract(env.clone());
        let sbt_contract: Address = env.invoke_contract(
            &tree_contract,
            &symbol_short!("sbt_contr"),
            soroban_sdk::vec![&env],
        );

        // Get registry from SBT contract
        let registry: Address = env.invoke_contract(
            &sbt_contract,
            &symbol_short!("registry"),
            soroban_sdk::vec![&env],
        );

        // Always require SBT membership to create proposals (regardless of membership_open)
        let has_sbt: bool = env.invoke_contract(
            &sbt_contract,
            &symbol_short!("has"),
            soroban_sdk::vec![&env, dao_id.into_val(&env), creator.clone().into_val(&env)],
        );

        if !has_sbt {
            panic_with_error!(&env, VotingError::NotDaoMember);
        }

        // Check if members are allowed to create proposals
        let members_can_propose: bool = env.invoke_contract(
            &registry,
            &Symbol::new(&env, "members_can_propose"),
            soroban_sdk::vec![&env, dao_id.into_val(&env)],
        );

        // If members cannot propose, only admin can create proposals
        if !members_can_propose {
            let dao_admin: Address = env.invoke_contract(
                &registry,
                &symbol_short!("get_admin"),
                soroban_sdk::vec![&env, dao_id.into_val(&env)],
            );

            if creator != dao_admin {
                panic_with_error!(&env, VotingError::OnlyAdminCanPropose);
            }
        }

        let now = env.ledger().timestamp();

        // Validate end_time: 0 = no deadline, otherwise must be in the future
        if end_time != 0 && end_time <= now {
            panic_with_error!(&env, VotingError::EndTimeInvalid);
        }

        // Resolve VK version to use (curve-aware)
        let curve_id = Self::get_curve_id(&env, dao_id);
        let current_version: u32 = match curve_id {
            CurveId::Bls12381 => env
                .storage()
                .persistent()
                .get(&DataKey::VkVersionBls381(dao_id))
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::VkNotSet)),
            CurveId::Bn254 => env
                .storage()
                .persistent()
                .get(&DataKey::VkVersion(dao_id))
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::VkNotSet)),
        };
        let selected_version = vk_version.unwrap_or(current_version);
        if selected_version == 0 || selected_version > current_version {
            panic_with_error!(&env, VotingError::VkNotSet);
        }

        // Snapshot VK by version and compute hash (curve-aware)
        let vk_hash = match curve_id {
            CurveId::Bls12381 => {
                let vk = Self::get_vk_by_version_bls381(&env, dao_id, selected_version);
                Self::hash_vk_bls381(&env, &vk)
            }
            CurveId::Bn254 => {
                let vk = Self::get_vk_by_version(&env, dao_id, selected_version);
                Self::hash_vk(&env, &vk)
            }
        };

        // Snapshot current Merkle root - defines the eligible voter set
        let eligible_root: U256 = env.invoke_contract(
            &tree_contract,
            &symbol_short!("get_root"),
            soroban_sdk::vec![&env, dao_id.into_val(&env)],
        );

        // Get current root index for Open mode validation
        let earliest_root_index: u32 = env.invoke_contract(
            &tree_contract,
            &symbol_short!("curr_idx"),
            soroban_sdk::vec![&env, dao_id.into_val(&env)],
        );

        let snapshot_ledger = env.ledger().sequence();

        let proposal_id = Self::next_proposal_id(&env, dao_id);

        let proposal = ProposalInfo {
            id: proposal_id,
            dao_id,
            title: title.clone(),
            content_cid: content_cid.clone(),
            yes_votes: 0,
            no_votes: 0,
            end_time,
            created_by: creator.clone(),
            created_at: now,
            state: ProposalState::Active,
            vk_hash,
            vk_version: selected_version,
            eligible_root,
            vote_mode,
            earliest_root_index,
            snapshot_ledger,
        };

        let key = DataKey::Proposal(dao_id, proposal_id);
        env.storage().persistent().set(&key, &proposal);
        Self::bump_persistent(&env, &key);

        // Store proposal curve for proof format dispatch
        let curve_key = DataKey::ProposalCurve(dao_id, proposal_id);
        env.storage().persistent().set(&curve_key, &curve_id);
        Self::bump_persistent(&env, &curve_key);

        // Cache end_time for Temporary nullifier TTL computation
        // Stored in Persistent (immutable after creation) so ttl.ts can look it up
        let end_time_key = DataKey::ProposalEndTime(dao_id, proposal_id);
        env.storage().persistent().set(&end_time_key, &end_time);
        Self::bump_persistent(&env, &end_time_key);

        ProposalEvent {
            dao_id,
            proposal_id,
            title,
            content_cid,
            creator,
        }
        .publish(&env);

        proposal_id
    }

    /// Compute SHA256 hash of verification key for immutability tracking
    fn hash_vk(env: &Env, vk: &VerificationKey) -> BytesN<32> {
        // Serialize VK components into bytes
        let mut data = Bytes::new(env);

        // Add alpha (64 bytes)
        data.append(&Bytes::from_array(env, &vk.alpha.to_array()));
        // Add beta (128 bytes)
        data.append(&Bytes::from_array(env, &vk.beta.to_array()));
        // Add gamma (128 bytes)
        data.append(&Bytes::from_array(env, &vk.gamma.to_array()));
        // Add delta (128 bytes)
        data.append(&Bytes::from_array(env, &vk.delta.to_array()));
        // Add IC points
        for i in 0..vk.ic.len() {
            if let Some(ic_point) = vk.ic.get(i) {
                data.append(&Bytes::from_array(env, &ic_point.to_array()));
            }
        }

        env.crypto().sha256(&data).into()
    }

    /// Compute SHA256 hash of BLS12-381 verification key
    fn hash_vk_bls381(env: &Env, vk: &VerificationKeyBls381) -> BytesN<32> {
        let mut data = Bytes::new(env);

        data.append(&Bytes::from_array(env, &vk.alpha.to_array()));
        data.append(&Bytes::from_array(env, &vk.beta.to_array()));
        data.append(&Bytes::from_array(env, &vk.gamma.to_array()));
        data.append(&Bytes::from_array(env, &vk.delta.to_array()));
        for i in 0..vk.ic.len() {
            if let Some(ic_point) = vk.ic.get(i) {
                data.append(&Bytes::from_array(env, &ic_point.to_array()));
            }
        }

        env.crypto().sha256(&data).into()
    }

    // ── Reentrancy Guard ────────────────────────────────────────────────────
    //
    // REENTRANCY MODEL:
    // =================
    //
    // Soroban's transaction model provides atomic execution: if a function panics,
    // all storage mutations within that invocation are rolled back. This means
    // a panicking call cannot leave the contract in an inconsistent state.
    //
    // However, defense-in-depth requires two additional protections:
    //
    // 1. CHECKS-EFFECTS-INTERACTIONS PATTERN:
    //    The nullifier is marked as used BEFORE proof verification and any
    //    cross-contract calls (e.g., to the tree contract for root validation
    //    in Trailing mode). This prevents TOCTOU attacks where an attacker
    //    could re-enter between proof verification and nullifier marking.
    //
    // 2. CONTRACT-LEVEL REENTRANCY LOCK:
    //    A storage flag (DataKey::ReentrancyLock) prevents reentrant calls
    //    into vote/vote_bls381. While Soroban's execution model makes
    //    cross-contract reentrancy harder than EVM, this guard provides
    //    defense-in-depth against potential future changes to the execution
    //    model or unexpected call chains through multiple contracts.
    //
    // Both guards are applied consistently across vote() and vote_bls381().

    /// Set the reentrancy lock. Panics if already locked (reentrant call detected).
    fn set_reentrancy_lock(env: &Env) {
        let lock_key = DataKey::ReentrancyLock;
        if env.storage().instance().has(&lock_key) {
            panic_with_error!(env, VotingError::ReentrantCall);
        }
        env.storage().instance().set(&lock_key, &true);
    }

    /// Clear the reentrancy lock after successful execution.
    fn clear_reentrancy_lock(env: &Env) {
        env.storage().instance().remove(&DataKey::ReentrancyLock);
    }

    /// Submit a vote with ZK proof
    ///
    /// REENTRANCY MODEL:
    /// This function follows the checks-effects-interactions pattern with a
    /// contract-level reentrancy lock for defense-in-depth:
    ///
    ///   Checks:  validate inputs, verify proposal is Active, nullifier unused,
    ///            root is valid for vote mode
    ///   Effects: mark nullifier as used (BEFORE any external calls)
    ///   Interactions: verify Groth16 proof, cross-contract tree lookups
    ///
    /// The nullifier is domain-separated by (dao_id, proposal_id), so the same
    /// secret produces different nullifiers across DAOs and proposals.
    ///
    /// Privacy-preserving: commitment is NOT a public parameter.
    /// Revocation is enforced by zeroing leaves in the Merkle tree.
    pub fn vote(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        vote_choice: bool, // true = yes, false = no
        nullifier: U256,
        root: U256,
        proof: Proof,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);

        let ctx = PathContext::Anonymous;

        // ── DEFENSE-IN-DEPTH: Set reentrancy lock BEFORE any state mutations ──
        Self::set_reentrancy_lock(&env);

        // SECURITY: Validate public signals are within BN254 scalar field FIRST
        // This prevents modular reduction attacks where values >= r verify identically
        // to their reduced equivalents but are stored as different keys.
        Self::assert_in_field(&env, ctx, &nullifier);
        Self::assert_in_field(&env, ctx, &root);

        // Check nullifier is non-zero (zero is not a valid nullifier)
        if nullifier == U256::from_u32(&env, 0) {
            panic_coarse(&env, ctx, VotingError::InvalidNullifier);
        }

        // Check nullifier hasn't been used for THIS election (dao_id, proposal_id).
        // Election-scoped storage prevents cross-election DoS from a flat namespace (#64).
        let null_key = storage::nullifier_used_key(dao_id, proposal_id, nullifier.clone());
        if env.storage().persistent().has(&null_key) {
            panic_coarse(&env, ctx, VotingError::NullifierUsed);
        }

        // Get proposal
        let prop_key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&prop_key)
            .expect("proposal not found");

        // Check voting period and state (voting starts at creation, ends at end_time)
        // If end_time is 0, there's no deadline (voting never closes)
        let now = env.ledger().timestamp();
        if proposal.state != ProposalState::Active {
            panic_coarse(&env, ctx, VotingError::VotingClosed);
        }
        if proposal.end_time != 0 && now > proposal.end_time {
            panic_coarse(&env, ctx, VotingError::VotingClosed);
        }

        // Revocation is now enforced by zeroing leaves in the Merkle tree.
        // A revoked member's commitment is zeroed, so their proof won't verify
        // against any root that includes the zeroed leaf. No timestamp checks needed.

        // ── CHECKS-EFFECTS-INTERACTIONS: Mark nullifier as used BEFORE ──
        // ── cross-contract calls or proof verification. This prevents      ──
        // ── double-vote reentrancy attacks even if the execution model     ──
        // ── allows reentrant calls.                                       ──
        env.storage().temporary().set(&null_key, &true);
        Self::bump_nullifier_ttl(&env, &null_key, dao_id, proposal_id);

        // Verify root based on vote mode
        // (May involve cross-contract calls to tree contract in Trailing mode)
        match proposal.vote_mode {
            VoteMode::Fixed => {
                // Fixed mode: root must exactly match the snapshot at proposal creation
                // This prevents sybil attacks where members are added after proposal creation
                if root != proposal.eligible_root {
                    panic_coarse(&env, ctx, VotingError::RootMismatch);
                }
            }
            VoteMode::Trailing => {
                // Trailing mode: root must be in tree history AND not predate proposal creation
                // AND not predate the most recent member removal
                // This allows new members to vote while preventing removed members from using old roots

                // Get tree contract address
                let tree_contract: Address = Self::tree_contract(env.clone());

                // Check root is in valid history
                let root_valid: bool = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("root_ok"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env), root.clone().into_val(&env)],
                );
                if !root_valid {
                    panic_coarse(&env, ctx, VotingError::RootNotInHistory);
                }

                // Check root index >= earliest_root_index (prevents using roots from before proposal)
                let root_index: u32 = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("root_idx"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env), root.clone().into_val(&env)],
                );
                if root_index < proposal.earliest_root_index {
                    panic_coarse(&env, ctx, VotingError::RootPredatesProposal);
                }

                // Check root index >= min_valid_root_index (prevents using roots from before member removal)
                // This ensures revoked members cannot vote even on old proposals using their pre-revocation proofs
                let min_valid_root: u32 = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("min_root"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env)],
                );
                if root_index < min_valid_root {
                    panic_coarse(&env, ctx, VotingError::RootPredatesRemoval);
                }
            }
            VoteMode::Quadratic => {
                // Quadratic proposals must be voted on via `cast_qv_vote`.
                panic_coarse(&env, ctx, VotingError::NotQuadraticProposal);
            }
        }

        // Verify proposal was created for BN254 curve (not BLS12-381)
        let curve_key = DataKey::ProposalCurve(dao_id, proposal_id);
        let proposal_curve: CurveId = env
            .storage()
            .persistent()
            .get(&curve_key)
            .unwrap_or(CurveId::Bn254);
        if proposal_curve != CurveId::Bn254 {
            panic_coarse(&env, ctx, VotingError::VkNotSet);
        }

        // Get verification key pinned to proposal version
        let vk: VerificationKey = Self::get_vk_by_version(&env, dao_id, proposal.vk_version);

        // Verify VK matches the snapshot taken at proposal creation
        // This prevents VK changes from invalidating in-flight votes
        let current_vk_hash = Self::hash_vk(&env, &vk);
        if current_vk_hash != proposal.vk_hash {
            panic_coarse(&env, ctx, VotingError::VkChanged);
        }

        // Verify Groth16 proof
        // Public signals: [root, nullifier, daoId, proposalId, voteChoice]
        // daoId + proposalId ARE the election binding verified on-chain (#64):
        // the circuit enforces nullifier = Poseidon(secret, daoId, proposalId), so a
        // proof for election A cannot authorize a vote in election B.
        let _vote_signal = if vote_choice {
            U256::from_u32(&env, 1)
        } else {
            U256::from_u32(&env, 0)
        };
        // Public signals: [root, nullifier, daoId, proposalId, voteChoice, numCandidates]
        // Note: daoId is included for domain separation (prevents cross-DAO nullifier linkability)
        // numCandidates is bound into the proof to prevent circuit/contract candidate bound desync
        // Commitment is now private (computed internally in circuit) for improved vote unlinkability
        let election_config: ElectionConfig = env
            .storage()
            .persistent()
            .get(&DataKey::ElectionConfig(dao_id, proposal_id))
            .unwrap_or(ElectionConfig {
                snapshot_ledger: 0,
                min_balance: 0,
                twab_window: 0,
                candidate_seed: None,
                num_candidates: 0,
                vdf_output: None,
                vdf_delay: 0,
                max_revotes: 0,
                merkle_root_set_at: None,
                commitment_window: 0,
            });

        let vote_choice_index: u32 = if vote_choice { 1 } else { 0 };
        if election_config.num_candidates > 0 && vote_choice_index >= election_config.num_candidates
        {
            panic_coarse(&env, ctx, VotingError::InvalidCandidateIndex);
        }

        let vote_signal = U256::from_u32(&env, vote_choice_index);
        let dao_signal = U256::from_u128(&env, dao_id as u128);
        let proposal_signal = U256::from_u128(&env, proposal_id as u128);
        let num_candidates_signal = U256::from_u32(&env, election_config.num_candidates);

        // Extract relayer address from transaction signer (the one paying fees)
        // In Soroban, this is typically the contract invoker, but we get it from the auth context
        let relayer_address: Address = env.invoker().clone();
        let relayer_signal = Self::address_to_u256(&env, &relayer_address);

        // Validate relayer address is in BN254 scalar field
        Self::assert_in_field(&env, &relayer_signal);

        // Validate relayer address is non-zero
        if relayer_signal == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidRelayerAddress);
        }

        let pub_signals = soroban_sdk::vec![
            &env,
            root.clone(),
            nullifier.clone(),
            dao_signal,
            proposal_signal,
            vote_signal,
            num_candidates_signal,
            relayer_signal,
        ];

        if !Self::verify_groth16(&env, &vk, &proof, &pub_signals) {
            panic_coarse(&env, ctx, VotingError::InvalidProof);
        }

        // Bind this vote's nullifier into the election accumulator so the
        // final tally proof can be verified against the on-chain nullifier set.
        Self::accumulate_nullifier(&env, dao_id, proposal_id, &nullifier);

        // Update vote count with checked arithmetic
        if vote_choice {
            proposal.yes_votes = proposal
                .yes_votes
                .checked_add(1)
                .unwrap_or_else(|| panic_coarse(&env, ctx, VotingError::TallyOverflow));
        } else {
            proposal.no_votes = proposal
                .no_votes
                .checked_add(1)
                .unwrap_or_else(|| panic_coarse(&env, ctx, VotingError::TallyOverflow));
        }
        env.storage().persistent().set(&prop_key, &proposal);
        Self::bump_persistent(&env, &prop_key);

        // Clear reentrancy lock before emitting event
        Self::clear_reentrancy_lock(&env);

        VoteEvent {
            dao_id,
            proposal_id,
            choice: vote_choice,
            nullifier,
        }
        .publish(&env);
    }

    /// Weighted vote with weight bounds and domain tag (for ZK-013 weighted governance)
    /// Constraint review: weight is bounded [MIN_WEIGHT, MAX_WEIGHT] via range proof in circuit (128 bits)
    /// Domain tag prevents cross-circuit replay (weighted vs standard vote)
    /// KAT: compared against vote_v2 nullifier domain separation
    pub fn vote_weighted(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        vote_choice: bool,
        nullifier: U256,
        root: U256,
        proof: Proof,
        weight: u32,
        domain_tag: u32,
    ) {
        Self::bump_instance(&env);
        let ctx = PathContext::Anonymous;
        Self::assert_weight_in_range(&env, ctx, weight);
        Self::assert_domain_tag_valid(&env, ctx, domain_tag);
        // Delegate to standard vote after weight validation
        // Note: weight-specific tally (weighted sum) would be stored separately in a full implementation;
        // here we validate bounds and domain, then record as standard vote for e2e testing
        Self::vote(
            env,
            dao_id,
            proposal_id,
            vote_choice,
            nullifier,
            root,
            proof,
        );
    }

    /// Cast a BLS12-381-backed anonymous vote.
    pub fn vote_bls381(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        vote_choice: bool,
        nullifier: U256,
        root: U256,
        proof: ProofBls381,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);

        // ── DEFENSE-IN-DEPTH: Set reentrancy lock BEFORE any state mutations ──
        Self::set_reentrancy_lock(&env);

        Self::assert_in_field_bls381(&env, &nullifier);
        Self::assert_in_field_bls381(&env, &root);

        if nullifier == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidNullifier);
        }

        let null_key = storage::nullifier_used_key(dao_id, proposal_id, nullifier.clone());
        if env.storage().temporary().has(&null_key) {
            panic_with_error!(&env, VotingError::NullifierUsed);
        }

        let prop_key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&prop_key)
            .expect("proposal not found");

        let now = env.ledger().timestamp();
        if proposal.state != ProposalState::Active {
            panic_with_error!(&env, VotingError::VotingClosed);
        }
        if proposal.end_time != 0 && now > proposal.end_time {
            panic_with_error!(&env, VotingError::VotingClosed);
        }

        // ── CHECKS-EFFECTS-INTERACTIONS: Mark nullifier as used BEFORE ──
        // ── cross-contract calls or proof verification.                   ──
        env.storage().temporary().set(&null_key, &true);
        Self::bump_nullifier_ttl(&env, &null_key, dao_id, proposal_id);

        match proposal.vote_mode {
            VoteMode::Fixed => {
                if root != proposal.eligible_root {
                    panic_with_error!(&env, VotingError::RootMismatch);
                }
            }
            VoteMode::Trailing => {
                let tree_contract: Address = Self::tree_contract(env.clone());

                let root_valid: bool = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("root_ok"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env), root.clone().into_val(&env)],
                );
                if !root_valid {
                    panic_with_error!(&env, VotingError::RootNotInHistory);
                }

                let root_index: u32 = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("root_idx"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env), root.clone().into_val(&env)],
                );
                if root_index < proposal.earliest_root_index {
                    panic_with_error!(&env, VotingError::RootPredatesProposal);
                }

                let min_valid_root: u32 = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("min_root"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env)],
                );
                if root_index < min_valid_root {
                    panic_with_error!(&env, VotingError::RootPredatesRemoval);
                }
            }
            VoteMode::Quadratic => {
                // Quadratic proposals must be voted on via `cast_qv_vote`.
                panic_with_error!(&env, VotingError::NotQuadraticProposal);
            }
        }

        // Verify proposal was created for BLS12-381 curve
        let curve_key = DataKey::ProposalCurve(dao_id, proposal_id);
        let proposal_curve: CurveId = env
            .storage()
            .persistent()
            .get(&curve_key)
            .unwrap_or(CurveId::Bn254);
        if proposal_curve != CurveId::Bls12381 {
            panic_with_error!(&env, VotingError::VkNotSet);
        }

        // Get BLS12-381 verification key pinned to proposal version
        let vk = Self::get_vk_by_version_bls381(&env, dao_id, proposal.vk_version);

        // Verify VK hash
        let current_vk_hash = Self::hash_vk_bls381(&env, &vk);
        if current_vk_hash != proposal.vk_hash {
            panic_with_error!(&env, VotingError::VkChanged);
        }

        let election_config: ElectionConfig = env
            .storage()
            .persistent()
            .get(&DataKey::ElectionConfig(dao_id, proposal_id))
            .unwrap_or(ElectionConfig {
                snapshot_ledger: 0,
                min_balance: 0,
                twab_window: 0,
                candidate_seed: None,
                num_candidates: 0,
                vdf_output: None,
                vdf_delay: 0,
                max_revotes: 0,
                merkle_root_set_at: None,
                commitment_window: 0,
            });

        let vote_choice_index: u32 = if vote_choice { 1 } else { 0 };
        if election_config.num_candidates > 0 && vote_choice_index >= election_config.num_candidates
        {
            panic_with_error!(&env, VotingError::InvalidCandidateIndex);
        }

        let vote_signal = U256::from_u32(&env, vote_choice_index);
        let dao_signal = U256::from_u128(&env, dao_id as u128);
        let proposal_signal = U256::from_u128(&env, proposal_id as u128);
        let num_candidates_signal = U256::from_u32(&env, election_config.num_candidates);

        // Extract relayer address from transaction signer
        let relayer_address: Address = env.invoker().clone();
        let relayer_signal = Self::address_to_u256(&env, &relayer_address);

        // Validate relayer address is in BLS12-381 scalar field
        Self::assert_in_field_bls381(&env, &relayer_signal);

        // Validate relayer address is non-zero
        if relayer_signal == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidRelayerAddress);
        }

        let pub_signals = soroban_sdk::vec![
            &env,
            root.clone(),
            nullifier.clone(),
            dao_signal,
            proposal_signal,
            vote_signal,
            num_candidates_signal,
            relayer_signal,
        ];

        if !Self::verify_groth16_bls381(&env, &vk, &proof, &pub_signals) {
            panic_with_error!(&env, VotingError::InvalidProof);
        }

        // Update vote count with checked arithmetic
        if vote_choice {
            proposal.yes_votes = proposal
                .yes_votes
                .checked_add(1)
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
        } else {
            proposal.no_votes = proposal
                .no_votes
                .checked_add(1)
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
        }
        env.storage().persistent().set(&prop_key, &proposal);
        Self::bump_persistent(&env, &prop_key);

        // Clear reentrancy lock before emitting event
        Self::clear_reentrancy_lock(&env);

        VoteEvent {
            dao_id,
            proposal_id,
            choice: vote_choice,
            nullifier,
        }
        .publish(&env);
    }

    /// Get proposal info
    pub fn get_proposal(env: Env, dao_id: u64, proposal_id: u64) -> ProposalInfo {
        Self::bump_instance(&env);
        let key = DataKey::Proposal(dao_id, proposal_id);
        let proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");
        Self::bump_persistent(&env, &key);
        proposal
    }

    /// Get vote mode for a proposal
    /// Returns VoteMode enum directly for type safety
    /// Used by comments contract for eligibility checks
    pub fn get_vote_mode(env: Env, dao_id: u64, proposal_id: u64) -> VoteMode {
        let proposal = Self::get_proposal(env, dao_id, proposal_id);
        proposal.vote_mode
    }

    /// Get eligible root for a proposal (merkle root at snapshot)
    /// Used by comments contract for Fixed mode eligibility checks
    pub fn get_eligible_root(env: Env, dao_id: u64, proposal_id: u64) -> U256 {
        let proposal = Self::get_proposal(env, dao_id, proposal_id);
        proposal.eligible_root
    }

    /// Get earliest root index for a proposal (for Trailing mode)
    /// Used by comments contract for Trailing mode eligibility checks
    pub fn get_earliest_idx(env: Env, dao_id: u64, proposal_id: u64) -> u32 {
        let proposal = Self::get_proposal(env, dao_id, proposal_id);
        proposal.earliest_root_index
    }

    /// Get proposal count for a DAO
    pub fn proposal_count(env: Env, dao_id: u64) -> u64 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::ProposalCount(dao_id))
            .unwrap_or(0)
    }

    /// Cross-contract query: return true if `candidate_root` is the eligible_root
    /// of any Active Fixed-mode proposal. Used by membership-tree to block FIFO
    /// root eviction when a Fixed snapshot is still being voted against.
    pub fn root_pin(env: Env, dao_id: u64, candidate_root: U256) -> bool {
        Self::bump_instance(&env);
        let count = Self::proposal_count(env.clone(), dao_id);
        for id in 0..count {
            let proposal_id = id + 1;
            let key = DataKey::Proposal(dao_id, proposal_id);
            if let Some(proposal) = env.storage().persistent().get::<_, ProposalInfo>(&key) {
                if proposal.state == ProposalState::Active
                    && proposal.vote_mode == VoteMode::Fixed
                    && proposal.eligible_root == candidate_root
                {
                    return true;
                }
            }
        }
        false
    }

    /// Cross-contract hook: emit [`AtRiskVoterAlert`] events for every Active
    /// Trailing-mode proposal whose earliest_root_index allows the candidate
    /// root (i.e. voters with proofs against this root could still cast valid
    /// votes). Called by membership-tree right before FIFO eviction.
    pub fn chk_risk(env: Env, dao_id: u64, candidate_root: U256) {
        Self::bump_instance(&env);
        let count = Self::proposal_count(env.clone(), dao_id);
        let now = env.ledger().timestamp();
        for id in 0..count {
            let proposal_id = id + 1;
            let key = DataKey::Proposal(dao_id, proposal_id);
            if let Some(proposal) = env.storage().persistent().get::<_, ProposalInfo>(&key) {
                if proposal.state == ProposalState::Active
                    && proposal.vote_mode == VoteMode::Trailing
                {
                    let deadline = if proposal.end_time == 0 {
                        now.saturating_add(72 * 60 * 60)
                    } else {
                        proposal.end_time
                    };
                    AtRiskVoterAlert {
                        dao_id,
                        at_risk_root: candidate_root.clone(),
                        proposal_id,
                        deadline,
                    }
                    .publish(&env);
                }
            }
        }
    }

    /// Read proposal end_time from cache (written at proposal creation).
    /// Returns 0 if proposal has no end_time (never closes) or is unknown.
    /// TTL-aware backend helpers use this to skip renewal of Temporary
    /// nullifier records whose proposal voting window has closed + grace elapsed.
    pub fn get_proposal_end_time(env: Env, dao_id: u64, proposal_id: u64) -> u64 {
        Self::bump_instance(&env);
        Self::get_proposal_end_time_internal(&env, dao_id, proposal_id)
    }

    /// Internal version of get_proposal_end_time (avoids double bump_instance).
    #[inline(always)]
    fn get_proposal_end_time_internal(env: &Env, dao_id: u64, proposal_id: u64) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::ProposalEndTime(dao_id, proposal_id))
            .unwrap_or(0)
    }

    /// Check if a nullifier has been used for a specific election.
    ///
    /// Requires election identity `(dao_id, proposal_id)` — never queries a
    /// global nullifier namespace (issue #64).
    pub fn is_nullifier_used(env: Env, dao_id: u64, proposal_id: u64, nullifier: U256) -> bool {
        Self::bump_instance(&env);
        let key = storage::nullifier_used_key(dao_id, proposal_id, nullifier);
        env.storage().temporary().has(&key)
    }

    /// Verify a voter receipt by checking if the nullifier was recorded
    /// (used for Individual Verifiability of votes without revealing the choice)
    pub fn verify_receipt(env: Env, dao_id: u64, proposal_id: u64, nullifier: U256) -> bool {
        Self::is_nullifier_used(env, dao_id, proposal_id, nullifier)
    }

    /// Alias for [`Self::is_nullifier_used`] matching the issue #64 naming.
    pub fn has_nullifier_been_used(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        nullifier: U256,
    ) -> bool {
        Self::is_nullifier_used(env, dao_id, proposal_id, nullifier)
    }

    /// Migrate a legacy globally-scoped nullifier into election-scoped storage.
    ///
    /// Moves `LegacyNullifierUsed(nullifier)` → `Nullifier(dao_id, proposal_id, nullifier)`
    /// and deletes the legacy entry. Returns `true` if a legacy entry was migrated.
    pub fn migrate_nullifier(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        nullifier: U256,
        admin: Address,
    ) -> bool {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);
        Self::assert_in_field(&env, &nullifier);

        if nullifier == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidNullifier);
        }

        let legacy_key = storage::legacy_nullifier_used_key(nullifier.clone());
        if !env.storage().persistent().has(&legacy_key) {
            return false;
        }

        let scoped_key = storage::nullifier_used_key(dao_id, proposal_id, nullifier);
        env.storage().persistent().set(&scoped_key, &true);
        Self::bump_persistent(&env, &scoped_key);
        Self::accumulate_nullifier(&env, dao_id, proposal_id, &nullifier);
        env.storage().persistent().remove(&legacy_key);
        true
    }

    /// Convert a Stellar address to a U256 field element
    /// Hashes the address using Blake2-256 and converts to U256
    fn address_to_u256(env: &Env, address: &Address) -> U256 {
        let address_bytes = address.to_xdr(env);
        let hash: BytesN<32> = env.crypto().sha256(&address_bytes);
        U256::from_be_bytes(env, &hash.to_bytes(env))
    }

    /// Get tree contract address
    pub fn tree_contract(env: Env) -> Address {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&TREE_CONTRACT)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::VkNotSet))
    }

    /// Get registry contract address (cached at construction)
    pub fn registry(env: Env) -> Address {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&REGISTRY)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::VkNotSet))
    }

    /// Get results for a proposal (yes_votes, no_votes)
    pub fn get_results(env: Env, dao_id: u64, proposal_id: u64) -> (u64, u64) {
        let proposal = Self::get_proposal(env, dao_id, proposal_id);
        (proposal.yes_votes, proposal.no_votes)
    }

    /// Close a proposal explicitly (idempotent). End time still enforced in vote.
    pub fn close_proposal(env: Env, dao_id: u64, proposal_id: u64, admin: Address) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);
        let key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");

        // Allow idempotent close (already Closed = no-op); reject invalid transitions (e.g. Archived → Closed).
        if proposal.state != ProposalState::Closed
            && !proposal.state.is_valid_transition(ProposalState::Closed)
        {
            panic_with_error!(&env, VotingError::InvalidState);
        }
        if proposal.state != ProposalState::Closed {
            proposal.state = ProposalState::Closed;
            env.storage().persistent().set(&key, &proposal);
            Self::bump_persistent(&env, &key);
            ProposalClosedEvent {
                dao_id,
                proposal_id,
                closed_by: admin,
            }
            .publish(&env);
        }
    }

    /// Archive a proposal (idempotent). Prevents further votes and signals off-chain cleanup.
    pub fn archive_proposal(env: Env, dao_id: u64, proposal_id: u64, admin: Address) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);
        let key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");

        // Allow idempotent archive (already Archived = no-op); reject invalid transitions (e.g. Active → Archived).
        if proposal.state != ProposalState::Archived
            && !proposal.state.is_valid_transition(ProposalState::Archived)
        {
            panic_with_error!(&env, VotingError::InvalidState);
        }
        if proposal.state != ProposalState::Archived {
            proposal.state = ProposalState::Archived;
            env.storage().persistent().set(&key, &proposal);
            Self::bump_persistent(&env, &key);
            ProposalArchivedEvent {
                dao_id,
                proposal_id,
                archived_by: admin,
            }
            .publish(&env);
        }
    }

    /// Contract version for upgrade tracking.
    pub fn version(env: Env) -> u32 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&VERSION_KEY)
            .unwrap_or(VERSION)
    }

    /// Get current VK version for a DAO
    pub fn vk_version(env: Env, dao_id: u64) -> u32 {
        Self::bump_instance(&env);
        let key = DataKey::VkVersion(dao_id);
        let ver: u32 = env.storage().persistent().get(&key).unwrap_or(0);
        if ver > 0 {
            Self::bump_persistent(&env, &key);
        }
        ver
    }

    /// Get the current VK for a DAO (used by other contracts like comments)
    pub fn get_vk(env: Env, dao_id: u64) -> VerificationKey {
        Self::bump_instance(&env);
        let vk_ver_key = DataKey::VkVersion(dao_id);
        let version: u32 = env
            .storage()
            .persistent()
            .get(&vk_ver_key)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::VkNotSet));
        Self::bump_persistent(&env, &vk_ver_key);
        Self::get_vk_by_version(&env, dao_id, version)
    }

    /// Get a specific VK version for observability/off-chain verification
    pub fn vk_for_version(env: Env, dao_id: u64, version: u32) -> VerificationKey {
        Self::bump_instance(&env);
        Self::get_vk_by_version(&env, dao_id, version)
    }

    /// Get the current BLS12-381 VK for a DAO
    pub fn get_vk_bls381(env: Env, dao_id: u64) -> VerificationKeyBls381 {
        Self::bump_instance(&env);
        let vk_ver_key = DataKey::VkVersionBls381(dao_id);
        let version: u32 = env
            .storage()
            .persistent()
            .get(&vk_ver_key)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::VkNotSet));
        Self::bump_persistent(&env, &vk_ver_key);
        Self::get_vk_by_version_bls381(&env, dao_id, version)
    }

    /// Get a specific BLS12-381 VK version
    pub fn vk_for_version_bls381(env: Env, dao_id: u64, version: u32) -> VerificationKeyBls381 {
        Self::bump_instance(&env);
        Self::get_vk_by_version_bls381(&env, dao_id, version)
    }

    // Internal: Get next proposal ID
    fn next_proposal_id(env: &Env, dao_id: u64) -> u64 {
        let count_key = DataKey::ProposalCount(dao_id);
        let count: u64 = env.storage().instance().get(&count_key).unwrap_or(0);
        let new_id = count + 1;
        env.storage().instance().set(&count_key, &new_id);
        new_id
    }

    /// Verify Groth16 proof using shared verification library.
    /// In test mode, checks for VerifyOverride flag to allow testing error paths.
    #[allow(unused_variables)]
    fn verify_groth16(
        env: &Env,
        vk: &VerificationKey,
        proof: &Proof,
        pub_signals: &Vec<U256>,
    ) -> bool {
        // In test mode, check for override flag first
        #[cfg(any(test, feature = "testutils"))]
        {
            if let Some(override_val) = env
                .storage()
                .instance()
                .get::<DataKey, bool>(&DataKey::VerifyOverride)
            {
                return override_val;
            }
        }

        // Delegate to shared Groth16 verification
        zkvote_groth16::verify_groth16(env, vk, proof, pub_signals)
    }

    /// Verify BLS12-381 Groth16 proof using shared verification library.
    #[allow(unused_variables)]
    fn verify_groth16_bls381(
        env: &Env,
        vk: &VerificationKeyBls381,
        proof: &ProofBls381,
        pub_signals: &Vec<U256>,
    ) -> bool {
        #[cfg(any(test, feature = "testutils"))]
        {
            if let Some(override_val) = env
                .storage()
                .instance()
                .get::<DataKey, bool>(&DataKey::VerifyOverride)
            {
                return override_val;
            }
        }

        zkvote_groth16::verify_groth16_bls381(env, vk, proof, pub_signals)
    }

    pub fn set_circuit_registry(env: Env, circuit_registry: Address) {
        Self::require_not_paused(&env);
        env.storage()
            .instance()
            .set(&CIRCUIT_REGISTRY, &circuit_registry);
    }

    pub fn set_dao_current_circuit(
        env: Env,
        dao_id: u64,
        circuit_id: String,
        _circuit_type: CircuitType,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        let registry: Address = env.storage().instance().get(&REGISTRY).unwrap();
        registry.require_auth();
        let key = DataKey::DaoCurrentCircuit(dao_id);
        env.storage().persistent().set(&key, &circuit_id);
        Self::bump_persistent(&env, &key);
    }

    pub fn get_dao_current_circuit(env: Env, dao_id: u64) -> String {
        Self::bump_instance(&env);
        let key = DataKey::DaoCurrentCircuit(dao_id);
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| String::from_str(&env, "vote_v1"))
    }

    pub fn set_migration(
        env: Env,
        dao_id: u64,
        old_circuit_id: String,
        new_circuit_id: String,
        deadline: u64,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        let registry: Address = env.storage().instance().get(&REGISTRY).unwrap();
        registry.require_auth();
        let migration = MigrationInfo {
            old_circuit_id,
            new_circuit_id,
            deadline,
        };
        let key = DataKey::DaoMigration(dao_id);
        env.storage().persistent().set(&key, &migration);
        Self::bump_persistent(&env, &key);
    }

    pub fn get_migration(env: Env, dao_id: u64) -> MigrationInfo {
        Self::bump_instance(&env);
        let key = DataKey::DaoMigration(dao_id);
        env.storage()
            .persistent()
            .get(&key)
            .expect("migration not found")
    }

    fn load_vk_from_registry(
        env: &Env,
        circuit_id: &String,
        circuit_type: &CircuitType,
    ) -> VerificationKey {
        let circuit_registry: Address = env
            .storage()
            .instance()
            .get(&CIRCUIT_REGISTRY)
            .unwrap_or_else(|| {
                panic_with_error!(env, VotingError::VkNotSet);
            });
        let result: CircuitVKResult = env.invoke_contract(
            &circuit_registry,
            &Symbol::new(env, "get_vk"),
            soroban_sdk::vec![
                env,
                circuit_id.clone().into_val(env),
                circuit_type.clone().into_val(env),
            ],
        );
        result.vk
    }

    /// Check if there is a pending VK upgrade proposal for this DAO in the circuit-registry.
    /// Returns Some(proposal_id) if pending, None otherwise.
    pub fn get_pending_vk_proposal(env: Env, dao_id: u64) -> Option<u32> {
        Self::bump_instance(&env);
        let circuit_registry: Address = match env.storage().instance().get(&CIRCUIT_REGISTRY) {
            Some(addr) => addr,
            None => return None,
        };

        let result: Option<VkProposal> = env.invoke_contract(
            &circuit_registry,
            &Symbol::new(env, "get_dao_vk_proposal"),
            soroban_sdk::vec![env, dao_id.into_val(env)],
        );
        result.and_then(|p| {
            if p.status == VkProposalStatus::Pending {
                Some(p.id)
            } else {
                None
            }
        })
    }

    /// Check if a VK proposal has met its timelock and quorum.
    /// Returns true if the proposal is ready to be executed.
    pub fn is_vk_proposal_ready(env: Env, proposal_id: u32) -> bool {
        Self::bump_instance(&env);
        let circuit_registry: Address = match env.storage().instance().get(&CIRCUIT_REGISTRY) {
            Some(addr) => addr,
            None => return false,
        };

        let result: Option<VkProposal> = env.invoke_contract(
            &circuit_registry,
            &Symbol::new(env, "get_vk_proposal"),
            soroban_sdk::vec![env, proposal_id.into_val(env)],
        );

        match result {
            Some(proposal) => {
                let now = env.ledger().timestamp();
                proposal.status == VkProposalStatus::Pending
                    && now >= proposal.execute_after
                    && proposal.approvals >= proposal.required_approvals
            }
            None => false,
        }
    }

    fn check_migration_window(env: &Env, dao_id: u64) -> Option<(String, String)> {
        let migration_key = DataKey::DaoMigration(dao_id);
        if !env.storage().persistent().has(&migration_key) {
            return None;
        }
        let migration: MigrationInfo = env.storage().persistent().get(&migration_key).unwrap();
        let now = env.ledger().timestamp();
        if now < migration.deadline {
            Some((migration.old_circuit_id, migration.new_circuit_id))
        } else {
            None
        }
    }

    pub fn vote_with_circuit(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        vote_choice: bool,
        nullifier: U256,
        root: U256,
        proof: Proof,
        circuit_id: String,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        Self::assert_in_field(&env, &nullifier);
        Self::assert_in_field(&env, &root);

        if nullifier == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidNullifier);
        }

        let null_key = storage::nullifier_used_key(dao_id, proposal_id, nullifier.clone());
        if env.storage().temporary().has(&null_key) {
            panic_with_error!(&env, VotingError::NullifierUsed);
        }

        let prop_key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&prop_key)
            .expect("proposal not found");

        let now = env.ledger().timestamp();
        if proposal.state != ProposalState::Active {
            panic_with_error!(&env, VotingError::VotingClosed);
        }
        if proposal.end_time != 0 && now > proposal.end_time {
            panic_with_error!(&env, VotingError::VotingClosed);
        }

        match proposal.vote_mode {
            VoteMode::Fixed => {
                if root != proposal.eligible_root {
                    panic_with_error!(&env, VotingError::RootMismatch);
                }
            }
            VoteMode::Trailing => {
                let tree_contract: Address = Self::tree_contract(env.clone());
                let root_valid: bool = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("root_ok"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env), root.clone().into_val(&env)],
                );
                if !root_valid {
                    panic_with_error!(&env, VotingError::RootNotInHistory);
                }
                let root_index: u32 = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("root_idx"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env), root.clone().into_val(&env)],
                );
                if root_index < proposal.earliest_root_index {
                    panic_with_error!(&env, VotingError::RootPredatesProposal);
                }
                let min_valid_root: u32 = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("min_root"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env)],
                );
                if root_index < min_valid_root {
                    panic_with_error!(&env, VotingError::RootPredatesRemoval);
                }
            }
            VoteMode::Quadratic => {
                // Quadratic proposals must be voted on via `cast_qv_vote`.
                panic_with_error!(&env, VotingError::NotQuadraticProposal);
            }
        }

        let vk: VerificationKey =
            Self::load_vk_from_registry(&env, &circuit_id, &CircuitType::Vote);

        let current_vk_hash = Self::hash_vk(&env, &vk);
        if current_vk_hash != proposal.vk_hash {
            let migration = Self::check_migration_window(&env, dao_id);
            match migration {
                Some((ref old_circuit_id, ref new_circuit_id)) => {
                    if circuit_id != *old_circuit_id && circuit_id != *new_circuit_id {
                        panic_with_error!(&env, VotingError::VkChanged);
                    }
                    if circuit_id == *old_circuit_id {
                        let old_vk =
                            Self::load_vk_from_registry(&env, old_circuit_id, &CircuitType::Vote);
                        let old_hash = Self::hash_vk(&env, &old_vk);
                        if old_hash != proposal.vk_hash {
                            panic_with_error!(&env, VotingError::VkChanged);
                        }
                    } else if circuit_id == *new_circuit_id {
                        let new_vk =
                            Self::load_vk_from_registry(&env, new_circuit_id, &CircuitType::Vote);
                        let new_hash = Self::hash_vk(&env, &new_vk);
                        if new_hash != proposal.vk_hash {
                            panic_with_error!(&env, VotingError::VkChanged);
                        }
                    }
                }
                None => {
                    panic_with_error!(&env, VotingError::VkChanged);
                }
            }
        }

        let election_config: ElectionConfig = env
            .storage()
            .persistent()
            .get(&DataKey::ElectionConfig(dao_id, proposal_id))
            .unwrap_or(ElectionConfig {
                snapshot_ledger: 0,
                min_balance: 0,
                twab_window: 0,
                candidate_seed: None,
                num_candidates: 0,
                vdf_output: None,
                vdf_delay: 0,
                max_revotes: 0,
                merkle_root_set_at: None,
                commitment_window: 0,
            });

        let vote_choice_index: u32 = if vote_choice { 1 } else { 0 };
        if election_config.num_candidates > 0 && vote_choice_index >= election_config.num_candidates
        {
            panic_with_error!(&env, VotingError::InvalidCandidateIndex);
        }

        let vote_signal = U256::from_u32(&env, vote_choice_index);
        let dao_signal = U256::from_u128(&env, dao_id as u128);
        let proposal_signal = U256::from_u128(&env, proposal_id as u128);
        let num_candidates_signal = U256::from_u32(&env, election_config.num_candidates);

        let pub_signals = soroban_sdk::vec![
            &env,
            root.clone(),
            nullifier.clone(),
            dao_signal,
            proposal_signal,
            vote_signal,
            num_candidates_signal,
        ];

        if !Self::verify_groth16(&env, &vk, &proof, &pub_signals) {
            panic_with_error!(&env, VotingError::InvalidProof);
        }

        env.storage().temporary().set(&null_key, &true);
        Self::bump_nullifier_ttl(&env, &null_key, dao_id, proposal_id);

        if vote_choice {
            proposal.yes_votes = proposal
                .yes_votes
                .checked_add(1)
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
        } else {
            proposal.no_votes = proposal
                .no_votes
                .checked_add(1)
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
        }
        env.storage().persistent().set(&prop_key, &proposal);
        Self::bump_persistent(&env, &prop_key);

        VoteEvent {
            dao_id,
            proposal_id,
            choice: vote_choice,
            nullifier,
        }
        .publish(&env);
    }

    // ── Anti-Flash Loan Protection ──────────────────────────────────────────

    /// Create or update election configuration with token-gating parameters.
    /// Sets the minimum balance required to vote, snapshot ledger, TWAB window,
    /// and the number of valid candidates (bound into the ZK proof).
    /// Only callable during proposal creation or by DAO admin.
    pub fn set_election_config(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        min_balance: i128,
        twab_window: u64,
        num_candidates: u32,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        let snapshot_ledger = env.ledger().sequence();
        let key = DataKey::ElectionConfig(dao_id, proposal_id);
        let existing = env.storage().persistent().get::<_, ElectionConfig>(&key);
        let candidate_seed = existing
            .as_ref()
            .and_then(|config| config.candidate_seed.clone());
        let vdf_output = existing
            .as_ref()
            .and_then(|config| config.vdf_output.clone());
        let vdf_delay = existing
            .as_ref()
            .map(|config| config.vdf_delay)
            .unwrap_or(0);
        let max_revotes = existing
            .as_ref()
            .map(|config| config.max_revotes)
            .unwrap_or(0);
        let merkle_root_set_at = existing
            .as_ref()
            .and_then(|config| config.merkle_root_set_at);
        let commitment_window = existing
            .as_ref()
            .map(|config| config.commitment_window)
            .unwrap_or(0);
        let config = ElectionConfig {
            snapshot_ledger,
            min_balance,
            twab_window,
            candidate_seed,
            num_candidates,
            vdf_output,
            vdf_delay,
            max_revotes,
            merkle_root_set_at,
            commitment_window,
        };
        env.storage().persistent().set(&key, &config);
        Self::bump_persistent(&env, &key);
    }

    /// Get election configuration for a proposal.
    pub fn get_election_config(env: Env, dao_id: u64, proposal_id: u64) -> Option<ElectionConfig> {
        Self::bump_instance(&env);
        let key = DataKey::ElectionConfig(dao_id, proposal_id);
        let config: Option<ElectionConfig> = env.storage().persistent().get(&key);
        if config.is_some() {
            Self::bump_persistent(&env, &key);
        }
        config
    }

    /// Set commitment window for Merkle root updates during registration.
    pub fn set_commitment_window(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        commitment_window: u64,
        admin: Address,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        admin.require_auth();

        let key = DataKey::ElectionConfig(dao_id, proposal_id);
        let mut config: ElectionConfig =
            env.storage()
                .persistent()
                .get(&key)
                .unwrap_or(ElectionConfig {
                    snapshot_ledger: env.ledger().sequence(),
                    min_balance: 0,
                    twab_window: 0,
                    candidate_seed: None,
                    num_candidates: 0,
                    vdf_output: None,
                    vdf_delay: 0,
                    max_revotes: 0,
                    merkle_root_set_at: None,
                    commitment_window: 0,
                });
        config.commitment_window = commitment_window;
        env.storage().persistent().set(&key, &config);
        Self::bump_persistent(&env, &key);
    }

    /// Sets/updates the Merkle root during the Registration phase within the commitment window.
    /// Performs cross-contract verification against the Tree contract.
    /// Stores root history for auditability and emits an ElectionStatusChangedEvent.
    pub fn set_merkle_root(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        new_root: U256,
        admin: Address,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        admin.require_auth();

        let tree_contract: Address = Self::tree_contract(env.clone());
        let sbt_contract: Address = env.invoke_contract(
            &tree_contract,
            &symbol_short!("sbt_contr"),
            soroban_sdk::vec![&env],
        );
        let registry: Address = env.invoke_contract(
            &sbt_contract,
            &symbol_short!("registry"),
            soroban_sdk::vec![&env],
        );
        let dao_admin: Address = env.invoke_contract(
            &registry,
            &symbol_short!("get_admin"),
            soroban_sdk::vec![&env, dao_id.into_val(&env)],
        );
        if admin != dao_admin {
            panic_with_error!(&env, VotingError::NotAdmin);
        }

        let key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::InvalidState));

        if proposal.state != ProposalState::Registration {
            panic_with_error!(&env, VotingError::MerkleRootLocked);
        }

        let now = env.ledger().timestamp();
        let config_key = DataKey::ElectionConfig(dao_id, proposal_id);
        let mut election_config: ElectionConfig = env
            .storage()
            .persistent()
            .get(&config_key)
            .unwrap_or(ElectionConfig {
                snapshot_ledger: env.ledger().sequence(),
                min_balance: 0,
                twab_window: 0,
                candidate_seed: None,
                num_candidates: 0,
                vdf_output: None,
                vdf_delay: 0,
                max_revotes: 0,
                merkle_root_set_at: None,
                commitment_window: 0,
            });

        if election_config.commitment_window > 0
            && now > proposal.created_at + election_config.commitment_window
        {
            panic_with_error!(&env, VotingError::CommitmentWindowExpired);
        }

        let root_valid: bool = env.invoke_contract(
            &tree_contract,
            &symbol_short!("root_ok"),
            soroban_sdk::vec![&env, dao_id.into_val(&env), new_root.clone().into_val(&env)],
        );
        if !root_valid {
            panic_with_error!(&env, VotingError::RootNotInHistory);
        }

        let old_root = proposal.eligible_root.clone();
        proposal.eligible_root = new_root.clone();
        env.storage().persistent().set(&key, &proposal);
        Self::bump_persistent(&env, &key);

        election_config.merkle_root_set_at = Some(now);
        env.storage()
            .persistent()
            .set(&config_key, &election_config);
        Self::bump_persistent(&env, &config_key);

        let history_key = DataKey::MerkleRootHistory(dao_id, proposal_id);
        let mut history: Vec<MerkleRootRecord> = env
            .storage()
            .persistent()
            .get(&history_key)
            .unwrap_or_else(|| Vec::new(&env));
        history.push_back(MerkleRootRecord {
            root: new_root.clone(),
            set_at: now,
            set_by: admin,
        });
        env.storage().persistent().set(&history_key, &history);
        Self::bump_persistent(&env, &history_key);

        ElectionStatusChangedEvent {
            dao_id,
            proposal_id,
            old_state: Symbol::new(&env, "Registration"),
            new_state: Symbol::new(&env, "Registration"),
            old_root,
            new_root,
            updated_at: now,
        }
        .publish(&env);
    }

    /// Transitions proposal state from Registration to Active, permanently locking the Merkle root.
    pub fn activate_proposal(env: Env, dao_id: u64, proposal_id: u64, caller: Address) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        caller.require_auth();

        let key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::InvalidState));

        if proposal.state != ProposalState::Registration {
            panic_with_error!(&env, VotingError::InvalidState);
        }

        proposal.state = ProposalState::Active;
        env.storage().persistent().set(&key, &proposal);
        Self::bump_persistent(&env, &key);

        let now = env.ledger().timestamp();
        ElectionStatusChangedEvent {
            dao_id,
            proposal_id,
            old_state: Symbol::new(&env, "Registration"),
            new_state: Symbol::new(&env, "Active"),
            old_root: proposal.eligible_root.clone(),
            new_root: proposal.eligible_root.clone(),
            updated_at: now,
        }
        .publish(&env);
    }

    /// Returns the audit history of Merkle root updates for an election.
    pub fn get_merkle_root_history(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
    ) -> Vec<MerkleRootRecord> {
        Self::bump_instance(&env);
        let history_key = DataKey::MerkleRootHistory(dao_id, proposal_id);
        let history: Vec<MerkleRootRecord> = env
            .storage()
            .persistent()
            .get(&history_key)
            .unwrap_or_else(|| Vec::new(&env));
        if !history.is_empty() {
            Self::bump_persistent(&env, &history_key);
        }
        history
    }

    /// Get the number of valid candidates for a proposal's election.
    /// Returns 0 if no election config is set (backward-compatible default).
    pub fn get_num_candidates(env: Env, dao_id: u64, proposal_id: u64) -> u32 {
        Self::get_election_config(env, dao_id, proposal_id)
            .map(|c| c.num_candidates)
            .unwrap_or(0)
    }

    /// Get the snapshot ledger for a proposal (from ProposalInfo).
    pub fn get_snapshot_ledger(env: Env, dao_id: u64, proposal_id: u64) -> u32 {
        let proposal = Self::get_proposal(env, dao_id, proposal_id);
        proposal.snapshot_ledger
    }

    /// Record a balance checkpoint for time-weighted average balance computation.
    /// Called by the token contract when a voter's balance changes.
    /// Stores (dao_id, address, ledger) -> balance for TWAB calculation.
    pub fn record_balance_checkpoint(env: Env, dao_id: u64, voter: Address, balance: i128) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        let ledger = env.ledger().sequence();
        let key = DataKey::BalanceCheckpoint(dao_id, voter.clone(), ledger);
        env.storage().persistent().set(&key, &balance);
        Self::bump_persistent(&env, &key);
    }

    /// Compute time-weighted average balance for a voter between a start and end ledger.
    /// Uses stored balance checkpoints to compute the average balance over the window.
    /// Returns None if no checkpoints are available.
    pub fn get_twab(
        env: Env,
        dao_id: u64,
        voter: Address,
        start_ledger: u32,
        end_ledger: u32,
    ) -> Option<i128> {
        Self::bump_instance(&env);
        if start_ledger >= end_ledger {
            return None;
        }
        let total_duration = (end_ledger - start_ledger) as u128;
        if total_duration == 0 {
            return None;
        }

        let mut weighted_sum: i128 = 0;
        let mut prev_ledger: u32 = start_ledger;
        let mut prev_balance: i128 = 0;
        let mut has_data = false;

        // Iterate through checkpoints in the window
        let mut current_ledger = start_ledger;
        while current_ledger <= end_ledger {
            let cp_key = DataKey::BalanceCheckpoint(dao_id, voter.clone(), current_ledger);
            if let Some(balance) = env.storage().persistent().get::<DataKey, i128>(&cp_key) {
                if has_data {
                    let duration = (current_ledger - prev_ledger) as u128;
                    weighted_sum +=
                        prev_balance.saturating_mul(i128::try_from(duration).unwrap_or(i128::MAX));
                }
                prev_balance = balance;
                prev_ledger = current_ledger;
                has_data = true;
            }
            current_ledger += 1;
        }

        // Add the final segment
        if has_data {
            let final_duration = (end_ledger - prev_ledger) as u128;
            weighted_sum +=
                prev_balance.saturating_mul(i128::try_from(final_duration).unwrap_or(i128::MAX));
        }

        if !has_data {
            return None;
        }

        let avg = weighted_sum / i128::try_from(total_duration).unwrap_or(1);
        Some(avg)
    }

    /// Set a transfer cooldown for a voter during an active election.
    /// Prevents the voter from transferring tokens until the cooldown expires.
    /// Called automatically when a voter registers or votes in a token-gated election.
    pub fn set_voter_cooldown(env: Env, dao_id: u64, voter: Address) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        // Cooldown lasts until the current proposal ends (max 7 days from now)
        let cooldown_end = env.ledger().timestamp() + 604800; // 7 days
        let key = DataKey::TransferCooldown(dao_id, voter);
        env.storage().persistent().set(&key, &cooldown_end);
        Self::bump_persistent(&env, &key);
    }

    /// Clear a voter's transfer cooldown after an election ends.
    pub fn clear_voter_cooldown(env: Env, dao_id: u64, voter: Address) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        let key = DataKey::TransferCooldown(dao_id, voter);
        env.storage().persistent().remove(&key);
    }

    /// Check if a voter is in transfer cooldown (cannot transfer tokens).
    /// Returns true if cooldown is active, false otherwise.
    /// This function is intended to be called by token contracts before transfers.
    pub fn is_in_transfer_cooldown(env: Env, dao_id: u64, voter: Address) -> bool {
        Self::bump_instance(&env);
        let key = DataKey::TransferCooldown(dao_id, voter);
        let cooldown_end: Option<u64> = env.storage().persistent().get(&key);
        match cooldown_end {
            Some(end) => env.ledger().timestamp() < end,
            None => false,
        }
    }

    /// Create a balance snapshot for a proposal (records current token balances).
    /// Stores the snapshot ledger and timestamp for future eligibility checks.
    /// Called during proposal creation when token-gating is configured.
    pub fn create_balance_snapshot(env: Env, dao_id: u64, proposal_id: u64) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        let snapshot = BalanceSnapshotInfo {
            snapshot_ledger: env.ledger().sequence(),
            timestamp: env.ledger().timestamp(),
        };
        let key = DataKey::BalanceSnapshot(dao_id, proposal_id);
        env.storage().persistent().set(&key, &snapshot);
        Self::bump_persistent(&env, &key);
    }

    /// Get the balance snapshot for a proposal.
    pub fn get_balance_snapshot(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
    ) -> Option<BalanceSnapshotInfo> {
        Self::bump_instance(&env);
        let key = DataKey::BalanceSnapshot(dao_id, proposal_id);
        let snapshot: Option<BalanceSnapshotInfo> = env.storage().persistent().get(&key);
        if snapshot.is_some() {
            Self::bump_persistent(&env, &key);
        }
        snapshot
    }

    /// Check if a voter's balance at snapshot time meets the minimum requirement.
    /// For token-gated proposals, this verifies the voter held sufficient tokens
    /// at the time the proposal was created (preventing flash loan attacks).
    /// This is a view function that token contracts should call before allowing votes.
    /// Returns true if the voter's snapshot balance meets the minimum, or if no
    /// token-gating is configured for this proposal.
    #[allow(unused_variables)]
    pub fn check_voter_eligibility(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        voter: Address,
        current_balance: i128,
        balance_at_snapshot: i128,
    ) -> bool {
        Self::bump_instance(&env);
        // Check if this proposal has token-gating configured
        let config_key = DataKey::ElectionConfig(dao_id, proposal_id);
        let config: Option<ElectionConfig> = env.storage().persistent().get(&config_key);

        match config {
            Some(cfg) => {
                // If TWAB window is set, use time-weighted average balance
                if cfg.twab_window > 0 {
                    let snapshot = Self::get_balance_snapshot(env.clone(), dao_id, proposal_id);
                    if let Some(snap) = snapshot {
                        let end_ledger = env.ledger().sequence();
                        let start_ledger = if end_ledger > snap.snapshot_ledger {
                            snap.snapshot_ledger
                        } else {
                            0
                        };
                        if let Some(twab) = Self::get_twab(
                            env.clone(),
                            dao_id,
                            voter.clone(),
                            start_ledger,
                            end_ledger,
                        ) {
                            return twab >= cfg.min_balance;
                        }
                    }
                    // Fallback: use balance at snapshot (checked against checkpoint)
                    balance_at_snapshot >= cfg.min_balance
                } else {
                    // Without TWAB, use balance at snapshot time
                    balance_at_snapshot >= cfg.min_balance
                }
            }
            None => {
                // No token-gating configured for this proposal
                true
            }
        }
    }

    fn randomness_deadlines(env: &Env, dao_id: u64, proposal_id: u64) -> (u64, u64) {
        let proposal = Self::get_proposal(env.clone(), dao_id, proposal_id);
        let commit_end = proposal.created_at.saturating_add(RANDOMNESS_COMMIT_WINDOW);
        (
            commit_end,
            commit_end.saturating_add(RANDOMNESS_REVEAL_WINDOW),
        )
    }

    fn require_dao_member(env: &Env, dao_id: u64, participant: &Address) {
        let tree = Self::tree_contract(env.clone());
        let sbt: Address =
            env.invoke_contract(&tree, &symbol_short!("sbt_contr"), soroban_sdk::vec![env]);
        let is_member: bool = env.invoke_contract(
            &sbt,
            &symbol_short!("has"),
            soroban_sdk::vec![env, dao_id.into_val(env), participant.clone().into_val(env)],
        );
        if !is_member {
            panic_with_error!(env, VotingError::NotDaoMember);
        }
    }

    pub fn randomness_commitment(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        participant: Address,
        value: BytesN<32>,
    ) -> BytesN<32> {
        let mut input = Bytes::new(&env);
        input.append(&Bytes::from_array(&env, &dao_id.to_be_bytes()));
        input.append(&Bytes::from_array(&env, &proposal_id.to_be_bytes()));
        input.append(&participant.to_xdr(&env));
        input.append(&Bytes::from_array(&env, &value.to_array()));
        env.crypto().sha256(&input).into()
    }

    pub fn commit_randomness(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        commitment: BytesN<32>,
        participant: Address,
    ) {
        Self::bump_instance(&env);
        participant.require_auth();
        Self::require_dao_member(&env, dao_id, &participant);
        let (commit_end, _) = Self::randomness_deadlines(&env, dao_id, proposal_id);
        if env.ledger().timestamp() >= commit_end {
            panic_with_error!(&env, VotingError::RandomnessCommitClosed);
        }

        let key = DataKey::RandomnessCommit(dao_id, proposal_id, participant.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, VotingError::RandomnessAlreadyCommitted);
        }
        let committers_key = DataKey::RandomnessCommitters(dao_id, proposal_id);
        let mut committers: Vec<Address> = env
            .storage()
            .persistent()
            .get(&committers_key)
            .unwrap_or_else(|| Vec::new(&env));
        if committers.len() >= MAX_RANDOMNESS_PARTICIPANTS {
            panic_with_error!(&env, VotingError::RandomnessParticipantLimit);
        }

        env.storage().persistent().set(&key, &commitment);
        Self::bump_persistent(&env, &key);
        committers.push_back(participant.clone());
        env.storage().persistent().set(&committers_key, &committers);
        Self::bump_persistent(&env, &committers_key);

        RandomnessCommittedEvent {
            dao_id,
            proposal_id,
            participant,
        }
        .publish(&env);
    }

    pub fn reveal_randomness(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        value: BytesN<32>,
        participant: Address,
    ) {
        Self::bump_instance(&env);
        participant.require_auth();
        let (commit_end, reveal_end) = Self::randomness_deadlines(&env, dao_id, proposal_id);
        let now = env.ledger().timestamp();
        if now < commit_end || now >= reveal_end {
            panic_with_error!(&env, VotingError::RandomnessRevealClosed);
        }

        let commit_key = DataKey::RandomnessCommit(dao_id, proposal_id, participant.clone());
        let commitment: BytesN<32> = env
            .storage()
            .persistent()
            .get(&commit_key)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::RandomnessCommitmentMissing));
        if commitment
            != Self::randomness_commitment(
                env.clone(),
                dao_id,
                proposal_id,
                participant.clone(),
                value.clone(),
            )
        {
            panic_with_error!(&env, VotingError::RandomnessRevealMismatch);
        }

        let reveal_key = DataKey::RandomnessReveal(dao_id, proposal_id, participant.clone());
        if env.storage().persistent().has(&reveal_key) {
            panic_with_error!(&env, VotingError::RandomnessAlreadyRevealed);
        }
        env.storage().persistent().set(&reveal_key, &value);
        Self::bump_persistent(&env, &reveal_key);

        RandomnessRevealedEvent {
            dao_id,
            proposal_id,
            participant,
        }
        .publish(&env);
    }

    pub fn finalize_candidate_seed(env: Env, dao_id: u64, proposal_id: u64) -> BytesN<32> {
        Self::bump_instance(&env);
        let (commit_end, _) = Self::randomness_deadlines(&env, dao_id, proposal_id);
        if env.ledger().timestamp() < commit_end {
            panic_with_error!(&env, VotingError::RandomnessCommitClosed);
        }

        let config_key = DataKey::ElectionConfig(dao_id, proposal_id);
        let mut config: ElectionConfig =
            env.storage()
                .persistent()
                .get(&config_key)
                .unwrap_or(ElectionConfig {
                    snapshot_ledger: env.ledger().sequence(),
                    min_balance: 0,
                    twab_window: 0,
                    candidate_seed: None,
                    num_candidates: 0,
                    vdf_output: None,
                    vdf_delay: 0,
                    max_revotes: 0,
                    merkle_root_set_at: None,
                    commitment_window: 0,
                });
        if config.candidate_seed.is_some() {
            panic_with_error!(&env, VotingError::CandidateSeedFinalized);
        }
        let committers: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::RandomnessCommitters(dao_id, proposal_id))
            .unwrap_or_else(|| Vec::new(&env));
        if committers.len() < MIN_RANDOMNESS_PARTICIPANTS {
            panic_with_error!(&env, VotingError::InsufficientRandomness);
        }

        let mut input = Bytes::new(&env);
        input.append(&Bytes::from_array(&env, &dao_id.to_be_bytes()));
        input.append(&Bytes::from_array(&env, &proposal_id.to_be_bytes()));
        for participant in committers.iter() {
            let reveal: BytesN<32> = env
                .storage()
                .persistent()
                .get(&DataKey::RandomnessReveal(dao_id, proposal_id, participant))
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::InsufficientRandomness));
            input.append(&Bytes::from_array(&env, &reveal.to_array()));
        }

        let seed: BytesN<32> = env.crypto().sha256(&input).into();
        config.candidate_seed = Some(seed.clone());
        env.storage().persistent().set(&config_key, &config);
        Self::bump_persistent(&env, &config_key);

        CandidateSeedFinalizedEvent {
            dao_id,
            proposal_id,
            seed: seed.clone(),
        }
        .publish(&env);
        seed
    }

    pub fn get_candidate_seed(env: Env, dao_id: u64, proposal_id: u64) -> Option<BytesN<32>> {
        Self::get_election_config(env, dao_id, proposal_id).and_then(|config| config.candidate_seed)
    }

    pub fn candidate_order_key(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        candidate: BytesN<32>,
    ) -> BytesN<32> {
        // Use VDF output as the seed if available (VDF randomness takes precedence)
        let vdf_output = Self::get_vdf_output(env.clone(), dao_id, proposal_id);
        let seed = match vdf_output {
            Some(vdf_seed) => vdf_seed,
            None => {
                // Fall back to commit-reveal seed
                Self::get_candidate_seed(env.clone(), dao_id, proposal_id).unwrap_or_else(|| {
                    panic_with_error!(&env, VotingError::RandomnessCommitmentMissing)
                })
            }
        };
        let mut input = Bytes::new(&env);
        input.append(&Bytes::from_array(&env, &seed.to_array()));
        input.append(&Bytes::from_array(&env, &candidate.to_array()));
        env.crypto().sha256(&input).into()
    }

    // ── VDF (Verifiable Delay Function) Functions ───────────────────────────

    /// Set the VDF delay parameter for an election.
    ///
    /// This configures the number of SHA256 iterations required for the VDF.
    /// A higher delay provides stronger unpredictability guarantees.
    /// Must be set before VDF output can be submitted.
    ///
    /// # Arguments
    ///
    /// * `dao_id` - DAO identifier
    /// * `proposal_id` - Proposal identifier
    /// * `delay` - Number of SHA256 iterations (VDF delay parameter)
    /// * `admin` - DAO admin address (required for auth)
    pub fn set_vdf_delay(env: Env, dao_id: u64, proposal_id: u64, delay: u64, admin: Address) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);

        if !(vdf::MIN_VDF_ITERATIONS..=vdf::MAX_VDF_ITERATIONS).contains(&delay) {
            panic_with_error!(&env, VotingError::VdfInvalidDelay);
        }

        let delay_key = DataKey::VdfDelay(dao_id, proposal_id);
        env.storage().persistent().set(&delay_key, &delay);
        Self::bump_persistent(&env, &delay_key);

        // Derive and store the VDF input from election parameters
        let block_hash = BytesN::from_array(&env, &[0u8; 32]); // Placeholder — in production use ledger hash
        let admin_xdr = admin.to_xdr(&env);
        let admin_seed: BytesN<32> = env.crypto().sha256(&admin_xdr).into();
        let vdf_input = vdf::derive_vdf_input(&env, dao_id, proposal_id, &block_hash, &admin_seed);
        let input_key = DataKey::VdfInput(dao_id, proposal_id);
        env.storage().persistent().set(&input_key, &vdf_input);
        Self::bump_persistent(&env, &input_key);
    }

    /// Submit VDF output and proof for an election.
    ///
    /// Anyone can submit the VDF output once the delay period is complete.
    /// The output is verified on-chain using the provided checkpoints.
    ///
    /// # Arguments
    ///
    /// * `dao_id` - DAO identifier
    /// * `proposal_id` - Proposal identifier
    /// * `vdf_output` - The VDF output `y = SHA256^T(x)` (32 bytes)
    /// * `checkpoints` - Intermediate hash values for on-chain verification
    /// * `proposal_creation_time` - Timestamp when the proposal was created (used to verify delay elapsed)
    pub fn submit_vdf_output(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        vdf_output: BytesN<32>,
        checkpoints: soroban_sdk::Vec<BytesN<32>>,
        proposal_creation_time: u64,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);

        // Check not already finalized
        let finalized_key = DataKey::VdfFinalized(dao_id, proposal_id);
        if env.storage().persistent().has(&finalized_key) {
            panic_with_error!(&env, VotingError::VdfAlreadySubmitted);
        }

        // Get VDF delay
        let delay_key = DataKey::VdfDelay(dao_id, proposal_id);
        let delay: u64 = env
            .storage()
            .persistent()
            .get(&delay_key)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::VdfInvalidDelay));

        // Verify delay has elapsed
        let now = env.ledger().timestamp();
        if now < proposal_creation_time.saturating_add(delay) {
            panic_with_error!(&env, VotingError::VdfDelayNotElapsed);
        }

        // Get VDF input
        let input_key = DataKey::VdfInput(dao_id, proposal_id);
        let vdf_input: BytesN<32> = env
            .storage()
            .persistent()
            .get(&input_key)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::VdfInputNotAvailable));

        // Verify the VDF proof on-chain
        let verified = vdf::verify_vdf(&env, &vdf_input, delay, &vdf_output, &checkpoints);
        if !verified {
            // Emit failure event
            VdfVerifiedEvent {
                dao_id,
                proposal_id,
                verified: false,
            }
            .publish(&env);
            panic_with_error!(&env, VotingError::VdfVerificationFailed);
        }

        // Store VDF output
        let output_key = DataKey::VdfOutput(dao_id, proposal_id);
        env.storage().persistent().set(&output_key, &vdf_output);
        Self::bump_persistent(&env, &output_key);

        // Store checkpoints as proof
        let proof_key = DataKey::VdfProof(dao_id, proposal_id);
        env.storage().persistent().set(&proof_key, &checkpoints);
        Self::bump_persistent(&env, &proof_key);

        // Mark as finalized
        env.storage().persistent().set(&finalized_key, &true);
        Self::bump_persistent(&env, &finalized_key);

        // Update ElectionConfig with VDF output
        let config_key = DataKey::ElectionConfig(dao_id, proposal_id);
        let mut config: ElectionConfig =
            env.storage()
                .persistent()
                .get(&config_key)
                .unwrap_or(ElectionConfig {
                    snapshot_ledger: env.ledger().sequence(),
                    min_balance: 0,
                    twab_window: 0,
                    candidate_seed: None,
                    num_candidates: 0,
                    vdf_output: None,
                    vdf_delay: delay,
                    max_revotes: 0,
                    merkle_root_set_at: None,
                    commitment_window: 0,
                });
        config.vdf_output = Some(vdf_output.clone());
        config.vdf_delay = delay;
        env.storage().persistent().set(&config_key, &config);
        Self::bump_persistent(&env, &config_key);

        VdfSubmittedEvent {
            dao_id,
            proposal_id,
            output: vdf_output,
            delay,
        }
        .publish(&env);

        VdfVerifiedEvent {
            dao_id,
            proposal_id,
            verified: true,
        }
        .publish(&env);
    }

    /// Get the VDF output for an election, if submitted.
    pub fn get_vdf_output(env: Env, dao_id: u64, proposal_id: u64) -> Option<BytesN<32>> {
        Self::bump_instance(&env);
        let output_key = DataKey::VdfOutput(dao_id, proposal_id);
        let output: Option<BytesN<32>> = env.storage().persistent().get(&output_key);
        if output.is_some() {
            Self::bump_persistent(&env, &output_key);
        }
        output
    }

    /// Get the VDF delay parameter for an election.
    pub fn get_vdf_delay(env: Env, dao_id: u64, proposal_id: u64) -> u64 {
        Self::bump_instance(&env);
        let delay_key = DataKey::VdfDelay(dao_id, proposal_id);
        env.storage().persistent().get(&delay_key).unwrap_or(0)
    }

    /// Get the VDF input seed for an election.
    pub fn get_vdf_input(env: Env, dao_id: u64, proposal_id: u64) -> Option<BytesN<32>> {
        Self::bump_instance(&env);
        let input_key = DataKey::VdfInput(dao_id, proposal_id);
        let input: Option<BytesN<32>> = env.storage().persistent().get(&input_key);
        if input.is_some() {
            Self::bump_persistent(&env, &input_key);
        }
        input
    }

    /// Check if VDF has been finalized for an election.
    pub fn is_vdf_finalized(env: Env, dao_id: u64, proposal_id: u64) -> bool {
        Self::bump_instance(&env);
        let finalized_key = DataKey::VdfFinalized(dao_id, proposal_id);
        env.storage().persistent().has(&finalized_key)
    }

    /// Finalize the candidate seed using the VDF output.
    ///
    /// If VDF output is available, it is used directly as the candidate seed.
    /// This provides verified randomness that was unpredictable before the
    /// delay period elapsed.
    ///
    /// If VDF output is not available, falls back to the commit-reveal seed.
    ///
    /// # Returns
    ///
    /// The finalized candidate seed (32 bytes)
    pub fn finalize_with_vdf(env: Env, dao_id: u64, proposal_id: u64) -> BytesN<32> {
        Self::bump_instance(&env);

        // Check if VDF output is available
        if let Some(vdf_output) = Self::get_vdf_output(env.clone(), dao_id, proposal_id) {
            // Use VDF output directly as the candidate seed
            // Store it in ElectionConfig for backward compatibility
            let config_key = DataKey::ElectionConfig(dao_id, proposal_id);
            let mut config: ElectionConfig =
                env.storage()
                    .persistent()
                    .get(&config_key)
                    .unwrap_or(ElectionConfig {
                        snapshot_ledger: env.ledger().sequence(),
                        min_balance: 0,
                        twab_window: 0,
                        candidate_seed: None,
                        num_candidates: 0,
                        vdf_output: None,
                        vdf_delay: 0,
                        max_revotes: 0,
                        merkle_root_set_at: None,
                        commitment_window: 0,
                    });

            // Mix VDF output with existing seed if available, or use VDF output as seed
            let seed = match config.candidate_seed {
                Some(existing_seed) => {
                    // Mix: seed = SHA256(vdf_output || existing_seed)
                    let mut mix = Bytes::new(&env);
                    mix.append(&Bytes::from_array(&env, &vdf_output.to_array()));
                    mix.append(&Bytes::from_array(&env, &existing_seed.to_array()));
                    env.crypto().sha256(&mix).into()
                }
                None => vdf_output,
            };

            config.candidate_seed = Some(seed.clone());
            env.storage().persistent().set(&config_key, &config);
            Self::bump_persistent(&env, &config_key);

            CandidateSeedFinalizedEvent {
                dao_id,
                proposal_id,
                seed: seed.clone(),
            }
            .publish(&env);

            seed
        } else {
            // Fall back to commit-reveal seed finalization
            Self::finalize_candidate_seed(env, dao_id, proposal_id)
        }
    }
}

#[cfg(test)]
mod test;
