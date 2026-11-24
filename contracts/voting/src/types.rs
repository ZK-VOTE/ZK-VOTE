//! Shared types for the voting contract: constants, error codes, storage keys,
//! and all `#[contracttype]` value types.
//!
//! Invariants (storage-layout critical — changing any of these is a breaking
//! migration):
//! - `DataKey` is **append-only**. Soroban derives a variant's storage
//!   discriminant from its position in the enum, so new variants must go at the
//!   end and existing variants must never be reordered, renamed, or removed.
//! - `VotingError` discriminants are a public ABI. Codes are never renumbered;
//!   the coarse categories occupy 100–106.
//! - The `symbol_short!` key constants (`TREE_CONTRACT`, `REGISTRY`,
//!   `CIRCUIT_REGISTRY`, `CIRCUIT_REGISTRY_ADMIN`, `TRANSCRIPT_REGISTRY`,
//!   `VERSION_KEY`, `STORAGE_VERSION_KEY`) are exact byte strings. Renaming one
//!   silently orphans every value stored under it.
//! - `#[contracttype]` XDR names come from the Rust identifier, **not** the
//!   module path, so moving these types out of `lib.rs` does not change the
//!   contract spec or stored XDR.
//!
//! See `storage_layout_test.rs` for the regression assertions over these
//! invariants.

#[allow(unused_imports)]
use soroban_sdk::{
    contracterror, contracttype, symbol_short, Address, BytesN, Env, String, Symbol, U256, Vec,
};
use zkvote_groth16::{PathContext, Proof, VerificationKey};

pub const TREE_CONTRACT: Symbol = symbol_short!("tree");
pub const REGISTRY: Symbol = symbol_short!("registry");
pub const CIRCUIT_REGISTRY: Symbol = symbol_short!("circ_reg");
pub const CIRCUIT_REGISTRY_ADMIN: Symbol = symbol_short!("cr_admin");
pub const TRANSCRIPT_REGISTRY: Symbol = symbol_short!("tr_reg");
pub const VERSION: u32 = 2;
pub const STORAGE_VERSION: u32 = 1;
pub const VERSION_KEY: Symbol = symbol_short!("ver");
pub const STORAGE_VERSION_KEY: Symbol = symbol_short!("stor_ver");

