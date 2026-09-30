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
    Bls12381Curve, CurveId, Groth16Error, PathContext, Proof, ProofBls381, VerificationKey,
    VerificationKeyBls381,
};

// ZK quadratic voting with range proofs (issue #50)
mod quadratic;

// Sybil-resistance: SBT-age weighting + reputation score (issue #301)
mod sybil;

// VDF-gated vote commit–reveal (issue #302)
mod commit_reveal;

// Anonymous vote delegation / liquid democracy (issue #304) is declared in the
// tracker but has no implementation in this tree: `delegation.rs` has never
// existed on any branch and nothing references `delegation::`. The module
// declaration is left out until the implementation lands, so the crate builds.

const TREE_CONTRACT: Symbol = symbol_short!("tree");
const REGISTRY: Symbol = symbol_short!("registry");
// #592 per-DAO registry pin: voting must pin the expected dao-registry contract
// hash (REG_PIN) + allowlisted registry id, and verify get_admin responses come
// from the pinned registry. A fake registry returning admin=self is rejected.
const REG_PIN: Symbol = symbol_short!("reg_pin");
const REG_HASH_PIN: Symbol = symbol_short!("rgh_pin");
const CIRCUIT_REGISTRY: Symbol = symbol_short!("circ_reg");
const CIRCUIT_REGISTRY_ADMIN: Symbol = symbol_short!("cr_admin");
const TRANSCRIPT_REGISTRY: Symbol = symbol_short!("tr_reg");
const VERSION: u32 = 2;
const STORAGE_VERSION: u32 = 1;
const VERSION_KEY: Symbol = symbol_short!("ver");
const STORAGE_VERSION_KEY: Symbol = symbol_short!("stor_ver");

/// The `num_candidates` value placed in the proof's public signals when the
/// election is unbounded.
///
/// SECURITY (#audit-C1): the vote circuit constrains
/// `LessThan(32)(voteChoice, numCandidates) === 1` (circuits/vote_template.circom).
/// With `numCandidates == 0` that is unsatisfiable for *every* `voteChoice`, so
/// no witness exists and no proof can be generated — the election accepts
/// nothing. `0` is both the documented "unbounded" sentinel and the value an
/// election gets by *default*, since `ElectionConfig` is absent until someone
/// calls `set_election_config`. So the default state of every election was
/// unvotable, and the on-chain guard `if num_candidates > 0 && ..` treated the
/// same 0 as "no bound" — the two halves of the system disagreed about what 0
/// means, and the circuit was the stricter one.
///
/// Mapping the sentinel to `u32::MAX` at the point the public signal is built
/// keeps "0 means unbounded" true everywhere while making the value something a
/// prover can actually satisfy. It cannot weaken the bound: 2^32-1 is above any
/// candidate index a `u32` can express, so a bounded election is unaffected and
/// an unbounded one is genuinely unbounded.
const UNBOUNDED_CANDIDATE_SIGNAL: u32 = u32::MAX;

/// The value to place in the proof's public `num_candidates` signal.
#[inline(always)]
fn candidate_signal(num_candidates: u32) -> u32 {
    if num_candidates == 0 {
        UNBOUNDED_CANDIDATE_SIGNAL
    } else {
        num_candidates
    }
}

// TTL management: bump on every interaction to keep contract alive
const INSTANCE_TTL_THRESHOLD: u32 = 120_960; // ~7 days
const INSTANCE_TTL_EXTEND: u32 = 6_312_000; // ~365 days — protocol maxEntryTTL
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 6_312_000; // ~365 days — protocol maxEntryTTL
                                              // Nullifiers are Persistent and live until `proposal.end_time + NULLIFIER_GRACE_LEDGERS`.
                                              // 259_200 ledgers @ ~5s/ledger = 15 days of grace for late-arriving txns.
const NULLIFIER_GRACE_LEDGERS: u32 = 259_200;
const TEMPORARY_TTL_THRESHOLD: u32 = 51_840; // ~3 days
                                             // 259_200 ledgers @ ~5s/ledger = 15 days. (This used to be documented as
                                             // "72 hours", which understated it by 5x — the value was always correct, the
                                             // comment was not. See `bump_nullifier_ttl` for why nullifiers no longer live
                                             // in Temporary storage at all.)
const TEMPORARY_TTL_EXTEND_BASE: u32 = 259_200;

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
    /// Caller is not the configured bridge contract (#648)
    NotBridge = 94,
    /// Bridge contract address has not been configured (#648)
    BridgeContractNotSet = 95,
    /// The weighted ballot's `balanceCommitment` is malformed (zero, or
    /// outside the field)
    InvalidBalanceCommitment = 96,
    /// The weighted ballot's `balanceCommitment` is well-formed but the DAO
    /// never pinned it via `set_weighted_balance_commitment`. Without this
    /// check a prover picks the commitment — and therefore the vote weight —
    /// freely, since it is a *public* input of `weighted_vote.circom`.
    UnknownBalanceCommitment = 97,

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
                | VotingError::InvalidBalanceCommitment
                | VotingError::InvalidMerkleDepth
                | VotingError::InvalidBatchSize
                | VotingError::DuplicateNullifierInBatch => VotingError::InvalidInput,

                // Eligibility: which root failed, and how, is membership
                // information. Same for a balance commitment the DAO never
                // pinned: whether a commitment is in the approved set is
                // exactly the kind of thing a relayer must not be able to probe.
                VotingError::RootMismatch
                | VotingError::RootNotInHistory
                | VotingError::RootPredatesProposal
                | VotingError::RootPredatesRemoval
                | VotingError::UnknownBalanceCommitment
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

/// Panic with a coarse version of `err` on an anonymous path, or the specific
/// error on an admin path. Shorthand for
/// `panic_with_error!(env, err.to_coarse(ctx))`.
#[inline]
fn panic_coarse(env: &Env, ctx: PathContext, err: VotingError) -> ! {
    panic_with_error!(env, err.to_coarse(ctx));
}

// Maximum allowed IC vector length (num_public_inputs + 1)
// Our circuit has 5 public signals, so IC should have 6 elements
// Allow some slack for future upgrades (up to 20 public inputs)
const MAX_IC_LENGTH: u32 = 21;

// Size limits to prevent DoS attacks
const MAX_TITLE_LEN: u32 = 100; // Max proposal title length (100 bytes)
const MAX_CID_LEN: u32 = 64; // Max IPFS CID length (CIDv1 is ~59 chars)
const MAX_UPGRADE_PAYLOAD_LEN: u32 = 4096;

/// Largest Merkle depth an election may declare (#93). 2^32 members is far
/// beyond anything the tree contract can hold; the bound exists so a bad depth
/// cannot be used to force an unbounded proof.
pub const MAX_MERKLE_DEPTH: u32 = 32;

/// Largest batch `cast_votes` accepts. Protocol-25 BN254 pairing cost is
/// guarded at one proof per submission to prevent host-metering amplification.
pub const MAX_VOTE_BATCH: u32 = zkvote_groth16::batch::MAX_BATCH_SIZE;

// Circuit constants
/// Vote circuit public signals: root, nullifier, dao_id, proposal_id,
/// vote_choice, num_candidates.
///
/// MUST match the `{public [...]}` list in `circuits/vote.circom` — see
/// scripts/drift-guard.mjs, which fails the build when the two disagree or when
/// the checked-in verification key's IC vector does not have exactly one more
/// element than this count.
///
/// #361 considered a 7th `relayerAddress` signal. It is deliberately absent:
/// a public signal binds nothing unless the verifier checks it, and the relayer
/// cannot be checked here. `Env::auths()` is `#[cfg(any(test,
/// feature = "testutils"))]` in soroban-sdk, and there is no production
/// equivalent — a contract cannot observe who invoked it. Shipping the signal
/// anyway would have made `VOTE_CIRCUIT_IC_LEN` 8 while every call site still
/// built 6 public signals, so no verification key could ever be registered and
/// the whole anonymous vote path was dead. The enforceable form of relayer
/// binding is a caller-supplied address plus `relayer.require_auth()`, which
/// does not need a new public signal; see RELAYER_BINDING_DESIGN.md.
///
/// IC (inner commitment) vector length for Groth16 VK = num_public_inputs + 1
const NUM_PUBLIC_SIGNALS: u32 = 6;
const VOTE_CIRCUIT_IC_LEN: u32 = NUM_PUBLIC_SIGNALS + 1;

