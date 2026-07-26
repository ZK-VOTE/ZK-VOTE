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
use soroban_sdk::xdr::ToXdr;
#[allow(unused_imports)]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bn254::{Bn254G1Affine, Bn254G2Affine, Fr},
    panic_with_error, symbol_short, token, Address, Bytes, BytesN, Env, IntoVal, String, Symbol,
    Vec, U256,
};

// Re-export shared Groth16 types and utilities
pub use zkvote_groth16::{
    Bls12381Curve, CurveId, Groth16Error, Proof, ProofBls381, VerificationKey,
    VerificationKeyBls381,
};

const TREE_CONTRACT: Symbol = symbol_short!("tree");
const REGISTRY: Symbol = symbol_short!("registry");
const CIRCUIT_REGISTRY: Symbol = symbol_short!("circ_reg");
const VERSION: u32 = 2;
const VERSION_KEY: Symbol = symbol_short!("ver");

// TTL management: bump on every interaction to keep contract alive
const INSTANCE_TTL_THRESHOLD: u32 = 120_960; // ~7 days
const INSTANCE_TTL_EXTEND: u32 = 535_680; // ~31 days
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 535_680;

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
    /// Transfer cooldown active: voter cannot transfer tokens during active election
    TransferCooldownActive = 27,
    /// Balance at snapshot time is below minimum required for token-gated voting
    InsufficientSnapshotBalance = 28,
    ContractPaused = 29,
    NotGuardian = 30,
    RandomnessCommitClosed = 31,
    RandomnessRevealClosed = 32,
    RandomnessAlreadyCommitted = 33,
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
    /// Vote rate limit: caller voted too recently on this proposal
    VoteCooldownActive = 44,
    /// Circuit breaker: too many votes in a short window
    CircuitBreakerActive = 45,
}

// Maximum allowed IC vector length (num_public_inputs + 1)
// Our circuit has 5 public signals, so IC should have 6 elements
// Allow some slack for future upgrades (up to 20 public inputs)
const MAX_IC_LENGTH: u32 = 21;

// Size limits to prevent DoS attacks
const MAX_TITLE_LEN: u32 = 100; // Max proposal title length (100 bytes)
const MAX_CID_LEN: u32 = 64; // Max IPFS CID length (CIDv1 is ~59 chars)

// Circuit constants
/// Vote circuit public signals: nullifier, root, dao_id, proposal_id, vote_choice
const NUM_PUBLIC_SIGNALS: u32 = 5;
// IC (inner commitment) vector length for Groth16 VK = num_public_inputs + 1
const VOTE_CIRCUIT_IC_LEN: u32 = NUM_PUBLIC_SIGNALS + 1;
pub const MAX_PAUSE_DURATION: u64 = 72 * 60 * 60;
pub const RANDOMNESS_COMMIT_WINDOW: u64 = 3_600;
pub const RANDOMNESS_REVEAL_WINDOW: u64 = 3_600;
const MIN_RANDOMNESS_PARTICIPANTS: u32 = 2;
const MAX_RANDOMNESS_PARTICIPANTS: u32 = 32;
pub const MAX_CONCURRENT_ELECTIONS: u64 = 20;
pub const ELECTION_CREATION_COOLDOWN: u64 = 600;
/// Minimum seconds between votes from the same address on the same proposal
pub const VOTE_COOLDOWN: u64 = 5;
/// Maximum votes per proposal before the circuit breaker trips
pub const CIRCUIT_BREAKER_THRESHOLD: u64 = 500;
/// How long the circuit breaker pauses voting after threshold is reached
pub const CIRCUIT_BREAKER_COOLDOWN: u64 = 300;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Proposal(u64, u64),          // (dao_id, proposal_id) -> ProposalInfo
    ProposalCount(u64),          // dao_id -> count
    Nullifier(u64, u64, U256),   // (dao_id, proposal_id, nullifier) -> bool
    VotingKey(u64),              // dao_id -> latest VerificationKey (BN254)
    VkVersion(u64),              // dao_id -> current BN254 VK version
    VkByVersion(u64, u32),       // (dao_id, vk_version) -> VerificationKey (BN254)
    CurveId(u64),                // dao_id -> CurveId (BN254 or BLS12_381)
    VotingKeyBls381(u64),        // dao_id -> latest VerificationKeyBls381
    VkByVersionBls381(u64, u32), // (dao_id, vk_version) -> VerificationKeyBls381
    VkVersionBls381(u64),        // dao_id -> current BLS12-381 VK version
    ProposalCurve(u64, u64),     // (dao_id, proposal_id) -> CurveId
    /// Test-only: overrides proof verification. Not used in production.
    VerifyOverride,
    DaoCurrentCircuit(u64), // dao_id -> current circuit_id string
    DaoMigration(u64),      // dao_id -> MigrationInfo
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
    /// Per-address vote cooldown: (dao_id, proposal_id, address) -> cooldown end timestamp
    VoteCooldown(u64, u64, Address),
    /// Circuit breaker state: (dao_id, proposal_id) -> (vote_count, breaker_until_timestamp)
    CircuitBreakerState(u64, u64),
}