// TTL management: bump on every interaction to keep contract alive
pub const INSTANCE_TTL_THRESHOLD: u32 = 120_960; // ~7 days
pub const INSTANCE_TTL_EXTEND: u32 = 535_680; // ~31 days
pub const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
pub const PERSISTENT_TTL_EXTEND: u32 = 535_680;
// Nullifiers are Temporary: auto-expire after proposal.end_time + grace period
// 259_200 ledgers @ ~5s/ledger = 72 hours grace for late-arriving txns
pub const NULLIFIER_GRACE_LEDGERS: u32 = 259_200;
pub const TEMPORARY_TTL_THRESHOLD: u32 = 51_840; // ~3 days
pub const TEMPORARY_TTL_EXTEND_BASE: u32 = 259_200; // 72h base, + end_time offset

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
    RandomnessCommitmentMissing = 34,
    RandomnessRevealMismatch = 35,
    CandidateSeedFinalized = 36,
    InsufficientRandomness = 37,
    RandomnessAlreadyRevealed = 38,
    RandomnessParticipantLimit = 39,
    TooManyActiveProposals = 40,
    ProposalCooldownActive = 41,
    InvalidProposalDeposit = 42,
    ProposalHasVotes = 43,
    VotingNotStarted = 44,
    ElectionDurationTooShort = 45,
    ElectionDurationTooLong = 46,
    InvalidNoticePeriod = 47,
    InvalidRegistrationPeriod = 48,
    InvalidRegistrationGap = 49,
    /// Regular `vote` called on a Quadratic proposal (use `cast_qv_vote`), or
    /// `cast_qv_vote` called on a non-Quadratic proposal
    NotQuadraticProposal = 50,
    /// Quadratic-voting verification key not set for this DAO
    QvVkNotSet = 51,
    /// Quadratic ballot exceeds the fixed credit budget (sum of squares > MAX_QV_BUDGET)
    QvBudgetExceeded = 52,
    /// Quadratic tally verification key not set for this DAO
    QvTallyVkNotSet = 53,
    /// Tally proposal_ids / tallies vectors have mismatched or empty length
    QvTallyLengthMismatch = 54,
    /// Reentrant call detected (defense-in-depth against cross-contract reentrancy)
    ReentrantCall = 56,
    /// VDF proof verification failed
    VdfVerificationFailed = 57,
    /// VDF output already submitted for this election
    VdfAlreadySubmitted = 58,
    /// VDF delay period has not elapsed yet
    VdfDelayNotElapsed = 59,
    /// VDF delay parameter is invalid
    VdfInvalidDelay = 60,
    /// VDF input (block hash) is not available
    VdfInputNotAvailable = 61,
    /// Merkle root is fixed for this proposal and can no longer be changed
    MerkleRootLocked = 63,
    /// Merkle root update attempted after the commitment window closed
    CommitmentWindowExpired = 64,
    /// Upgrade would move storage to an older schema version
    StorageVersionDowngrade = 65,
    /// Upgrade payload does not target the contract's current version
    UpgradeVersionMismatch = 66,
    /// Upgrade payload exceeds MAX_UPGRADE_PAYLOAD_LEN
    UpgradePayloadTooLarge = 67,
    /// vote_choice is outside [0, num_candidates)
    InvalidCandidateIndex = 68,
    /// Merkle depth is zero, above MAX_MERKLE_DEPTH, or has no registered VK
    InvalidMerkleDepth = 71,
    /// Batch is empty or larger than MAX_VOTE_BATCH
    InvalidBatchSize = 72,
    /// The same nullifier appears twice within one batch
    DuplicateNullifierInBatch = 73,

    // ── Errors raised by commit_reveal.rs and sybil.rs ─────────────────────
    // Referenced by those modules but never defined, so the crate did not
    // build. Numbered above the existing range; the coarse block starts at 100.
    /// Commit–reveal is not configured for this proposal
    CommitRevealNotConfigured = 81,
    /// The commit phase has closed
    CommitPhaseClosed = 82,
    /// A commitment already exists for this nullifier
    CommitAlreadyExists = 83,
    /// The reveal phase is not open yet
    RevealPhaseNotOpen = 84,
    /// The reveal phase has closed
    RevealPhaseClosed = 85,
    /// No commitment found for this nullifier
    VoteCommitmentNotFound = 86,
    /// The revealed vote does not match its commitment
    VoteCommitmentMismatch = 87,
    /// This commitment has already been revealed
    AlreadyRevealed = 88,
    /// The VDF for this proposal has not been finalized
    VdfNotFinalized = 89,
    /// The reveal schedule is invalid
    InvalidRevealSchedule = 90,
    /// Weight exceeds the proposal's sybil cap
    WeightAboveSybilCap = 91,
    /// The submitting relayer address is not the one bound into the proof
    InvalidRelayerAddress = 92,
    /// Verification key has not been attested by an MPC ceremony transcript
    VkNotAttested = 93,

    // ── Coarse categories (100–106) ────────────────────────────────────────
    // An anonymous submission collapses to one of these so a relayer cannot
    // distinguish *why* a vote was refused and probe internal state. Numbered
    // to match `CommentsError` and `RewardsError`, so a given code means the
    // same thing whichever contract returned it.
    /// Malformed input: signal out of field, bad nullifier, bad index
    InvalidInput = 100,
    /// Caller is not eligible: root mismatch, stale root, revoked commitment
    EligibilityFailed = 101,
    /// Proof did not verify, or the key it was made against changed
    ProofInvalid = 102,
    /// This nullifier has already been spent
    AlreadySubmitted = 103,
    /// The voting window is closed
    WindowClosed = 104,
    /// Insufficient funds for the operation
    InsufficientFunds = 105,
    /// The election or contract is not configured for this operation
    ConfigError = 106,
    TransferCooldownActive = 74,
    /// Balance at snapshot time is below minimum required for token-gated voting
    InsufficientSnapshotBalance = 75,
    ContractPaused = 76,
    NotGuardian = 77,
    RandomnessCommitClosed = 78,
    RandomnessRevealClosed = 79,
    RandomnessAlreadyCommitted = 80,
}