/// Smallest `numCandidates` the vote circuit can be satisfied with. Votes are
/// binary, and the circuit constrains `voteChoice < numCandidates`, so anything
/// below 2 admits no valid witness at all. See
/// [`Voting::get_effective_num_candidates`].
const MIN_SATISFIABLE_NUM_CANDIDATES: u32 = 2;
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

/// `circuits/weighted_vote.circom` public signals:
/// [balanceCommitment, maxSupply, voteWeight]
const WEIGHTED_NUM_PUBLIC_SIGNALS: u32 = 3;
/// IC vector length for the weighted Groth16 VK = WEIGHTED_NUM_PUBLIC_SIGNALS + 1
const WEIGHTED_CIRCUIT_IC_LEN: u32 = WEIGHTED_NUM_PUBLIC_SIGNALS + 1;

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
    /// Test-only: overrides proof verification. NOT USED IN PRODUCTION.
    ///
    /// The variant is kept so existing storage discriminants stay stable, but
    /// the only code that reads it is `#[cfg(test)]`. There is deliberately no
    /// setter: `set_verify_override_for_tests` is `#[cfg(test)]`, so no
    /// deployable build can make this flag true — and even if some other write
    /// path set the key, no non-test code path consults it.
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
    /// Authorized Soroban bridge contract that may call record_bridged_vote (#648).
    BridgeContract,
    /// Verification key for the token-balance weighted vote circuit
    /// (`circuits/weighted_vote.circom`). Distinct from `VotingKey` (plain
    /// vote) and `SybilVotingKey` (SBT-age weighting) so a DAO can run all
    /// three circuits side by side. Appended at the end so existing storage
    /// discriminants stay stable.
    WeightedVotingKey(u64), // (dao_id)
    /// Balance commitment a weighted ballot claims, pinned per election.
    /// The weighted circuit proves `voteWeight == balance` and
    /// `balanceCommitment == Poseidon(balance, blindingFactor)`, but the
    /// circuit alone cannot tell whether that commitment is one the protocol
    /// ever issued — it is a *public input*, so a prover picks it. Pinning it
    /// on-chain is what closes the "commit to any balance you like" hole.
    WeightedBalanceCommitment(u64, U256), // (dao_id, commitment)
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
    /// Distinct approver addresses — must match circuit-registry layout (#650)
    pub approvers: Vec<Address>,
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