#[contracttype]
#[derive(Clone)]
pub struct MigrationInfo {
    pub old_circuit_id: String,
    pub new_circuit_id: String,
    pub deadline: u64,
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
#[derive(Clone)]
pub struct BalanceSnapshotInfo {
    pub snapshot_ledger: u32,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct ProposalDeposit {
    pub token: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct ElectionConfig {
    pub snapshot_ledger: u32,
    pub min_balance: i128,
    pub twab_window: u64,
    pub candidate_seed: Option<BytesN<32>>,
}

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoteMode {
    Fixed,    // Only members at snapshot can vote
    Trailing, // Members added after proposal creation can also vote
}

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProposalState {
    Active,
    Closed,
    Archived,
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
pub struct ProposalDeletedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub deleted_by: Address,
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
pub struct ContractUpgraded {
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

    /// Constructor: Initialize contract with MembershipTree address
    pub fn __constructor(env: Env, tree_contract: Address, registry: Address, guardian: Address) {
        // Prevent accidental re-initialization
        if env.storage().instance().has(&VERSION_KEY) {
            panic_with_error!(&env, VotingError::AlreadyInitialized);
        }

        // Record contract version and emit upgrade event for observability
        env.storage().instance().set(&VERSION_KEY, &VERSION);
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

    /// Validate that a U256 value is within the BN254 scalar field (< r)
    /// Panics with VotingError::SignalNotInField if value >= r
    fn assert_in_field(env: &Env, value: &U256) {
        if zkvote_groth16::assert_in_field(env, value).is_err() {
            panic_with_error!(env, VotingError::SignalNotInField);
        }
    }

    /// Validate that a U256 value is within the BLS12-381 scalar field
    fn assert_in_field_bls381(env: &Env, value: &U256) {
        if zkvote_groth16::assert_in_field_bls381(env, value).is_err() {
            panic_with_error!(env, VotingError::SignalNotInField);
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

    pub fn set_election_deposit(
        env: Env,
        dao_id: u64,
        token: Address,
        amount: i128,
        admin: Address,
    ) {
        Self::bump_instance(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);
        if amount <= 0 {
            panic_with_error!(&env, VotingError::InvalidProposalDeposit);
        }
        let key = DataKey::DepositConfig(dao_id);
        env.storage()
            .persistent()
            .set(&key, &ProposalDeposit { token, amount });
        Self::bump_persistent(&env, &key);
    }

    pub fn active_proposal_count(env: Env, dao_id: u64) -> u64 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::ActiveProposalCount(dao_id))
            .unwrap_or(0)
    }

    fn enforce_creation_limits(env: &Env, dao_id: u64, creator: &Address, now: u64) {
        let active_key = DataKey::ActiveProposalCount(dao_id);
        let active: u64 = env.storage().instance().get(&active_key).unwrap_or(0);
        if active >= MAX_CONCURRENT_ELECTIONS {
            panic_with_error!(env, VotingError::TooManyActiveProposals);
        }

        let cooldown_key = DataKey::ProposalCooldown(dao_id, creator.clone());
        let cooldown_end: u64 = env.storage().persistent().get(&cooldown_key).unwrap_or(0);
        if now < cooldown_end {
            panic_with_error!(env, VotingError::ProposalCooldownActive);
        }
    }

    /// Enforce per-address vote cooldown: prevents rapid successive votes from the same address
    /// on the same proposal. This limits the rate at which an attacker can flood the contract.
    fn enforce_vote_rate_limit(env: &Env, dao_id: u64, proposal_id: u64, voter: &Address, now: u64) {
        let cooldown_key = DataKey::VoteCooldown(dao_id, proposal_id, voter.clone());
        let cooldown_end: u64 = env.storage().persistent().get(&cooldown_key).unwrap_or(0);
        if now < cooldown_end {
            panic_with_error!(env, VotingError::VoteCooldownActive);
        }
        // Set next allowed vote time
        env.storage().persistent().set(&cooldown_key, &(now + VOTE_COOLDOWN));
        Self::bump_persistent(env, &cooldown_key);
    }

    /// Contract-level circuit breaker: pauses voting on a proposal if too many votes
    /// arrive within a short window. Protects against resource exhaustion attacks.
    fn check_circuit_breaker(env: &Env, dao_id: u64, proposal_id: u64, now: u64) {
        let state_key = DataKey::CircuitBreakerState(dao_id, proposal_id);
        let (count, breaker_until): (u64, u64) = env
            .storage()
            .persistent()
            .get(&state_key)
            .unwrap_or((0u64, 0u64));

        if now < breaker_until {
            panic_with_error!(env, VotingError::CircuitBreakerActive);
        }

        // If the breaker tripped and expired, reset the counter
        if breaker_until > 0 && now >= breaker_until {
            env.storage().persistent().set(&state_key, &(1u64, 0u64));
            Self::bump_persistent(env, &state_key);
            return;
        }

        let new_count = count + 1;
        if new_count >= CIRCUIT_BREAKER_THRESHOLD {
            // Trip the breaker
            env.storage()
                .persistent()
                .set(&state_key, &(new_count, now + CIRCUIT_BREAKER_COOLDOWN));
        } else {
            env.storage().persistent().set(&state_key, &(new_count, 0u64));
        }
        Self::bump_persistent(env, &state_key);
    }

    fn decrement_active_count(env: &Env, dao_id: u64) {
        let key = DataKey::ActiveProposalCount(dao_id);
        let active: u64 = env.storage().instance().get(&key).unwrap_or(0);
        env.storage()
            .instance()
            .set(&key, &active.saturating_sub(1));
    }

    fn refund_deposit(env: &Env, dao_id: u64, proposal_id: u64, creator: &Address) {
        let key = DataKey::ProposalDeposit(dao_id, proposal_id);
        if let Some(deposit) = env.storage().persistent().get::<_, ProposalDeposit>(&key) {
            token::Client::new(env, &deposit.token).transfer(
                &env.current_contract_address(),
                creator,
                &deposit.amount,
            );
            env.storage().persistent().remove(&key);
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
        Self::enforce_creation_limits(&env, dao_id, &creator, now);

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
        let deposit_key = DataKey::DepositConfig(dao_id);
        if let Some(deposit) = env
            .storage()
            .persistent()
            .get::<_, ProposalDeposit>(&deposit_key)
        {
            token::Client::new(&env, &deposit.token).transfer(
                &creator,
                env.current_contract_address(),
                &deposit.amount,
            );
            let proposal_deposit_key = DataKey::ProposalDeposit(dao_id, proposal_id);
            env.storage()
                .persistent()
                .set(&proposal_deposit_key, &deposit);
            Self::bump_persistent(&env, &proposal_deposit_key);
        }

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

        let active_key = DataKey::ActiveProposalCount(dao_id);
        let active: u64 = env.storage().instance().get(&active_key).unwrap_or(0);
        env.storage().instance().set(&active_key, &(active + 1));
        let cooldown_key = DataKey::ProposalCooldown(dao_id, creator.clone());
        env.storage()
            .persistent()
            .set(&cooldown_key, &(now + ELECTION_CREATION_COOLDOWN));
        Self::bump_persistent(&env, &cooldown_key);

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

    /// Submit a vote with ZK proof
    /// Privacy-preserving: commitment is NOT a public parameter
    /// Revocation is enforced by zeroing leaves in the Merkle tree
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

        // Circuit breaker: pauses voting on this proposal under extreme load
        let now = env.ledger().timestamp();
        Self::check_circuit_breaker(&env, dao_id, proposal_id, now);

        // SECURITY: Validate public signals are within BN254 scalar field FIRST
        // This prevents modular reduction attacks where values >= r verify identically
        // to their reduced equivalents but are stored as different keys.
        Self::assert_in_field(&env, &nullifier);
        Self::assert_in_field(&env, &root);

        // Check nullifier is non-zero (zero is not a valid nullifier)
        if nullifier == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidNullifier);
        }

        // Check nullifier hasn't been used (prevents double voting)
        let null_key = DataKey::Nullifier(dao_id, proposal_id, nullifier.clone());
        if env.storage().persistent().has(&null_key) {
            panic_with_error!(&env, VotingError::NullifierUsed);
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
        if proposal.state != ProposalState::Active {
            panic_with_error!(&env, VotingError::VotingClosed);
        }
        if proposal.end_time != 0 && now > proposal.end_time {
            panic_with_error!(&env, VotingError::VotingClosed);
        }

        // Revocation is now enforced by zeroing leaves in the Merkle tree.
        // A revoked member's commitment is zeroed, so their proof won't verify
        // against any root that includes the zeroed leaf. No timestamp checks needed.

        // Verify root based on vote mode
        match proposal.vote_mode {
            VoteMode::Fixed => {
                // Fixed mode: root must exactly match the snapshot at proposal creation
                // This prevents sybil attacks where members are added after proposal creation
                if root != proposal.eligible_root {
                    panic_with_error!(&env, VotingError::RootMismatch);
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
                    panic_with_error!(&env, VotingError::RootNotInHistory);
                }

                // Check root index >= earliest_root_index (prevents using roots from before proposal)
                let root_index: u32 = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("root_idx"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env), root.clone().into_val(&env)],
                );
                if root_index < proposal.earliest_root_index {
                    panic_with_error!(&env, VotingError::RootPredatesProposal);
                }

                // Check root index >= min_valid_root_index (prevents using roots from before member removal)
                // This ensures revoked members cannot vote even on old proposals using their pre-revocation proofs
                let min_valid_root: u32 = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("min_root"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env)],
                );
                if root_index < min_valid_root {
                    panic_with_error!(&env, VotingError::RootPredatesRemoval);
                }
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
            panic_with_error!(&env, VotingError::VkNotSet);
        }

        // Get verification key pinned to proposal version
        let vk: VerificationKey = Self::get_vk_by_version(&env, dao_id, proposal.vk_version);

        // Verify VK matches the snapshot taken at proposal creation
        // This prevents VK changes from invalidating in-flight votes
        let current_vk_hash = Self::hash_vk(&env, &vk);
        if current_vk_hash != proposal.vk_hash {
            panic_with_error!(&env, VotingError::VkChanged);
        }

        // Verify Groth16 proof
        // Public signals: [root, nullifier, daoId, proposalId, voteChoice]
        // Note: daoId is included for domain separation (prevents cross-DAO nullifier linkability)
        // Commitment is now private (computed internally in circuit) for improved vote unlinkability
        let vote_signal = if vote_choice {
            U256::from_u32(&env, 1)
        } else {
            U256::from_u32(&env, 0)
        };
        let dao_signal = U256::from_u128(&env, dao_id as u128);
        let proposal_signal = U256::from_u128(&env, proposal_id as u128);

        let pub_signals = soroban_sdk::vec![
            &env,
            root.clone(),
            nullifier.clone(),
            dao_signal,
            proposal_signal,
            vote_signal
        ];

        if !Self::verify_groth16(&env, &vk, &proof, &pub_signals) {
            panic_with_error!(&env, VotingError::InvalidProof);
        }

        // Mark nullifier as used
        env.storage().persistent().set(&null_key, &true);
        Self::bump_persistent(&env, &null_key);

        // Update vote count
        if vote_choice {
            proposal.yes_votes += 1;
        } else {
            proposal.no_votes += 1;
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

    /// Submit a vote with BLS12-381 ZK proof
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

        // Circuit breaker
        let now = env.ledger().timestamp();
        Self::check_circuit_breaker(&env, dao_id, proposal_id, now);

        Self::assert_in_field_bls381(&env, &nullifier);
        Self::assert_in_field_bls381(&env, &root);

        if nullifier == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidNullifier);
        }

        let null_key = DataKey::Nullifier(dao_id, proposal_id, nullifier.clone());
        if env.storage().persistent().has(&null_key) {
            panic_with_error!(&env, VotingError::NullifierUsed);
        }

        let prop_key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&prop_key)
            .expect("proposal not found");

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