impl VotingError {
    /// Collapse fine-grained discriminants into the coarse categories
    /// (100–106) when `ctx` is [`PathContext::Anonymous`].
    /// [`PathContext::Admin`] returns the value unchanged so admin tooling and
    /// tests keep full diagnostic granularity.
    ///
    /// The anonymous path is a relayer submitting someone else's vote. Telling
    /// it exactly which check failed would let it probe membership, nullifier
    /// state and election config one submission at a time, so everything an
    /// anonymous caller can trigger collapses to a category.
    pub fn to_coarse(&self, ctx: PathContext) -> VotingError {
        #[cfg(test)]
        return *self;
        #[cfg(not(test))]
        match ctx {
            PathContext::Admin => *self,
            PathContext::Anonymous => match self {
                // Malformed input
                VotingError::SignalNotInField
                | VotingError::InvalidNullifier
                | VotingError::InvalidCandidateIndex
                | VotingError::InvalidDomainTag
                | VotingError::WeightOutOfRange
                | VotingError::InvalidMerkleDepth
                | VotingError::InvalidBatchSize
                | VotingError::DuplicateNullifierInBatch => VotingError::InvalidInput,

                // Eligibility: which root failed, and how, is membership
                // information.
                VotingError::RootMismatch
                | VotingError::RootNotInHistory
                | VotingError::RootPredatesProposal
                | VotingError::RootPredatesRemoval
                | VotingError::CommitmentRevokedAtCreation
                | VotingError::CommitmentRevokedDuringVoting => VotingError::EligibilityFailed,

                // Proof verification
                VotingError::InvalidProof | VotingError::VkChanged => VotingError::ProofInvalid,

                // Double-spend
                VotingError::NullifierUsed => VotingError::AlreadySubmitted,

                // Timing
                VotingError::VotingClosed => VotingError::WindowClosed,

                // Election/contract configuration
                VotingError::VkNotSet
                | VotingError::VkVersionMismatch
                | VotingError::NotQuadraticProposal
                | VotingError::TallyOverflow => VotingError::ConfigError,

                // Already coarse: idempotent.
                VotingError::InvalidInput
                | VotingError::EligibilityFailed
                | VotingError::ProofInvalid
                | VotingError::AlreadySubmitted
                | VotingError::WindowClosed
                | VotingError::InsufficientFunds
                | VotingError::ConfigError => *self,

                // Admin-only or public-state conditions an anonymous caller
                // cannot reach, or that leak nothing: pass through.
                other => *other,
            },
        }
    }
}

// Maximum allowed IC vector length (num_public_inputs + 1)
// Our circuit has 5 public signals, so IC should have 6 elements
// Allow some slack for future upgrades (up to 20 public inputs)
pub const MAX_IC_LENGTH: u32 = 21;

// Size limits to prevent DoS attacks
pub const MAX_TITLE_LEN: u32 = 100; // Max proposal title length (100 bytes)
pub const MAX_CID_LEN: u32 = 64; // Max IPFS CID length (CIDv1 is ~59 chars)
pub const MAX_UPGRADE_PAYLOAD_LEN: u32 = 4096;

/// Largest Merkle depth an election may declare (#93). 2^32 members is far
/// beyond anything the tree contract can hold; the bound exists so a bad depth
/// cannot be used to force an unbounded proof.
pub const MAX_MERKLE_DEPTH: u32 = 32;

/// Largest batch `cast_votes` accepts (#90). Matches the verifier's own cap:
/// the whole pairing check has to fit in one transaction's resource budget.
pub const MAX_VOTE_BATCH: u32 = zkvote_groth16::batch::MAX_BATCH_SIZE;

// Circuit constants
/// Vote circuit public signals: root, nullifier, dao_id, proposal_id, vote_choice, num_candidates
pub const NUM_PUBLIC_SIGNALS: u32 = 6;
// IC (inner commitment) vector length for Groth16 VK = num_public_inputs + 1
pub const VOTE_CIRCUIT_IC_LEN: u32 = NUM_PUBLIC_SIGNALS + 1;
/// Tally circuit public signals: [dao_id, proposal_id, num_votes, yes_votes, no_votes, nullifier_acc]
pub const TALLY_NUM_PUBLIC_SIGNALS: u32 = 6;
/// IC vector length for the tally Groth16 VK = TALLY_NUM_PUBLIC_SIGNALS + 1
pub const TALLY_CIRCUIT_IC_LEN: u32 = TALLY_NUM_PUBLIC_SIGNALS + 1;
pub const MAX_PAUSE_DURATION: u64 = 72 * 60 * 60;
pub const RANDOMNESS_COMMIT_WINDOW: u64 = 3_600;
pub const RANDOMNESS_REVEAL_WINDOW: u64 = 3_600;
pub const MIN_RANDOMNESS_PARTICIPANTS: u32 = 2;
pub const MAX_RANDOMNESS_PARTICIPANTS: u32 = 32;

// VDF constants
/// Minimum VDF checkpoints for on-chain verification
#[allow(dead_code)]
pub const MIN_VDF_CHECKPOINTS: u32 = 3;
/// Maximum VDF checkpoints to bound on-chain computation
#[allow(dead_code)]
pub const MAX_VDF_CHECKPOINTS: u32 = 100;