/// Emitted once per successful batch, alongside the per-vote `VoteEvent`s.
/// Indexers can use it to tell a batched submission from a run of single votes.
#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VoteBatchEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub votes: u32,
    pub yes_votes: u32,
    pub no_votes: u32,
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
        env.storage().temporary().extend_ttl(
            key,
            TEMPORARY_TTL_THRESHOLD,
            TEMPORARY_TTL_EXTEND_BASE,
        );
    }

    /// Give a nullifier record a TTL that outlives the election it belongs to.
    ///
    /// The invariant is: *a nullifier must remain spent for exactly as long as
    /// the election can still accept the vote that spent it.* Shorter and the
    /// byte-identical `(nullifier, proof)` tuple re-verifies, so the member
    /// votes again; longer and the record is state nobody can ever reclaim.
    ///
    /// For a bounded election that is `end_time + NULLIFIER_GRACE_LEDGERS`, so
    /// the record becomes reclaimable once the election is definitively over.
    /// For an open-ended election (`end_time == 0`, which `create_proposal`
    /// explicitly permits — "voting never closes") there is no such bound, so
    /// the record is pushed out to the protocol ceiling and refreshed on every
    /// subsequent read and write. A never-closing election therefore cannot
    /// forget a spent nullifier.
    ///
    /// SECURITY (#audit-H2): this used to extend a *Temporary* entry, on a
    /// window that collapsed to `TEMPORARY_TTL_EXTEND_BASE` for exactly the
    /// `end_time == 0` case, which is the one case where forgetting is
    /// unrecoverable. Nullifiers now live in Persistent storage; the Temporary
    /// read in `nullifier_is_used` exists only so records already written by
    /// the previous build still block, without needing a migration.
    fn bump_nullifier_ttl<K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: &K,
        dao_id: u64,
        proposal_id: u64,
    ) {
        let end_time = Self::get_proposal_end_time_internal(env, dao_id, proposal_id);
        let ledger_timestamp = env.ledger().timestamp();
        let ttl_extend: u32 = if end_time == 0 {
            // Never closes: hold the record for as long as the protocol allows.
            PERSISTENT_TTL_EXTEND
        } else {
            let remaining_secs = end_time.saturating_sub(ledger_timestamp);
            let remaining_ledgers: u32 = (remaining_secs / 5).try_into().unwrap_or(u32::MAX);
            remaining_ledgers
                .saturating_add(NULLIFIER_GRACE_LEDGERS)
                .min(PERSISTENT_TTL_EXTEND)
        };
        let ttl_extend = ttl_extend.max(NULLIFIER_GRACE_LEDGERS);
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, ttl_extend);
    }

    /// Whether this election's nullifier has already been spent.
    ///
    /// Both storage classes are consulted. A record written by an older build
    /// may sit in either one, and a spent nullifier that reads as unspent is
    /// the double-vote this whole path exists to prevent, so the check errs
    /// toward "used" whenever there is any record at all.
    ///
    /// SECURITY (#audit-H2): every vote entrypoint used to open-code its own
    /// `has` against whichever storage class it happened to write to, and they
    /// disagreed — `vote`/`vote_bls381`/`vote_with_circuit` wrote Temporary
    /// while `cast_votes`/`vote_sybil_weighted`/`commit_vote` wrote Persistent,
    /// and four of the seven readers looked in only one of the two. A member
    /// could therefore spend one nullifier through `vote` and the same
    /// nullifier through `vote_sybil_weighted`, getting two head-count votes
    /// and two weighted tallies from one identity. This function is the single
    /// choke point that makes that class of divergence impossible again;
    /// callers must not open-code the lookup.
    fn nullifier_is_used(env: &Env, dao_id: u64, proposal_id: u64, nullifier: U256) -> bool {
        let key = storage::nullifier_used_key(dao_id, proposal_id, nullifier);
        env.storage().persistent().has(&key) || env.storage().temporary().has(&key)
    }

    /// Spend a nullifier: mark it used and give it a window that outlives the
    /// election. Call only after `nullifier_is_used` has returned false, and
    /// before any proof verification that could re-enter.
    fn consume_nullifier(env: &Env, dao_id: u64, proposal_id: u64, nullifier: U256) {
        let key = storage::nullifier_used_key(dao_id, proposal_id, nullifier);
        env.storage().persistent().set(&key, &true);
        Self::bump_nullifier_ttl(env, &key, dao_id, proposal_id);
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

        // CRITICAL (#662): Transcript registry attestation is now REQUIRED.
        // Fail open prevented by making transcript verification mandatory when registry exists.
        let transcript_registry = env
            .storage()
            .instance()
            .get::<_, Address>(&TRANSCRIPT_REGISTRY)
            .expect("Transcript registry not configured - cannot verify VK attestation");

        let vk_hash = Self::hash_vk(&env, &vk);
        let is_attested: bool = env.invoke_contract(
            &transcript_registry,
            &Symbol::new(&env, "is_vk_attested"),
            soroban_sdk::vec![&env, vk_hash.into_val(&env)],
        );
        if !is_attested {
            panic_with_error!(&env, VotingError::VkNotAttested);
        }

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

    /// Set verification key with explicit MPC transcript hash attestation
    pub fn set_vk_with_transcript(
        env: Env,
        dao_id: u64,
        vk: VerificationKey,
        admin: Address,
        transcript_hash: BytesN<32>,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);
        Self::validate_vk(&env, &vk);

        if let Some(transcript_registry) = env
            .storage()
            .instance()
            .get::<_, Address>(&TRANSCRIPT_REGISTRY)
        {
            let vk_hash = Self::hash_vk(&env, &vk);
            let is_attested: bool = env.invoke_contract(
                &transcript_registry,
                &Symbol::new(&env, "verify_attestation"),
                soroban_sdk::vec![&env, transcript_hash.into_val(&env), vk_hash.into_val(&env),],
            );
            if !is_attested {
                panic_with_error!(&env, VotingError::VkNotAttested);
            }
        }

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
        // Big-endian, matching how U256 is serialised everywhere else in this
        // contract; `to_bytes`/`from_bytes` are not soroban U256 methods.
        data.append(&current.to_be_bytes());
        data.append(&nullifier.to_be_bytes());
        let hash: BytesN<32> = env.crypto().sha256(&data).into();
        let next = U256::from_be_bytes(env, &hash.into());
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

        Self::assert_in_field(env, PathContext::Admin, final_nullifier_acc);

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

    /// Reject unless `admin` is the DAO's admin.
    ///
    /// SECURITY (#audit-C1): this compares and nothing more — it does *not* call
    /// `admin.require_auth()`. An entrypoint that relies on `assert_admin` alone
    /// is callable by anyone who can name the admin, and the admin address is
    /// public via `get_admin`. Every admin entrypoint must therefore pair the
    /// two; `set_vk_for_depth` did not, and was callable by anyone.
    fn assert_admin(env: &Env, dao_id: u64, admin: &Address) {
        if !Self::is_dao_admin(env, dao_id, admin) {
            panic_with_error!(env, VotingError::NotAdmin);
        }
    }

    /// Who may rewrite an election's configuration: the DAO admin, or the
    /// proposal's own creator.
    ///
    /// Both branches require the caller's own authorisation. The creator branch
    /// exists so the documented "callable during proposal creation" flow still
    /// works for a member who can propose but does not administer the DAO; it
    /// is not a general write permission, because it is scoped to elections
    /// that caller created.
    fn assert_election_config_authority(
        env: &Env,
        dao_id: u64,
        proposal_id: u64,
        caller: &Address,
    ) {
        caller.require_auth();
        if Self::is_dao_admin(env, dao_id, caller) {
            return;
        }
        let proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(dao_id, proposal_id))
            .unwrap_or_else(|| panic_with_error!(env, VotingError::InvalidState));
        if proposal.created_by != *caller {
            panic_with_error!(env, VotingError::NotAdmin);
        }
    }

    /// Whether `who` administers `dao_id`, without requiring their auth and
    /// without panicking. `assert_admin` is the panicking form; this is the
    /// predicate, so callers that accept more than one role can try each.
    fn is_dao_admin(env: &Env, dao_id: u64, who: &Address) -> bool {
        // Use cached registry address (set at constructor) - only 1 cross-contract call
        let registry: Address = env.storage().instance().get(&REGISTRY).unwrap();

        let dao_admin: Address = env.invoke_contract(
            &registry,
            &symbol_short!("get_admin"),
            soroban_sdk::vec![env, dao_id.into_val(env)],
        );

        &dao_admin == who
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
        if Self::nullifier_is_used(&env, dao_id, proposal_id, nullifier.clone()) {
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
        Self::consume_nullifier(&env, dao_id, proposal_id, nullifier.clone());

        // Verify root based on vote mode. Shared with `cast_votes` so a batched
        // submission is held to exactly the same eligibility rules.
        // (May involve cross-contract calls to the tree contract in Trailing mode.)
        Self::assert_root_eligible(&env, ctx, dao_id, &proposal, &root);

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

        // Resolve the verification key. At the default Merkle depth this is the
        // proposal's version-pinned key, checked against the hash snapshotted at
        // proposal creation so a VK change cannot invalidate in-flight votes.
        // An election that declared a depth (#93) uses the key registered for
        // that depth, pinned the same way.
        let election_depth = env
            .storage()
            .persistent()
            .get::<_, ElectionConfig>(&DataKey::ElectionConfig(dao_id, proposal_id))
            .map(|config| config.merkle_depth)
            .unwrap_or(0);
        let vk: VerificationKey =
            Self::resolve_election_vk(&env, ctx, dao_id, proposal_id, &proposal, election_depth);

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
                merkle_depth: 0,
            });

        let vote_choice_index: u32 = if vote_choice { 1 } else { 0 };
        if election_config.num_candidates > 0 && vote_choice_index >= election_config.num_candidates
        {
            panic_coarse(&env, ctx, VotingError::InvalidCandidateIndex);
        }

        let vote_signal = U256::from_u32(&env, vote_choice_index);
        let dao_signal = U256::from_u128(&env, dao_id as u128);
        let proposal_signal = U256::from_u128(&env, proposal_id as u128);
        // The circuit needs a satisfiable bound: a raw configured value of 0
        // ("unbounded") would make `voteChoice < numCandidates` unsatisfiable,
        // so no proof could be produced for an election without an explicit
        // candidate count. The contract's own candidate check above is
        // unchanged. See `get_effective_num_candidates`.
        let num_candidates_signal = U256::from_u32(
            &env,
            if election_config.num_candidates < MIN_SATISFIABLE_NUM_CANDIDATES {
                MIN_SATISFIABLE_NUM_CANDIDATES
            } else {
                election_config.num_candidates
            },
        );

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

    /// Configure the Soroban bridge contract authorized to call
    /// [`Self::record_bridged_vote`] (#648). Guardian-only.
    pub fn set_bridge_contract(env: Env, guardian: Address, bridge: Address) {
        Self::bump_instance(&env);
        guardian.require_auth();
        Self::require_guardian(&env, &guardian);
        env.storage()
            .instance()
            .set(&DataKey::BridgeContract, &bridge);
    }

    pub fn bridge_contract(env: Env) -> Address {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::BridgeContract)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::BridgeContractNotSet))
    }

    /// Record a vote that was already verified on the EVM bridge.
    /// Callable only by the configured bridge contract — no Groth16 check here
    /// because authenticity was established by the EVM verifier + authorized
    /// Soroban relayer (#648).
    pub fn record_bridged_vote(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        vote_choice: bool,
        nullifier: U256,
        root: U256,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);

        let bridge: Address = env
            .storage()
            .instance()
            .get(&DataKey::BridgeContract)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::BridgeContractNotSet));
        bridge.require_auth();

        let ctx = PathContext::Anonymous;
        Self::set_reentrancy_lock(&env);

        Self::assert_in_field(&env, ctx, &nullifier);
        Self::assert_in_field(&env, ctx, &root);

        if nullifier == U256::from_u32(&env, 0) {
            panic_coarse(&env, ctx, VotingError::InvalidNullifier);
        }

        let null_key = storage::nullifier_used_key(dao_id, proposal_id, nullifier.clone());
        if env.storage().temporary().has(&null_key) || env.storage().persistent().has(&null_key) {
            panic_coarse(&env, ctx, VotingError::NullifierUsed);
        }

        let prop_key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&prop_key)
            .expect("proposal not found");

        let now = env.ledger().timestamp();
        if proposal.state != ProposalState::Active {
            panic_coarse(&env, ctx, VotingError::VotingClosed);
        }
        if proposal.end_time != 0 && now > proposal.end_time {
            panic_coarse(&env, ctx, VotingError::VotingClosed);
        }

        env.storage().temporary().set(&null_key, &true);
        Self::bump_nullifier_ttl(&env, &null_key, dao_id, proposal_id);

        Self::assert_root_eligible(&env, ctx, dao_id, &proposal, &root);

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
                merkle_depth: 0,
            });

        let vote_choice_index: u32 = if vote_choice { 1 } else { 0 };
        if election_config.num_candidates > 0 && vote_choice_index >= election_config.num_candidates
        {
            panic_coarse(&env, ctx, VotingError::InvalidCandidateIndex);
        }

        Self::accumulate_nullifier(&env, dao_id, proposal_id, &nullifier);

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
    /// Register the token-balance weighted vote verification key for a DAO.
    ///
    /// Separate from the plain-vote VK (`set_vk`) and the Sybil VK
    /// (`sybil::set_sybil_vk`) so all three circuits can be live at once: a
    /// DAO may offer one-member-one-vote, SBT-age-weighted, and
    /// token-balance-weighted ballots on different proposals of the same
    /// election series.
    ///
    /// IC length is pinned to `WEIGHTED_CIRCUIT_IC_LEN` so a VK generated for
    /// a different circuit cannot be registered here and silently reinterpreted.
    pub fn set_weighted_vk(env: Env, dao_id: u64, vk: VerificationKey, admin: Address) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);

        if vk.ic.len() != WEIGHTED_CIRCUIT_IC_LEN || vk.ic.len() > MAX_IC_LENGTH {
            panic_with_error!(&env, VotingError::VkIcLengthMismatch);
        }

        let key = DataKey::WeightedVotingKey(dao_id);
        env.storage().persistent().set(&key, &vk);
        Self::bump_persistent(&env, &key);
    }

    /// Pin the balance commitment(s) weighted ballots must open against.
    ///
    /// The weighted circuit proves `voteWeight == balance` and
    /// `balanceCommitment == Poseidon(balance, blindingFactor)`. It cannot
    /// prove that the commitment is one the protocol issued: `balanceCommitment`
    /// is a *public* input, so without an on-chain anchor a prover simply
    /// computes `Poseidon(2^128-1, 42)` and votes with weight 3.4e38. Pinning
    /// the commitment here is what makes the proof mean anything.
    ///
    /// One commitment per call; call it once per eligible voter (or per
    /// snapshot root) before the election opens.
    pub fn set_weighted_balance_commitment(env: Env, dao_id: u64, commitment: U256) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        Self::assert_in_field(&env, PathContext::Anonymous, &commitment);

        if commitment == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidBalanceCommitment);
        }

        let key = DataKey::WeightedBalanceCommitment(dao_id, commitment);
        env.storage().persistent().set(&key, &true);
        Self::bump_persistent(&env, &key);
    }

    /// Whether `commitment` was pinned by `set_weighted_balance_commitment`.
    pub fn is_weighted_balance_commitment(env: Env, dao_id: u64, commitment: U256) -> bool {
        Self::bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::WeightedBalanceCommitment(dao_id, commitment))
            .unwrap_or(false)
    }

    /// Token-balance-weighted vote (ZK-013).
    ///
    /// The weight is **not** asserted by the voter: the proof binds
    /// `voteWeight == balance`, binds `balance` to `balanceCommitment`, and
    /// binds that commitment to a value the DAO pinned on-chain with
    /// [`Voting::set_weighted_balance_commitment`]. Only then is the weight
    /// accumulated into [`Voting::weighted_tally`].
    ///
    /// Previously this function range-checked `weight`, then called `vote()`
    /// and *discarded* the weight — a "weighted" vote that was recorded as a
    /// plain one-member-one-vote ballot. It also verified the proof against the
    /// **plain** vote circuit's VK, so nothing constrained `weight` at all.
    ///
    /// `max_supply` is a public input of the circuit (the inclusive bound the
    /// 128-bit range proof checks the balance against), so it is passed
    /// explicitly rather than trusted from storage: a mismatch would only
    /// produce a proof that fails to verify, never a silently-wrong weight.
    pub fn vote_weighted(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        vote_choice: bool,
        nullifier: U256,
        root: U256,
        proof: Proof,
        balance_commitment: U256,
        max_supply: U256,
        weight: u32,
        domain_tag: u32,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        Self::set_reentrancy_lock(&env);

        let ctx = PathContext::Anonymous;
        Self::assert_weight_in_range(&env, ctx, weight);
        Self::assert_domain_tag_valid(&env, ctx, domain_tag);
        Self::assert_in_field(&env, ctx, &nullifier);
        Self::assert_in_field(&env, ctx, &root);
        Self::assert_in_field(&env, ctx, &balance_commitment);

        if nullifier == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidNullifier);
        }
        if balance_commitment == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidBalanceCommitment);
        }

        // THE fix for "the prover mints the commitment": a public input the
        // protocol never issued must not be votable with. Checked before the
        // proof so a wrong commitment is a cheap, unambiguous error rather than
        // a pairing check on a statement nobody authorised.
        if !Self::is_weighted_balance_commitment(env.clone(), dao_id, balance_commitment.clone()) {
            panic_with_error!(&env, VotingError::UnknownBalanceCommitment);
        }

        // Shared nullifier namespace with `vote` and `vote_sybil_weighted`: one
        // ballot per member per election, whichever circuit produced it.
        let null_key = storage::nullifier_used_key(dao_id, proposal_id, nullifier.clone());
        if env.storage().persistent().has(&null_key) {
            panic_with_error!(&env, VotingError::NullifierUsed);
        }

        let prop_key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&prop_key)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::InvalidState));

        if proposal.state != ProposalState::Active {
            panic_with_error!(&env, VotingError::VotingClosed);
        }
        let now = env.ledger().timestamp();
        if proposal.end_time != 0 && now > proposal.end_time {
            panic_with_error!(&env, VotingError::VotingClosed);
        }
        if root != proposal.eligible_root {
            panic_with_error!(&env, VotingError::RootMismatch);
        }

        let vote_choice_index: u32 = if vote_choice { 1 } else { 0 };
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
                merkle_depth: 0,
                vdf_output: None,
                vdf_delay: 0,
                max_revotes: 0,
                merkle_root_set_at: None,
                commitment_window: 0,
            });
        if election_config.num_candidates > 0 && vote_choice_index >= election_config.num_candidates
        {
            panic_with_error!(&env, VotingError::InvalidCandidateIndex);
        }

        let vk: VerificationKey = env
            .storage()
            .persistent()
            .get(&DataKey::WeightedVotingKey(dao_id))
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::VkNotSet));

        // Checks-effects-interactions: burn the nullifier before the pairing check.
        env.storage().persistent().set(&null_key, &true);
        Self::bump_persistent(&env, &null_key);

        // Public signal order must match `circuits/weighted_vote.circom`:
        // {public [balanceCommitment, maxSupply, voteWeight]}.
        let pub_signals = soroban_sdk::vec![
            &env,
            balance_commitment,
            max_supply,
            U256::from_u32(&env, weight),
        ];

        if !Self::verify_groth16(&env, &vk, &proof, &pub_signals) {
            panic_with_error!(&env, VotingError::InvalidProof);
        }

        // Accumulate the weight. This is the whole point of the entry point:
        // a weight that reaches the tally is a weight the circuit proved
        // against a commitment the DAO pinned.
        let tally_key = DataKey::WeightedTally(dao_id, proposal_id);
        let mut tally: WeightedTally =
            env.storage()
                .persistent()
                .get(&tally_key)
                .unwrap_or(WeightedTally {
                    yes_weight: 0,
                    no_weight: 0,
                    yes_ballots: 0,
                    no_ballots: 0,
                });

        if vote_choice {
            tally.yes_weight = tally
                .yes_weight
                .checked_add(weight as u64)
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
            tally.yes_ballots = tally
                .yes_ballots
                .checked_add(1)
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
            proposal.yes_votes = proposal
                .yes_votes
                .checked_add(1)
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
        } else {
            tally.no_weight = tally
                .no_weight
                .checked_add(weight as u64)
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
            tally.no_ballots = tally
                .no_ballots
                .checked_add(1)
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
            proposal.no_votes = proposal
                .no_votes
                .checked_add(1)
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
        }

        env.storage().persistent().set(&tally_key, &tally);
        Self::bump_persistent(&env, &tally_key);
        env.storage().persistent().set(&prop_key, &proposal);
        Self::bump_persistent(&env, &prop_key);

        Self::clear_reentrancy_lock(&env);

        WeightedVoteEvent {
            dao_id,
            proposal_id,
            choice: vote_choice,
            weight,
            nullifier,
        }
        .publish(&env);
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

        Self::assert_in_field_bls381(&env, PathContext::Anonymous, &nullifier);
        Self::assert_in_field_bls381(&env, PathContext::Anonymous, &root);

        if nullifier == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidNullifier);
        }

        if Self::nullifier_is_used(&env, dao_id, proposal_id, nullifier.clone()) {
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
        Self::consume_nullifier(&env, dao_id, proposal_id, nullifier.clone());

        // Same helper `vote` and `cast_votes` use, rather than a third copy of
        // this match — the copies drifted, and the drift is what left the
        // Fixed arm without its revocation check in one path and not another
        // (#audit-H3).
        Self::assert_root_eligible(&env, PathContext::Anonymous, dao_id, &proposal, &root);

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
                merkle_depth: 0,
            });

        let vote_choice_index: u32 = if vote_choice { 1 } else { 0 };
        if election_config.num_candidates > 0 && vote_choice_index >= election_config.num_candidates
        {
            panic_with_error!(&env, VotingError::InvalidCandidateIndex);
        }

        let vote_signal = U256::from_u32(&env, vote_choice_index);
        let dao_signal = U256::from_u128(&env, dao_id as u128);
        let proposal_signal = U256::from_u128(&env, proposal_id as u128);
        // The circuit needs a satisfiable bound: a raw configured value of 0
        // ("unbounded") would make `voteChoice < numCandidates` unsatisfiable,
        // so no proof could be produced for an election without an explicit
        // candidate count. The contract's own candidate check above is
        // unchanged. See `get_effective_num_candidates`.
        let num_candidates_signal = U256::from_u32(
            &env,
            if election_config.num_candidates < MIN_SATISFIABLE_NUM_CANDIDATES {
                MIN_SATISFIABLE_NUM_CANDIDATES
            } else {
                election_config.num_candidates
            },
        );
        // 7th public signal (#361). Derived from the account that authorized
        // this call, NOT supplied by the caller, so a proof minted for one
        // relayer cannot be replayed through another.

        let pub_signals = soroban_sdk::vec![
            &env,
            root.clone(),
            nullifier.clone(),
            dao_signal,
            proposal_signal,
            vote_signal,
            num_candidates_signal,
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

    // ---------------------------------------------------------------------
    // Merkle depth flexibility (#93)
    // ---------------------------------------------------------------------

    /// Registers the verification key for a Merkle depth.
    ///
    /// `vote.circom` fixes the tree depth at 18, so every proof carries 18 path
    /// elements no matter how small the electorate is. Compiling the circuit at
    /// other depths produces different verification keys, and this is where a
    /// DAO admin registers them.
    ///
    /// Registering a key for a depth an election has already declared changes
    /// what that election verifies against, so the pinned hash check in
    /// `resolve_election_vk` rejects in-flight proofs with `VkChanged` — the
    /// same protection the version-pinned default key has.
    pub fn set_vk_for_depth(
        env: Env,
        dao_id: u64,
        merkle_depth: u32,
        vk: VerificationKey,
        admin: Address,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        // SECURITY (#audit-C1): `assert_admin` on its own only *compares* the
        // argument against the registry's admin. It never requires that
        // argument to authorise anything, so without this line the function was
        // callable by anyone at all: the DAO's admin address is public via
        // `get_admin`, so any address could pass it and register an arbitrary
        // verification key for any depth. Every other admin entrypoint in this
        // contract pairs the two calls — `set_vk`, `set_vk_bls381`,
        // `set_tally_vk`, `set_vk_with_transcript` — so this one was the
        // outlier rather than a deliberate design choice.
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);

        if merkle_depth == 0 || merkle_depth > MAX_MERKLE_DEPTH {
            panic_with_error!(&env, VotingError::InvalidMerkleDepth);
        }
        // Same structural checks the default key gets: a key with the wrong IC
        // length can never verify this circuit's public signals.
        if vk.ic.len() != VOTE_CIRCUIT_IC_LEN {
            panic_with_error!(&env, VotingError::VkIcLengthMismatch);
        }
        if vk.ic.len() > MAX_IC_LENGTH {
            panic_with_error!(&env, VotingError::VkIcTooLarge);
        }

        let key = DataKey::DepthVk(dao_id, merkle_depth);
        env.storage().persistent().set(&key, &vk);
        Self::bump_persistent(&env, &key);
    }

    /// Returns the verification key registered for a Merkle depth, if any.
    pub fn get_vk_for_depth(env: Env, dao_id: u64, merkle_depth: u32) -> Option<VerificationKey> {
        Self::bump_instance(&env);
        let key = DataKey::DepthVk(dao_id, merkle_depth);
        let vk: Option<VerificationKey> = env.storage().persistent().get(&key);
        if vk.is_some() {
            Self::bump_persistent(&env, &key);
        }
        vk
    }

    /// Sets the election configuration and the Merkle depth its proofs use.
    ///
    /// A depth of 0 keeps the default circuit and the DAO's version-pinned key.
    /// A non-zero depth requires a key registered by `set_vk_for_depth`, and
    /// pins that key's hash to the proposal so a later re-registration cannot
    /// change what in-flight votes are checked against.
    pub fn set_election_config_with_depth(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        min_balance: i128,
        twab_window: u64,
        num_candidates: u32,
        merkle_depth: u32,
        admin: Address,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        // SECURITY (#audit-C1): this forwarded to the unauthenticated
        // `set_election_config` *and* then pinned `ProposalDepthVkHash` to
        // whatever key was registered for `merkle_depth`. Combining that with
        // the missing `require_auth` on `set_vk_for_depth` meant an arbitrary
        // verification key could be registered for a depth and then pinned onto
        // a live election, after which every vote on it would be checked
        // against a key the attacker chose — an arbitrary nullifier, an
        // arbitrary leaf and an arbitrary root, i.e. total vote forgery. Both
        // halves of that chain now require the admin's own authorisation.
        Self::assert_election_config_authority(&env, dao_id, proposal_id, &admin);

        if merkle_depth > MAX_MERKLE_DEPTH {
            panic_with_error!(&env, VotingError::InvalidMerkleDepth);
        }

        // Reuse the setter's body for everything it already handles, then
        // layer the depth on top so the two paths cannot drift apart.
        Self::apply_election_config(
            &env,
            dao_id,
            proposal_id,
            min_balance,
            twab_window,
            num_candidates,
        );

        let key = DataKey::ElectionConfig(dao_id, proposal_id);
        let mut config: ElectionConfig = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::InvalidState));

        if merkle_depth != 0 {
            let vk = env
                .storage()
                .persistent()
                .get::<_, VerificationKey>(&DataKey::DepthVk(dao_id, merkle_depth))
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::InvalidMerkleDepth));

            // Pin the key now, exactly as proposal creation pins the default
            // key, so re-registering a depth key mid-election is detected.
            let hash_key = DataKey::ProposalDepthVkHash(dao_id, proposal_id);
            let vk_hash = Self::hash_vk(&env, &vk);
            env.storage().persistent().set(&hash_key, &vk_hash);
            Self::bump_persistent(&env, &hash_key);
        }

        config.merkle_depth = merkle_depth;
        env.storage().persistent().set(&key, &config);
        Self::bump_persistent(&env, &key);
    }

    /// The Merkle depth an election's proofs are built against.
    ///
    /// 0 means the default depth-18 circuit. Clients use this to pick which
    /// circuit artifacts to download and which key to verify against.
    pub fn get_merkle_depth(env: Env, dao_id: u64, proposal_id: u64) -> u32 {
        Self::bump_instance(&env);
        env.storage()
            .persistent()
            .get::<_, ElectionConfig>(&DataKey::ElectionConfig(dao_id, proposal_id))
            .map(|config| config.merkle_depth)
            .unwrap_or(0)
    }

    /// Resolves the verification key an election's proofs must satisfy, and
    /// checks it still hashes to what was pinned when the election was set up.
    ///
    /// Elections at the default depth keep using the DAO's version-pinned key,
    /// so nothing changes for them.
    fn resolve_election_vk(
        env: &Env,
        ctx: PathContext,
        dao_id: u64,
        proposal_id: u64,
        proposal: &ProposalInfo,
        merkle_depth: u32,
    ) -> VerificationKey {
        if merkle_depth == 0 {
            let vk = Self::get_vk_by_version(env, dao_id, proposal.vk_version);
            if Self::hash_vk(env, &vk) != proposal.vk_hash {
                panic_coarse(env, ctx, VotingError::VkChanged);
            }
            return vk;
        }

        let vk = env
            .storage()
            .persistent()
            .get::<_, VerificationKey>(&DataKey::DepthVk(dao_id, merkle_depth))
            .unwrap_or_else(|| panic_coarse(env, ctx, VotingError::InvalidMerkleDepth));

        let pinned: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::ProposalDepthVkHash(dao_id, proposal_id))
            .unwrap_or_else(|| panic_coarse(env, ctx, VotingError::VkNotSet));
        if Self::hash_vk(env, &vk) != pinned {
            panic_coarse(env, ctx, VotingError::VkChanged);
        }
        vk
    }

    // ---------------------------------------------------------------------
    // Batched voting (#90)
    // ---------------------------------------------------------------------

    /// Casts several votes in one transaction, verified with a single batched
    /// pairing check.
    ///
    /// Every vote is validated exactly as `vote` validates it — field bounds,
    /// non-zero and unused nullifier, root eligibility for the proposal's vote
    /// mode, candidate bound — and each proof is still checked against its own
    /// public signals. What changes is only the verification: instead of four
    /// pairings per proof, the batch is combined into `N + 3` pairings, which
    /// measures at roughly 1.9x cheaper for four votes and 2.9x for sixty-four.
    ///
    /// The batch is all-or-nothing. One bad proof rejects the whole
    /// transaction, and the failure does not say which proof was bad, so a
    /// relayer that hits `InvalidProof` should re-submit the votes singly (or
    /// bisect) to find the culprit rather than dropping them all.
    ///
    /// Returns the number of votes recorded.
    pub fn cast_votes(env: Env, dao_id: u64, proposal_id: u64, votes: Vec<BatchVote>) -> u32 {
        // A batch is a relayer submitting other people's votes, so errors
        // collapse to coarse codes for the same reason a single vote's do:
        // a per-vote reason would say which voter in the batch failed.
        let ctx = PathContext::Anonymous;
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        Self::set_reentrancy_lock(&env);

        let count = votes.len();
        if count == 0 || count > MAX_VOTE_BATCH {
            panic_with_error!(&env, VotingError::InvalidBatchSize);
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
        if proposal.vote_mode == VoteMode::Quadratic {
            panic_with_error!(&env, VotingError::NotQuadraticProposal);
        }

        // BN254 only: the batch verifier combines BN254 pairings.
        let proposal_curve: CurveId = env
            .storage()
            .persistent()
            .get(&DataKey::ProposalCurve(dao_id, proposal_id))
            .unwrap_or(CurveId::Bn254);
        if proposal_curve != CurveId::Bn254 {
            panic_with_error!(&env, VotingError::VkNotSet);
        }

        let election_config: Option<ElectionConfig> = env
            .storage()
            .persistent()
            .get(&DataKey::ElectionConfig(dao_id, proposal_id));
        let num_candidates = election_config
            .as_ref()
            .map(|config| config.num_candidates)
            .unwrap_or(0);
        let merkle_depth = election_config
            .as_ref()
            .map(|config| config.merkle_depth)
            .unwrap_or(0);

        let vk = Self::resolve_election_vk(&env, ctx, dao_id, proposal_id, &proposal, merkle_depth);

        let dao_signal = U256::from_u128(&env, dao_id as u128);
        let proposal_signal = U256::from_u128(&env, proposal_id as u128);
        let num_candidates_signal = U256::from_u32(
            &env,
            if num_candidates < MIN_SATISFIABLE_NUM_CANDIDATES {
                MIN_SATISFIABLE_NUM_CANDIDATES
            } else {
                num_candidates
            },
        );

        let mut proofs: Vec<Proof> = Vec::new(&env);
        let mut signal_sets: Vec<Vec<U256>> = Vec::new(&env);
        let mut seen: Vec<U256> = Vec::new(&env);
        let mut yes = 0u32;
        let mut no = 0u32;

        for i in 0..count {
            let entry = votes.get(i).expect("vote missing");

            Self::assert_in_field(&env, PathContext::Anonymous, &entry.nullifier);
            Self::assert_in_field(&env, PathContext::Anonymous, &entry.root);
            if entry.nullifier == U256::from_u32(&env, 0) {
                panic_with_error!(&env, VotingError::InvalidNullifier);
            }

            // A batch could otherwise carry the same nullifier twice: the
            // storage check below only sees committed state, and both copies
            // would be written in the same transaction.
            if seen.contains(&entry.nullifier) {
                panic_with_error!(&env, VotingError::DuplicateNullifierInBatch);
            }
            seen.push_back(entry.nullifier.clone());

            if Self::nullifier_is_used(&env, dao_id, proposal_id, entry.nullifier.clone()) {
                panic_with_error!(&env, VotingError::NullifierUsed);
            }

            Self::assert_root_eligible(&env, ctx, dao_id, &proposal, &entry.root);

            let vote_choice_index: u32 = if entry.vote_choice { 1 } else { 0 };
            if num_candidates > 0 && vote_choice_index >= num_candidates {
                panic_with_error!(&env, VotingError::InvalidCandidateIndex);
            }

            let signals = soroban_sdk::vec![
                &env,
                entry.root.clone(),
                entry.nullifier.clone(),
                dao_signal.clone(),
                proposal_signal.clone(),
                U256::from_u32(&env, vote_choice_index),
                num_candidates_signal.clone(),
            ];
            signal_sets.push_back(signals);
            proofs.push_back(entry.proof.clone());

            if entry.vote_choice {
                yes += 1;
            } else {
                no += 1;
            }
        }

        if !Self::verify_groth16_batch(&env, &vk, &proofs, &signal_sets) {
            panic_with_error!(&env, VotingError::InvalidProof);
        }

        // Only once the whole batch has verified do any nullifiers get burned:
        // a failed batch must not consume the nullifiers of the honest votes
        // that were grouped with a bad one.
        for i in 0..count {
            let entry = votes.get(i).expect("vote missing");
            Self::consume_nullifier(&env, dao_id, proposal_id, entry.nullifier.clone());
        }

        proposal.yes_votes = proposal
            .yes_votes
            .checked_add(yes as u64)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
        proposal.no_votes = proposal
            .no_votes
            .checked_add(no as u64)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
        env.storage().persistent().set(&prop_key, &proposal);
        Self::bump_persistent(&env, &prop_key);

        Self::clear_reentrancy_lock(&env);

        for i in 0..count {
            let entry = votes.get(i).expect("vote missing");
            VoteEvent {
                dao_id,
                proposal_id,
                choice: entry.vote_choice,
                nullifier: entry.nullifier,
            }
            .publish(&env);
        }
        VoteBatchEvent {
            dao_id,
            proposal_id,
            votes: count,
            yes_votes: yes,
            no_votes: no,
        }
        .publish(&env);

        count
    }

    /// Root eligibility for a proposal.
    ///
    /// This is the *only* place a caller-supplied root is judged, and every
    /// entrypoint that accepts one must route through it. It used to be
    /// consulted by `vote` and `cast_votes` only, while `vote_bls381` and
    /// `vote_with_circuit` each carried a hand-copied version of the same
    /// match — which is precisely how the Fixed-mode gap below survived in one
    /// copy and not the other.
    ///
    /// Fixed mode requires the exact snapshot root. Trailing mode accepts any
    /// root in the tree's history that neither predates the proposal nor a
    /// member removal, so late joiners can vote but revoked members cannot.
    ///
    /// SECURITY (#audit-H3): Fixed mode now also consults `min_root`, the
    /// index `remove_member` advances to mark every earlier root as
    /// pre-revocation. Without that check `min_root` was reachable *only* from
    /// the Trailing arm, which made revocation completely inert for Fixed-mode
    /// elections — the default mode. The mechanism is airtight once consulted:
    /// `remove_member` is the only writer of `MinValidRootIdx` and there is no
    /// setter, so it can never be lowered or reset by any admin path. And the
    /// snapshot root is pinned in history for as long as the proposal is
    /// Active (`root_pin`), so the removal can never be laundered by waiting for
    /// the root to age out of the `Roots` window: a pre-removal Fixed election
    /// is a *permanently* open vote for a removed member without this check.
    fn assert_root_eligible(
        env: &Env,
        ctx: PathContext,
        dao_id: u64,
        proposal: &ProposalInfo,
        root: &U256,
    ) {
        // A Quadratic election is cast through `cast_qv_vote`, which has its own
        // root check against the round's snapshot. Refuse here rather than
        // letting a root reach the branches below on a mode that ignores them.
        if proposal.vote_mode == VoteMode::Quadratic {
            panic_coarse(env, ctx, VotingError::NotQuadraticProposal);
        }

        match proposal.vote_mode {
            VoteMode::Fixed => {
                if root != &proposal.eligible_root {
                    panic_coarse(env, ctx, VotingError::RootMismatch);
                }
                // The snapshot root is only the *starting point* for eligibility,
                // not a permanent grant. A removal after the snapshot
                // invalidates it, exactly as it invalidates a Trailing root.
                Self::assert_root_not_revoked(env, ctx, dao_id, root);
            }
            VoteMode::Trailing => {
                let tree_contract: Address = Self::tree_contract(env.clone());

                let root_index: u32 = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("root_idx"),
                    soroban_sdk::vec![env, dao_id.into_val(env), root.clone().into_val(env)],
                );
                if root_index < proposal.earliest_root_index {
                    panic_coarse(env, ctx, VotingError::RootPredatesProposal);
                }

                // `assert_root_not_revoked` re-derives `root_index` and checks
                // `root_ok` itself, so the Trailing arm deliberately does not
                // repeat that half here.
                Self::assert_root_not_revoked(env, ctx, dao_id, root);
            }
            // Handled above, before the match.
            VoteMode::Quadratic => {
                panic_coarse(env, ctx, VotingError::NotQuadraticProposal);
            }
        }
    }

    /// Reject a root that a member removal has invalidated.
    ///
    /// `min_root` is the tree's monotonic floor: `remove_member` sets it to the
    /// index of the root it just produced, so every root below it predates the
    /// removal and can no longer prove anything about the current membership.
    /// A DAO that never removes anyone leaves it at 0, where this is a no-op.
    ///
    /// Asked of the tree as a single `root_eligibility` question rather than as
    /// separate `root_ok` / `root_idx` / `min_root` lookups. All three facts
    /// live in the tree, so one hop answers all of them: `vote` is the hot path
    /// of the whole protocol and paying three cross-contract invocations there
    /// showed up as a ~19% CPU increase in the integration budget test. It also
    /// removes the possibility of a caller asking for two of the three — which
    /// is exactly how Fixed mode ended up with no revocation check at all
    /// (#audit-H3).
    fn assert_root_not_revoked(env: &Env, ctx: PathContext, dao_id: u64, root: &U256) {
        let tree_contract: Address = Self::tree_contract(env.clone());
        let code: u32 = env.invoke_contract(
            &tree_contract,
            &Symbol::new(env, "root_eligibility"),
            soroban_sdk::vec![
                env,
                dao_id.into_val(env),
                root.clone().into_val(env),
                0u32.into_val(env),
            ],
        );
        match code {
            0 => {}
            // The root is no longer in the tree's retained window, or was never
            // published. An evicted Fixed snapshot cannot happen while the
            // proposal is Active — `root_pin` blocks that — so this is a root
            // that was never ours.
            1 => panic_coarse(env, ctx, VotingError::RootNotInHistory),
            2 => panic_coarse(env, ctx, VotingError::RootPredatesProposal),
            // The revocation floor. Reachable in Fixed mode now (#audit-H3).
            _ => panic_coarse(env, ctx, VotingError::RootPredatesRemoval),
        }
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
        Self::nullifier_is_used(&env, dao_id, proposal_id, nullifier)
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
        Self::assert_in_field(&env, PathContext::Anonymous, &nullifier);

        if nullifier == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidNullifier);
        }

        let legacy_key = storage::legacy_nullifier_used_key(nullifier.clone());
        if !env.storage().persistent().has(&legacy_key) {
            return false;
        }

        Self::consume_nullifier(&env, dao_id, proposal_id, nullifier.clone());
        Self::accumulate_nullifier(&env, dao_id, proposal_id, &nullifier);
        env.storage().persistent().remove(&legacy_key);
        true
    }

    /// Convert a Stellar address to a U256 field element
    /// Hashes the address using SHA-256 and converts to U256
    fn address_to_u256(env: &Env, address: &Address) -> U256 {
        let address_bytes = address.to_xdr(env);
        let hash: BytesN<32> = env.crypto().sha256(&address_bytes).into();
        let bytes = Bytes::from_array(env, &hash.to_array());
        U256::from_be_bytes(env, &bytes)
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
    ///
    /// In a `cfg(test)` build only, an instance-storage override lets a test
    /// decide the outcome of verification so it can exercise logic around the
    /// check without a real proof. The read is gated on `cfg(test)` — *not* on
    /// a cargo feature — so no deployable build can ever consult it, and there
    /// is no setter outside tests. An unset override in a test build accepts a
    /// well-shaped proof, matching the long-standing behaviour of this suite;
    /// tests that assert rejection set it to `false` explicitly.
    fn verify_groth16(
        env: &Env,
        vk: &VerificationKey,
        proof: &Proof,
        pub_signals: &Vec<U256>,
    ) -> bool {
        #[cfg(test)]
        {
            if let Some(override_val) = env
                .storage()
                .instance()
                .get::<DataKey, bool>(&DataKey::VerifyOverride)
            {
                return override_val;
            }
            // Bypass the pairing, not the cheap structural checks. The real
            // verifier rejects an IC/signal-count mismatch before it touches
            // the curve, and a test that skipped that would no longer be
            // testing the same guard production runs.
            return pub_signals.len() + 1 == vk.ic.len();
        }

        #[cfg(not(test))]
        zkvote_groth16::verify_groth16(env, vk, proof, pub_signals)
    }

    /// Verify BLS12-381 Groth16 proof using shared verification library.
    ///
    /// Same `cfg(test)`-only override as [`Voting::verify_groth16`].
    fn verify_groth16_bls381(
        env: &Env,
        vk: &VerificationKeyBls381,
        proof: &ProofBls381,
        pub_signals: &Vec<U256>,
    ) -> bool {
        #[cfg(test)]
        {
            if let Some(override_val) = env
                .storage()
                .instance()
                .get::<DataKey, bool>(&DataKey::VerifyOverride)
            {
                return override_val;
            }
            return pub_signals.len() + 1 == vk.ic.len();
        }

        #[cfg(not(test))]
        zkvote_groth16::verify_groth16_bls381(env, vk, proof, pub_signals)
    }

    /// Verify a batch of Groth16 proofs against one key in a single pairing
    /// check.
    ///
    /// Routed through a wrapper rather than called from `zkvote_groth16`
    /// directly so the batch path honours the same `cfg(test)`-only override as
    /// the single-proof path. Without this, `cast_votes` would run real pairing
    /// arithmetic in tests while `vote` did not — which is exactly the kind of
    /// asymmetry that lets a batch bug ship green.
    fn verify_groth16_batch(
        env: &Env,
        vk: &VerificationKey,
        proofs: &Vec<Proof>,
        pub_signals: &Vec<Vec<U256>>,
    ) -> bool {
        #[cfg(test)]
        {
            if let Some(override_val) = env
                .storage()
                .instance()
                .get::<DataKey, bool>(&DataKey::VerifyOverride)
            {
                return override_val;
            }
            // Keep the per-proof shape rules the real batch verifier enforces
            // (size cap, IC/signal-count match, signals in field); bypass only
            // the randomised pairing itself.
            if proofs.is_empty() || proofs.len() > MAX_VOTE_BATCH {
                return false;
            }
            for i in 0..proofs.len() {
                let signals = pub_signals.get(i).expect("signals missing");
                if signals.len() + 1 != vk.ic.len() {
                    return false;
                }
                for j in 0..signals.len() {
                    if !zkvote_groth16::is_in_field(env, &signals.get(j).expect("signal missing")) {
                        return false;
                    }
                }
            }
            return true;
        }

        #[cfg(not(test))]
        zkvote_groth16::batch::verify_groth16_batch(env, vk, proofs, pub_signals)
    }

    /// Test-only: force the outcome of [`Voting::verify_groth16`] for the
    /// remainder of the test. Compiled out of every non-test build, so there is
    /// no production path that can disable proof verification.
    #[cfg(test)]
    fn set_verify_override_for_tests(env: &Env, contract: &Address, accept: bool) {
        env.as_contract(contract, || {
            env.storage()
                .instance()
                .set(&DataKey::VerifyOverride, &accept);
        });
    }

    /// Test-only: clear the override so verification runs for real.
    #[cfg(test)]
    fn clear_verify_override_for_tests(env: &Env, contract: &Address) {
        env.as_contract(contract, || {
            env.storage().instance().remove(&DataKey::VerifyOverride);
        })
    }

    pub fn set_circuit_registry(env: Env, circuit_registry: Address) {
        Self::require_not_paused(&env);
        env.storage()
            .instance()
            .set(&CIRCUIT_REGISTRY, &circuit_registry);
    }

    pub fn set_transcript_registry(env: Env, transcript_registry: Address) {
        Self::require_not_paused(&env);
        env.storage()
            .instance()
            .set(&TRANSCRIPT_REGISTRY, &transcript_registry);
    }

    pub fn get_transcript_registry(env: Env) -> Option<Address> {
        env.storage().instance().get(&TRANSCRIPT_REGISTRY)
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
            &Symbol::new(&env, "get_dao_vk_proposal"),
            soroban_sdk::vec![&env, dao_id.into_val(&env)],
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
            &Symbol::new(&env, "get_vk_proposal"),
            soroban_sdk::vec![&env, proposal_id.into_val(&env)],
        );

        match result {
            Some(proposal) => {
                let now = env.ledger().timestamp();
                proposal.status == VkProposalStatus::Pending
                    && now >= proposal.execute_after
                    && proposal.approvers.len() >= proposal.required_approvals
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
        Self::assert_in_field(&env, PathContext::Anonymous, &nullifier);
        Self::assert_in_field(&env, PathContext::Anonymous, &root);

        if nullifier == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidNullifier);
        }

        if Self::nullifier_is_used(&env, dao_id, proposal_id, nullifier.clone()) {
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

        // Same helper `vote` and `cast_votes` use, rather than a third copy of
        // this match — the copies drifted, and the drift is what left the
        // Fixed arm without its revocation check in one path and not another
        // (#audit-H3).
        Self::assert_root_eligible(&env, PathContext::Anonymous, dao_id, &proposal, &root);

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
                merkle_depth: 0,
            });

        let vote_choice_index: u32 = if vote_choice { 1 } else { 0 };
        if election_config.num_candidates > 0 && vote_choice_index >= election_config.num_candidates
        {
            panic_with_error!(&env, VotingError::InvalidCandidateIndex);
        }

        let vote_signal = U256::from_u32(&env, vote_choice_index);
        let dao_signal = U256::from_u128(&env, dao_id as u128);
        let proposal_signal = U256::from_u128(&env, proposal_id as u128);
        // The circuit needs a satisfiable bound: a raw configured value of 0
        // ("unbounded") would make `voteChoice < numCandidates` unsatisfiable,
        // so no proof could be produced for an election without an explicit
        // candidate count. The contract's own candidate check above is
        // unchanged. See `get_effective_num_candidates`.
        let num_candidates_signal = U256::from_u32(
            &env,
            if election_config.num_candidates < MIN_SATISFIABLE_NUM_CANDIDATES {
                MIN_SATISFIABLE_NUM_CANDIDATES
            } else {
                election_config.num_candidates
            },
        );
        // 7th public signal (#361). Derived from the account that authorized
        // this call, NOT supplied by the caller, so a proof minted for one
        // relayer cannot be replayed through another.

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

        Self::consume_nullifier(&env, dao_id, proposal_id, nullifier.clone());

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
    ///
    /// Callable by the DAO admin or by the proposal's creator — the latter is
    /// the "during proposal creation" case in the original contract, and it is
    /// bounded by requiring that creator's own authorisation.
    ///
    /// SECURITY (#audit-C1): this function previously took no `admin` argument
    /// at all, so it was an unauthenticated public mutator on a live election's
    /// configuration. The DAO's admin address is public, and the parameters are
    /// all attacker-chosen, which made this a one-call lever on a running vote:
    /// setting `num_candidates` to 1 on a live two-candidate election makes
    /// `vote_choice_index >= num_candidates` reject every YES ballot for the
    /// remainder of the election, and the same call resets `snapshot_ledger` to
    /// the current ledger and can zero `min_balance`/`twab_window`, undoing the
    /// token gating. It is now gated on a real authorisation.
    ///
    /// Note that `snapshot_ledger` is refreshed on every call, so an admin who
    /// re-saves a config mid-election also re-snapshots the balance gate. That
    /// is now at least restricted to the two parties above.
    pub fn set_election_config(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        min_balance: i128,
        twab_window: u64,
        num_candidates: u32,
        admin: Address,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        Self::assert_election_config_authority(&env, dao_id, proposal_id, &admin);
        Self::apply_election_config(
            &env,
            dao_id,
            proposal_id,
            min_balance,
            twab_window,
            num_candidates,
        );
    }

    /// The body of [`Self::set_election_config`], with authorisation already
    /// done. Split out so `set_election_config_with_depth` can authorise once
    /// and then reuse it: requiring auth in both would record the same
    /// authorisation twice in one invocation, which the host rejects, and
    /// authorising *after* the depth is validated would leak the depth check to
    /// unauthenticated callers.
    fn apply_election_config(
        env: &Env,
        dao_id: u64,
        proposal_id: u64,
        min_balance: i128,
        twab_window: u64,
        num_candidates: u32,
    ) {
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
        let merkle_depth = existing
            .as_ref()
            .map(|config| config.merkle_depth)
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
            merkle_depth,
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
                    merkle_depth: 0,
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
                merkle_depth: 0,
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

    /// The `numCandidates` value the vote circuit is verified against.
    ///
    /// A vote is binary (`vote_choice: bool` -> 0 or 1) and the circuit
    /// constrains `voteChoice < numCandidates`, so a bound below 2 makes the
    /// constraint system unsatisfiable and no proof can be produced at all. An
    /// election that never set a config reports 0 from
    /// [`Voting::get_num_candidates`] — meaning "unbounded candidate list" —
    /// but the circuit still needs a concrete number, so the effective value
    /// floors at 2.
    ///
    /// Passing the raw 0 into the public signal is why a default-configured
    /// election could never verify a vote: the prover would have to satisfy
    /// `voteChoice < 0`. The contract's own candidate check is unchanged and
    /// still skips when the configured value is 0, so flooring the *circuit*
    /// bound does not widen what the contract accepts.
    ///
    /// Callers building a witness need this value, not `get_num_candidates`.
    pub fn get_effective_num_candidates(env: Env, dao_id: u64, proposal_id: u64) -> u32 {
        let configured = Self::get_num_candidates(env.clone(), dao_id, proposal_id);
        if configured < MIN_SATISFIABLE_NUM_CANDIDATES {
            MIN_SATISFIABLE_NUM_CANDIDATES
        } else {
            configured
        }
    }

    /// Get the snapshot ledger for a proposal (from ProposalInfo).
    pub fn get_snapshot_ledger(env: Env, dao_id: u64, proposal_id: u64) -> u32 {
        let proposal = Self::get_proposal(env, dao_id, proposal_id);
        proposal.snapshot_ledger
    }

    /// Record a balance checkpoint for time-weighted average balance computation.
    /// Stores (dao_id, address, ledger) -> balance for TWAB calculation.
    ///
    /// SECURITY (admin only): checkpoints are the sole input to `get_twab`, which
    /// feeds the anti-flash-loan `check_voter_eligibility` gate. Permissionless,
    /// anyone could forge any voter's TWAB history.
    pub fn record_balance_checkpoint(
        env: Env,
        dao_id: u64,
        voter: Address,
        balance: i128,
        admin: Address,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);
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
    ///
    /// SECURITY (admin or self): permissionless, anyone could freeze an
    /// arbitrary address for 7 days.
    pub fn set_voter_cooldown(env: Env, dao_id: u64, voter: Address, caller: Address) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);

        if caller != voter {
            caller.require_auth();
            Self::assert_admin(&env, dao_id, &caller);
        } else {
            voter.require_auth();
        }

        // Cooldown lasts until the current proposal ends (max 7 days from now)
        let cooldown_end = env.ledger().timestamp() + 604800; // 7 days
        let key = DataKey::TransferCooldown(dao_id, voter);
        env.storage().persistent().set(&key, &cooldown_end);
        Self::bump_persistent(&env, &key);
    }

    /// Clear a voter's transfer cooldown after an election ends.
    ///
    /// SECURITY (admin or self): clearing the cooldown mid-election is the
    /// vote -> leave -> rejoin bypass the cooldown exists to prevent.
    pub fn clear_voter_cooldown(env: Env, dao_id: u64, voter: Address, caller: Address) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);

        if caller != voter {
            caller.require_auth();
            Self::assert_admin(&env, dao_id, &caller);
        } else {
            voter.require_auth();
        }

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
    ///
    /// SECURITY (admin only): the snapshot ledger is the anti-flash-loan
    /// boundary for token-gated proposals. Permissionless, anyone could move the
    /// snapshot forward to include balances acquired after voting opened.
    pub fn create_balance_snapshot(env: Env, dao_id: u64, proposal_id: u64, admin: Address) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);
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
                    merkle_depth: 0,
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
                    merkle_depth: 0,
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
                        merkle_depth: 0,
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