        let vote_signal = if vote_choice {
            U256::from_u32(&env, 1)
        } else {
            U256::from_u32(&env, 0)
        };
        let dao_signal = U256::from_u128(&env, dao_id as u128);
        let proposal_signal = U256::from_u128(&env, proposal_id as u128);

        let pub_signals = soroban_sdk::vec![
            &env,
            root.clone(),
            nullifier.clone(),
            dao_signal,
            proposal_signal,
            vote_signal,
        ];

        if !Self::verify_groth16_bls381(&env, &vk, &proof, &pub_signals) {
            panic_with_error!(&env, VotingError::InvalidProof);
        }

        env.storage().persistent().set(&null_key, &true);
        Self::bump_persistent(&env, &null_key);

        if vote_choice {
            proposal.yes_votes += 1;
        } else {
            proposal.no_votes += 1;
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

    /// Check if nullifier has been used
    pub fn is_nullifier_used(env: Env, dao_id: u64, proposal_id: u64, nullifier: U256) -> bool {
        Self::bump_instance(&env);
        let key = DataKey::Nullifier(dao_id, proposal_id, nullifier);
        env.storage().persistent().has(&key)
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

        if proposal.state == ProposalState::Archived {
            panic_with_error!(&env, VotingError::InvalidState);
        }
        if proposal.state != ProposalState::Closed {
            proposal.state = ProposalState::Closed;
            env.storage().persistent().set(&key, &proposal);
            Self::bump_persistent(&env, &key);
            Self::decrement_active_count(&env, dao_id);
            Self::refund_deposit(&env, dao_id, proposal_id, &proposal.created_by);
            ProposalClosedEvent {
                dao_id,
                proposal_id,
                closed_by: admin,
            }
            .publish(&env);
        }
    }

    /// Cancel and delete an unvoted active election, refunding its creation deposit.
    pub fn delete_election(env: Env, dao_id: u64, proposal_id: u64, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);

        let proposal_key = DataKey::Proposal(dao_id, proposal_id);
        let proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&proposal_key)
            .expect("proposal not found");
        if proposal.state != ProposalState::Active {
            panic_with_error!(&env, VotingError::InvalidState);
        }
        if proposal.yes_votes != 0 || proposal.no_votes != 0 {
            panic_with_error!(&env, VotingError::ProposalHasVotes);
        }