// Quadratic-voting circuit constants (issue #50)
/// QV circuit public signals: [root, daoId, proposalId, nullifier, totalCreditsSpent, allocationsHash]
pub const QV_NUM_PUBLIC_SIGNALS: u32 = 6;
/// IC vector length for the QV Groth16 VK = QV_NUM_PUBLIC_SIGNALS + 1
pub const QV_CIRCUIT_IC_LEN: u32 = QV_NUM_PUBLIC_SIGNALS + 1;
/// Fixed quadratic credit budget per member per snapshot. MUST match the
/// MAX_BUDGET baked into the deployed quadratic_vote circuit (see
/// circuits/quadratic_vote_main.circom). Enforced on-chain as defense in depth;
/// the circuit already proves sum(voiceCredits_i^2) <= MAX_BUDGET.
pub const MAX_QV_BUDGET: u64 = 100;

// Weighted vote constants — constraint review: weight must be bounded
pub const MAX_WEIGHT: u32 = 1_000_000;
pub const MIN_WEIGHT: u32 = 1;
/// Domain tag for weighted voting (prevents cross-circuit replay)
pub const DOMAIN_TAG_WEIGHTED: u32 = 0x7774_5f76; // "wt_v" ascii prefix

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
    /// Verification key registered for a specific Merkle depth (#93).
    DepthVk(u64, u32), // (dao_id, merkle_depth) -> VerificationKey
    /// Hash of the depth verification key, pinned when the election declared
    /// its depth, so a later `set_vk_for_depth` cannot silently change the key
    /// an in-flight election verifies against (#93).
    ProposalDepthVkHash(u64, u64), // (dao_id, proposal_id) -> BytesN<32>

    // ── Keys referenced by commit_reveal.rs and sybil.rs ───────────────────
    // These modules were merged without the DataKey variants they use, so the
    // crate did not build. Shapes are taken from the call sites; appended at
    // the end so existing storage discriminants are untouched.
    /// Commit–reveal configuration for a proposal (#302).
    CommitRevealConfig(u64, u64), // (dao_id, proposal_id)
    /// Verification key for the commit-phase circuit (#302).
    CommitVotingKey(u64), // (dao_id)
    /// A submitted vote commitment, keyed by nullifier (#302).
    VoteCommit(u64, u64, U256), // (dao_id, proposal_id, nullifier)
    /// Whether a commitment has been revealed (#302).
    VoteRevealed(u64, u64, U256), // (dao_id, proposal_id, nullifier)
    /// Number of commitments received for a proposal (#302).
    VoteCommitCount(u64, u64), // (dao_id, proposal_id)
    /// Cached proposal end time for the reveal schedule (#302).
    ProposalEndTime(u64, u64), // (dao_id, proposal_id)
    /// Verification key for the sybil-resistance circuit.
    SybilVotingKey(u64), // (dao_id)
    /// Root of the attestation tree a weighted vote proves against.
    AttestationRoot(u64, u64), // (dao_id, proposal_id)
    /// Per-proposal cap on a single voter's weight.
    SybilWeightCap(u64, u64), // (dao_id, proposal_id)
    /// Running weighted tally for a proposal.
    WeightedTally(u64, u64), // (dao_id, proposal_id)
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
    /// Merkle depth this election's proofs are built against (#93).
    ///
    /// 0 means the default circuit (`vote.circom`, depth 18) and the DAO's
    /// version-pinned verification key. A non-zero depth selects the circuit
    /// and verification key registered for that depth via `set_vk_for_depth`,
    /// letting a small election pay for a short Merkle path instead of a
    /// worst-case one.
    pub merkle_depth: u32,
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

/// One vote inside a batched submission (#90).
///
/// Carries exactly what a single `vote` call would, so a relayer can group
/// independent voters without any of them trusting each other: each proof is
/// still checked against its own public signals, just inside a combined
/// pairing check.
#[contracttype]
#[derive(Clone)]
pub struct BatchVote {
    pub vote_choice: bool,
    pub nullifier: U256,
    pub root: U256,
    pub proof: Proof,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proposal_state_transitions_follow_the_dag() {
        assert!(ProposalState::Registration.is_valid_transition(ProposalState::Active));
        assert!(ProposalState::Active.is_valid_transition(ProposalState::Closed));
        assert!(ProposalState::Closed.is_valid_transition(ProposalState::Archived));
        assert!(!ProposalState::Registration.is_valid_transition(ProposalState::Closed));
        assert!(!ProposalState::Archived.is_valid_transition(ProposalState::Active));
    }

    #[test]
    fn coarse_error_categories_are_distinct() {
        assert_ne!(VotingError::InvalidInput, VotingError::ConfigError);
        assert_ne!(VotingError::ProofInvalid, VotingError::EligibilityFailed);
        // Admin paths keep full discriminant granularity.
        assert_eq!(
            VotingError::SignalNotInField.to_coarse(PathContext::Admin),
            VotingError::SignalNotInField
        );
    }
}