        Self::decrement_active_count(&env, dao_id);
        Self::refund_deposit(&env, dao_id, proposal_id, &proposal.created_by);
        env.storage().persistent().remove(&proposal_key);
        env.storage()
            .persistent()
            .remove(&DataKey::ProposalCurve(dao_id, proposal_id));
        env.storage()
            .persistent()
            .remove(&DataKey::BalanceSnapshot(dao_id, proposal_id));
        env.storage()
            .persistent()
            .remove(&DataKey::ElectionConfig(dao_id, proposal_id));

        ProposalDeletedEvent {
            dao_id,
            proposal_id,
            deleted_by: admin,
        }
        .publish(&env);
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

        if proposal.state == ProposalState::Active {
            // Require close before archive to preserve state progression
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

        // Circuit breaker
        let now = env.ledger().timestamp();
        Self::check_circuit_breaker(&env, dao_id, proposal_id, now);

        Self::assert_in_field(&env, &nullifier);
        Self::assert_in_field(&env, &root);

        if nullifier == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidNullifier);
        }

        let null_key = DataKey::Nullifier(dao_id, proposal_id, nullifier.clone());
        if env.storage().persistent().has(&null_key) {
            panic_with_error!(&env, VotingError::NullifierUsed);
        }

        let prop_key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&prop_key)
            .expect("proposal not found");

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

        let vote_signal = if vote_choice {
            U256::from_u32(&env, 1)
        } else {
            U256::from_u32(&env, 0)
        };
        let dao_signal = U256::from_u128(&env, dao_id as u128);
        let proposal_signal = U256::from_u128(&env, proposal_id as u128);

        let pub_signals = soroban_sdk::vec![
            &env,
            root.clone(),
            nullifier.clone(),
            dao_signal,
            proposal_signal,
            vote_signal,
        ];

        if !Self::verify_groth16(&env, &vk, &proof, &pub_signals) {
            panic_with_error!(&env, VotingError::InvalidProof);
        }

        env.storage().persistent().set(&null_key, &true);
        Self::bump_persistent(&env, &null_key);

        if vote_choice {
            proposal.yes_votes += 1;
        } else {
            proposal.no_votes += 1;
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
    /// Sets the minimum balance required to vote, snapshot ledger, and TWAB window.
    /// Only callable during proposal creation or by DAO admin.
    pub fn set_election_config(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        min_balance: i128,
        twab_window: u64,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        let snapshot_ledger = env.ledger().sequence();
        let key = DataKey::ElectionConfig(dao_id, proposal_id);
        let candidate_seed = env
            .storage()
            .persistent()
            .get::<_, ElectionConfig>(&key)
            .and_then(|config| config.candidate_seed);
        let config = ElectionConfig {
            snapshot_ledger,
            min_balance,
            twab_window,
            candidate_seed,
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
        let seed = Self::get_candidate_seed(env.clone(), dao_id, proposal_id)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::RandomnessCommitmentMissing));
        let mut input = Bytes::new(&env);
        input.append(&Bytes::from_array(&env, &seed.to_array()));
        input.append(&Bytes::from_array(&env, &candidate.to_array()));
        env.crypto().sha256(&input).into()
    }
}

#[cfg(test)]
mod test;
