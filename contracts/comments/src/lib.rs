//! # Anonymous Comments Contract
//!
//! This contract implements anonymous commenting for DAO proposals using Groth16
//! zero-knowledge proofs on the BN254 elliptic curve.
//!
//! This contract uses the SAME vote circuit as the voting contract. The key insight
//! is that nullifier uniqueness is a CONTRACT-level concern, not a circuit concern:
//! - Vote contract: enforces nullifier uniqueness (one vote per user per proposal)
//! - Comment contract: just verifies proof for membership (allows multiple comments)
//!
//! ## Public Signals (Vote Circuit - shared with voting contract)
//! [root, nullifier, daoId, proposalId, voteChoice] - 5 signals
//! Note: commitment is computed internally in the circuit (private input)
//!
//! The voteChoice signal is ignored for comments - we just verify membership.

#![no_std]
#![allow(clippy::too_many_arguments)]
#[allow(unused_imports)]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bn254::{Bn254G1Affine, Bn254G2Affine, Fr},
    panic_with_error, symbol_short, Address, Bytes, BytesN, Env, IntoVal, String, Symbol, Vec,
    U256,
};

// Re-export shared Groth16 types and utilities
pub use zkvote_groth16::{Groth16Error, Proof, VerificationKey};

const TREE_CONTRACT: Symbol = symbol_short!("tree");
const REGISTRY: Symbol = symbol_short!("registry");
const VERSION: u32 = 2;
const VERSION_KEY: Symbol = symbol_short!("ver");

// TTL management: bump on every interaction to keep contract alive
const INSTANCE_TTL_THRESHOLD: u32 = 120_960; // ~7 days
const INSTANCE_TTL_EXTEND: u32 = 535_680; // ~31 days
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 535_680;

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum CommentsError {
    NotAdmin = 1,
    Unauthorized = 19,
    NotDaoMember = 5,
    CommitmentRevoked = 9,
    RootNotInHistory = 12,
    InvalidProof = 15,
    ContractNotSet = 16,
    AlreadyInitialized = 18,
    CommentNotFound = 22,
    CommentDeleted = 23,
    NotCommentOwner = 24,
    InvalidParentComment = 25,
    CommentContentTooLong = 27,
    ProposalNotFound = 28,
    RootMismatch = 29,         // Fixed mode: root must match proposal snapshot
    RootPredatesProposal = 30, // Trailing mode: root is too old
    /// Public signal value >= BN254 scalar field modulus (invalid field element)
    SignalNotInField = 31,
    /// Nullifier is zero (invalid)
    InvalidNullifier = 32,
    /// Root predates member removal (invalid for Trailing mode after revocation)
    RootPredatesRemoval = 33,
}

/// Vote mode for proposal eligibility (mirrors voting contract)
#[contracttype]
#[derive(Clone, PartialEq)]
pub enum VoteMode {
    Fixed,    // Only members at snapshot can comment
    Trailing, // Members added after proposal creation can also comment
}

// Size limits
const MAX_CID_LEN: u32 = 64;
const MAX_REVISIONS: u32 = 50;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Comment(u64, u64, u64), // (dao_id, proposal_id, comment_id) -> CommentInfo
    CommentCount(u64, u64), // (dao_id, proposal_id) -> comment count
    CommentNullifier(u64, u64, U256), // (dao_id, proposal_id, nullifier) -> bool (for duplicate detection)
    CommitmentNonce(u64, u64, U256), // (dao_id, proposal_id, commitment) -> next nonce for this commitment
    VotingContract,                  // Address of voting contract for proposal lookups and VK
}

/// Who deleted a comment
pub const DELETED_BY_NONE: u32 = 0;
pub const DELETED_BY_USER: u32 = 1;
pub const DELETED_BY_ADMIN: u32 = 2;

/// Comment on a proposal
#[contracttype]
#[derive(Clone)]
pub struct CommentInfo {
    pub id: u64,
    pub dao_id: u64,
    pub proposal_id: u64,
    pub author: Option<Address>,
    pub content_cid: String,
    pub parent_id: Option<u64>,
    pub created_at: u64,
    pub updated_at: u64,
    pub revision_cids: Vec<String>,
    pub deleted: bool,
    pub deleted_by: u32,
    pub nullifier: Option<U256>,
    pub comment_nonce: Option<u64>, // For anonymous comments, tracks which nonce was used
}

// Events
#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct CommentCreatedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub comment_id: u64,
    pub is_anonymous: bool,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct CommentEditedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub comment_id: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct CommentDeletedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub comment_id: u64,
    pub deleted_by: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractUpgraded {
    pub from: u32,
    pub to: u32,
}

#[contract]
pub struct Comments;

#[contractimpl]
impl Comments {
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

    /// Constructor: Initialize contract with MembershipTree, Voting, and Registry contract addresses
    pub fn __constructor(
        env: Env,
        tree_contract: Address,
        voting_contract: Address,
        registry: Address,
    ) {
        if env.storage().instance().has(&VERSION_KEY) {
            panic_with_error!(&env, CommentsError::AlreadyInitialized);
        }

        env.storage().instance().set(&VERSION_KEY, &VERSION);
        ContractUpgraded {
            from: 0,
            to: VERSION,
        }
        .publish(&env);

        env.storage().instance().set(&TREE_CONTRACT, &tree_contract);
        env.storage()
            .instance()
            .set(&DataKey::VotingContract, &voting_contract);
        // Cache registry address to reduce cross-contract call chain from 3 to 1
        env.storage().instance().set(&REGISTRY, &registry);
    }

    /// Validate that a U256 value is within the BN254 scalar field (< r)
    /// Panics with CommentsError::SignalNotInField if value >= r
    fn assert_in_field(env: &Env, value: &U256) {
        if zkvote_groth16::assert_in_field(env, value).is_err() {
            panic_with_error!(env, CommentsError::SignalNotInField);
        }
    }

    /// Get VK from voting contract (single source of truth)
    fn get_vk_from_voting(env: &Env, dao_id: u64) -> VerificationKey {
        let voting_contract: Address = Self::voting_contract(env.clone());
        env.invoke_contract(
            &voting_contract,
            &symbol_short!("get_vk"),
            soroban_sdk::vec![env, dao_id.into_val(env)],
        )
    }

    /// Get proposal info from voting contract for eligibility checks
    /// Returns: (vote_mode, eligible_root, earliest_root_index)
    fn get_proposal_eligibility(env: &Env, dao_id: u64, proposal_id: u64) -> (VoteMode, U256, u32) {
        let voting_contract: Address = Self::voting_contract(env.clone());

        // Get vote_mode from proposal (returns VoteMode enum directly)
        let vote_mode: VoteMode = env.invoke_contract(
            &voting_contract,
            &Symbol::new(env, "get_vote_mode"),
            soroban_sdk::vec![env, dao_id.into_val(env), proposal_id.into_val(env)],
        );

        // Get eligible_root from proposal
        let eligible_root: U256 = env.invoke_contract(
            &voting_contract,
            &Symbol::new(env, "get_eligible_root"),
            soroban_sdk::vec![env, dao_id.into_val(env), proposal_id.into_val(env)],
        );

        // Get earliest_root_index from proposal
        let earliest_root_index: u32 = env.invoke_contract(
            &voting_contract,
            &Symbol::new(env, "get_earliest_idx"),
            soroban_sdk::vec![env, dao_id.into_val(env), proposal_id.into_val(env)],
        );

        (vote_mode, eligible_root, earliest_root_index)
    }

    /// Validate root matches proposal eligibility (Fixed vs Trailing mode)
    fn validate_root_eligibility(env: &Env, dao_id: u64, proposal_id: u64, root: &U256) {
        let (vote_mode, eligible_root, earliest_root_index) =
            Self::get_proposal_eligibility(env, dao_id, proposal_id);

        let tree_contract: Address = Self::tree_contract(env.clone());

        match vote_mode {
            VoteMode::Fixed => {
                // Fixed mode: root must exactly match the snapshot at proposal creation
                if root != &eligible_root {
                    panic_with_error!(env, CommentsError::RootMismatch);
                }
            }
            VoteMode::Trailing => {
                // Trailing mode: check root is in valid history
                let root_valid: bool = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("root_ok"),
                    soroban_sdk::vec![env, dao_id.into_val(env), root.clone().into_val(env)],
                );
                if !root_valid {
                    panic_with_error!(env, CommentsError::RootNotInHistory);
                }

                // Check root index >= earliest_root_index
                let root_index: u32 = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("root_idx"),
                    soroban_sdk::vec![env, dao_id.into_val(env), root.clone().into_val(env)],
                );
                if root_index < earliest_root_index {
                    panic_with_error!(env, CommentsError::RootPredatesProposal);
                }

                // SECURITY: Check root index >= min_valid_root_index
                // This prevents revoked members from commenting using pre-revocation roots
                let min_valid_root: u32 = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("min_root"),
                    soroban_sdk::vec![env, dao_id.into_val(env)],
                );
                if root_index < min_valid_root {
                    panic_with_error!(env, CommentsError::RootPredatesRemoval);
                }
            }
        }
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
            panic_with_error!(env, CommentsError::NotAdmin);
        }
    }

    /// Add a public comment (author is visible)
    pub fn add_comment(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        content_cid: String,
        parent_id: Option<u64>,
        author: Address,
    ) -> u64 {
        Self::bump_instance(&env);
        author.require_auth();

        if content_cid.len() > MAX_CID_LEN {
            panic_with_error!(&env, CommentsError::CommentContentTooLong);
        }

        // Check membership
        Self::assert_membership(&env, dao_id, &author);

        // Validate proposal exists (call voting contract)
        Self::assert_proposal_exists(&env, dao_id, proposal_id);

        // Validate parent exists if provided
        if let Some(pid) = parent_id {
            let parent_key = DataKey::Comment(dao_id, proposal_id, pid);
            if !env.storage().persistent().has(&parent_key) {
                panic_with_error!(&env, CommentsError::InvalidParentComment);
            }
        }

        let comment_id = Self::next_comment_id(&env, dao_id, proposal_id);
        let now = env.ledger().timestamp();

        let comment = CommentInfo {
            id: comment_id,
            dao_id,
            proposal_id,
            author: Some(author),
            content_cid,
            parent_id,
            created_at: now,
            updated_at: now,
            revision_cids: Vec::new(&env),
            deleted: false,
            deleted_by: DELETED_BY_NONE,
            nullifier: None,
            comment_nonce: None,
        };

        let key = DataKey::Comment(dao_id, proposal_id, comment_id);
        env.storage().persistent().set(&key, &comment);
        Self::bump_persistent(&env, &key);

        CommentCreatedEvent {
            dao_id,
            proposal_id,
            comment_id,
            is_anonymous: false,
        }
        .publish(&env);

        comment_id
    }

    /// Add an anonymous comment (requires ZK proof with vote circuit)
    /// Uses the same vote circuit as voting - just verifies membership without tracking nullifiers.
    /// This allows multiple comments from the same user (different from voting which enforces uniqueness).
    pub fn add_anonymous_comment(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        content_cid: String,
        parent_id: Option<u64>,
        nullifier: U256,
        root: U256,
        vote_choice: bool, // From vote circuit - we ignore the value, just verify the proof
        proof: Proof,
    ) -> u64 {
        Self::bump_instance(&env);
        // SECURITY: Validate public signals are within BN254 scalar field FIRST
        // This prevents modular reduction attacks where values >= r verify identically
        Self::assert_in_field(&env, &nullifier);
        Self::assert_in_field(&env, &root);

        // Check nullifier is non-zero
        if nullifier == U256::from_u32(&env, 0) {
            panic_with_error!(&env, CommentsError::InvalidNullifier);
        }

        if content_cid.len() > MAX_CID_LEN {
            panic_with_error!(&env, CommentsError::CommentContentTooLong);
        }

        // NOTE: We intentionally do NOT check nullifier uniqueness for comments!
        // This allows users to post multiple anonymous comments per proposal.
        // The nullifier is still stored with the comment for ownership verification (edit/delete).

        // Validate parent exists if provided
        if let Some(pid) = parent_id {
            let parent_key = DataKey::Comment(dao_id, proposal_id, pid);
            if !env.storage().persistent().has(&parent_key) {
                panic_with_error!(&env, CommentsError::InvalidParentComment);
            }
        }

        // Validate proposal exists
        Self::assert_proposal_exists(&env, dao_id, proposal_id);

        // Validate root eligibility (Fixed vs Trailing mode - matches voting contract logic)
        Self::validate_root_eligibility(&env, dao_id, proposal_id, &root);

        // Get VK from voting contract (single source of truth)
        let vk = Self::get_vk_from_voting(&env, dao_id);

        // Public signals: [root, nullifier, daoId, proposalId, voteChoice]
        // Same as vote circuit - we just ignore voteChoice value for comments
        // NOTE: commitment is computed internally in the circuit (private input)
        let dao_signal = U256::from_u128(&env, dao_id as u128);
        let proposal_signal = U256::from_u128(&env, proposal_id as u128);
        let choice_signal = if vote_choice {
            U256::from_u32(&env, 1)
        } else {
            U256::from_u32(&env, 0)
        };

        let pub_signals = soroban_sdk::vec![
            &env,
            root.clone(),
            nullifier.clone(),
            dao_signal,
            proposal_signal,
            choice_signal
        ];

        if !Self::verify_groth16(&env, &vk, &proof, &pub_signals) {
            panic_with_error!(&env, CommentsError::InvalidProof);
        }

        // No nullifier tracking for comments - allow unlimited comments per user

        let comment_id = Self::next_comment_id(&env, dao_id, proposal_id);
        let now = env.ledger().timestamp();

        let comment = CommentInfo {
            id: comment_id,
            dao_id,
            proposal_id,
            author: None,
            content_cid,
            parent_id,
            created_at: now,
            updated_at: now,
            revision_cids: Vec::new(&env),
            deleted: false,
            deleted_by: DELETED_BY_NONE,
            nullifier: Some(nullifier),
            comment_nonce: None, // No longer tracking nonce
        };

        let key = DataKey::Comment(dao_id, proposal_id, comment_id);
        env.storage().persistent().set(&key, &comment);
        Self::bump_persistent(&env, &key);

        CommentCreatedEvent {
            dao_id,
            proposal_id,
            comment_id,
            is_anonymous: true,
        }
        .publish(&env);

        comment_id
    }

    /// Edit a public comment (owner only)
    pub fn edit_comment(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        comment_id: u64,
        new_content_cid: String,
        author: Address,
    ) {
        Self::bump_instance(&env);
        author.require_auth();

        if new_content_cid.len() > MAX_CID_LEN {
            panic_with_error!(&env, CommentsError::CommentContentTooLong);
        }

        let key = DataKey::Comment(dao_id, proposal_id, comment_id);
        let mut comment: CommentInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, CommentsError::CommentNotFound));

        if comment.deleted {
            panic_with_error!(&env, CommentsError::CommentDeleted);
        }

        match &comment.author {
            Some(original_author) if original_author == &author => {}
            _ => panic_with_error!(&env, CommentsError::NotCommentOwner),
        }

        if comment.revision_cids.len() < MAX_REVISIONS {
            comment.revision_cids.push_back(comment.content_cid.clone());
        }

        comment.content_cid = new_content_cid;
        comment.updated_at = env.ledger().timestamp();

        env.storage().persistent().set(&key, &comment);
        Self::bump_persistent(&env, &key);

        CommentEditedEvent {
            dao_id,
            proposal_id,
            comment_id,
        }
        .publish(&env);
    }

    /// Edit an anonymous comment (requires proof with same nullifier)
    /// We verify the user owns the comment by checking the stored nullifier
    pub fn edit_anonymous_comment(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        comment_id: u64,
        new_content_cid: String,
        nullifier: U256,
        root: U256,
        vote_choice: bool, // From vote circuit - we ignore the value
        proof: Proof,
    ) {
        Self::bump_instance(&env);
        // SECURITY: Validate public signals are within BN254 scalar field FIRST
        Self::assert_in_field(&env, &nullifier);
        Self::assert_in_field(&env, &root);

        if new_content_cid.len() > MAX_CID_LEN {
            panic_with_error!(&env, CommentsError::CommentContentTooLong);
        }

        let key = DataKey::Comment(dao_id, proposal_id, comment_id);
        let mut comment: CommentInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, CommentsError::CommentNotFound));

        if comment.deleted {
            panic_with_error!(&env, CommentsError::CommentDeleted);
        }

        // Verify this is the same user by checking nullifier
        // The nullifier is derived from (secret, daoId, proposalId) - same for all comments on this proposal
        match &comment.nullifier {
            Some(original_nullifier) => {
                // For edits, we verify the proof produces the same nullifier
                if &nullifier != original_nullifier {
                    panic_with_error!(&env, CommentsError::NotCommentOwner);
                }
            }
            _ => panic_with_error!(&env, CommentsError::NotCommentOwner),
        }

        // Verify ZK proof using VK from voting contract
        let vk = Self::get_vk_from_voting(&env, dao_id);

        // Public signals: [root, nullifier, daoId, proposalId, voteChoice]
        // commitment is computed internally in the circuit (private input)
        let dao_signal = U256::from_u128(&env, dao_id as u128);
        let proposal_signal = U256::from_u128(&env, proposal_id as u128);
        let choice_signal = if vote_choice {
            U256::from_u32(&env, 1)
        } else {
            U256::from_u32(&env, 0)
        };

        let pub_signals = soroban_sdk::vec![
            &env,
            root.clone(),
            nullifier.clone(),
            dao_signal,
            proposal_signal,
            choice_signal
        ];

        if !Self::verify_groth16(&env, &vk, &proof, &pub_signals) {
            panic_with_error!(&env, CommentsError::InvalidProof);
        }

        if comment.revision_cids.len() < MAX_REVISIONS {
            comment.revision_cids.push_back(comment.content_cid.clone());
        }

        comment.content_cid = new_content_cid;
        comment.updated_at = env.ledger().timestamp();

        env.storage().persistent().set(&key, &comment);
        Self::bump_persistent(&env, &key);

        CommentEditedEvent {
            dao_id,
            proposal_id,
            comment_id,
        }
        .publish(&env);
    }

    /// Delete a public comment (owner only)
    pub fn delete_comment(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        comment_id: u64,
        author: Address,
    ) {
        Self::bump_instance(&env);
        author.require_auth();

        let key = DataKey::Comment(dao_id, proposal_id, comment_id);
        let mut comment: CommentInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, CommentsError::CommentNotFound));

        if comment.deleted {
            return;
        }

        match &comment.author {
            Some(original_author) if original_author == &author => {}
            _ => panic_with_error!(&env, CommentsError::NotCommentOwner),
        }

        comment.deleted = true;
        comment.deleted_by = DELETED_BY_USER;
        comment.updated_at = env.ledger().timestamp();

        env.storage().persistent().set(&key, &comment);
        Self::bump_persistent(&env, &key);

        CommentDeletedEvent {
            dao_id,
            proposal_id,
            comment_id,
            deleted_by: DELETED_BY_USER,
        }
        .publish(&env);
    }

    /// Delete an anonymous comment (requires proof)
    pub fn delete_anonymous_comment(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        comment_id: u64,
        nullifier: U256,
        root: U256,
        vote_choice: bool, // From vote circuit - we ignore the value
        proof: Proof,
    ) {
        Self::bump_instance(&env);
        // SECURITY: Validate public signals are within BN254 scalar field FIRST
        Self::assert_in_field(&env, &nullifier);
        Self::assert_in_field(&env, &root);

        let key = DataKey::Comment(dao_id, proposal_id, comment_id);
        let mut comment: CommentInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, CommentsError::CommentNotFound));

        if comment.deleted {
            return;
        }

        // Verify ownership via nullifier
        match &comment.nullifier {
            Some(original_nullifier) if original_nullifier == &nullifier => {}
            _ => panic_with_error!(&env, CommentsError::NotCommentOwner),
        }

        // Verify ZK proof using VK from voting contract
        let vk = Self::get_vk_from_voting(&env, dao_id);

        // Public signals: [root, nullifier, daoId, proposalId, voteChoice]
        // commitment is computed internally in the circuit (private input)
        let dao_signal = U256::from_u128(&env, dao_id as u128);
        let proposal_signal = U256::from_u128(&env, proposal_id as u128);
        let choice_signal = if vote_choice {
            U256::from_u32(&env, 1)
        } else {
            U256::from_u32(&env, 0)
        };

        let pub_signals = soroban_sdk::vec![
            &env,
            root.clone(),
            nullifier.clone(),
            dao_signal,
            proposal_signal,
            choice_signal
        ];

        if !Self::verify_groth16(&env, &vk, &proof, &pub_signals) {
            panic_with_error!(&env, CommentsError::InvalidProof);
        }

        comment.deleted = true;
        comment.deleted_by = DELETED_BY_USER;
        comment.updated_at = env.ledger().timestamp();

        env.storage().persistent().set(&key, &comment);
        Self::bump_persistent(&env, &key);

        CommentDeletedEvent {
            dao_id,
            proposal_id,
            comment_id,
            deleted_by: DELETED_BY_USER,
        }
        .publish(&env);
    }

    /// Admin delete any comment
    pub fn admin_delete_comment(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        comment_id: u64,
        admin: Address,
    ) {
        Self::bump_instance(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);

        let key = DataKey::Comment(dao_id, proposal_id, comment_id);
        let mut comment: CommentInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, CommentsError::CommentNotFound));

        if comment.deleted {
            return;
        }

        comment.deleted = true;
        comment.deleted_by = DELETED_BY_ADMIN;
        comment.updated_at = env.ledger().timestamp();

        env.storage().persistent().set(&key, &comment);
        Self::bump_persistent(&env, &key);

        CommentDeletedEvent {
            dao_id,
            proposal_id,
            comment_id,
            deleted_by: DELETED_BY_ADMIN,
        }
        .publish(&env);
    }

    /// Get a single comment
    pub fn get_comment(env: Env, dao_id: u64, proposal_id: u64, comment_id: u64) -> CommentInfo {
        Self::bump_instance(&env);
        let key = DataKey::Comment(dao_id, proposal_id, comment_id);
        let comment: CommentInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, CommentsError::CommentNotFound));
        Self::bump_persistent(&env, &key);
        comment
    }

    /// Get comment count for a proposal
    pub fn comment_count(env: Env, dao_id: u64, proposal_id: u64) -> u64 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::CommentCount(dao_id, proposal_id))
            .unwrap_or(0)
    }

    /// Get comments paginated
    pub fn get_comments(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        start_id: u64,
        limit: u64,
    ) -> Vec<CommentInfo> {
        Self::bump_instance(&env);
        let total = Self::comment_count(env.clone(), dao_id, proposal_id);
        let mut comments = Vec::new(&env);

        let end = if start_id + limit > total {
            total
        } else {
            start_id + limit
        };

        for i in start_id..end {
            let comment_id = i + 1;
            let key = DataKey::Comment(dao_id, proposal_id, comment_id);
            if let Some(comment) = env.storage().persistent().get::<DataKey, CommentInfo>(&key) {
                comments.push_back(comment);
            }
        }

        comments
    }

    /// Get tree contract address
    pub fn tree_contract(env: Env) -> Address {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&TREE_CONTRACT)
            .unwrap_or_else(|| panic_with_error!(&env, CommentsError::ContractNotSet))
    }

    /// Get voting contract address
    pub fn voting_contract(env: Env) -> Address {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::VotingContract)
            .unwrap_or_else(|| panic_with_error!(&env, CommentsError::ContractNotSet))
    }

    /// Get the next available comment nonce for a commitment on a proposal
    /// This is used by the relayer to tell users what nonce to use for their next anonymous comment
    pub fn get_comment_nonce(env: Env, dao_id: u64, proposal_id: u64, commitment: U256) -> u64 {
        Self::bump_instance(&env);
        let key = DataKey::CommitmentNonce(dao_id, proposal_id, commitment);
        let nonce: u64 = env.storage().persistent().get(&key).unwrap_or(0);
        if nonce > 0 {
            Self::bump_persistent(&env, &key);
        }
        nonce
    }

    /// Contract version
    pub fn version(env: Env) -> u32 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&VERSION_KEY)
            .unwrap_or(VERSION)
    }

    // Internal helpers

    fn next_comment_id(env: &Env, dao_id: u64, proposal_id: u64) -> u64 {
        let count_key = DataKey::CommentCount(dao_id, proposal_id);
        let count: u64 = env.storage().instance().get(&count_key).unwrap_or(0);
        let new_id = count + 1;
        env.storage().instance().set(&count_key, &new_id);
        new_id
    }

    fn assert_membership(env: &Env, dao_id: u64, member: &Address) {
        let tree_contract: Address = Self::tree_contract(env.clone());
        let sbt_contract: Address = env.invoke_contract(
            &tree_contract,
            &symbol_short!("sbt_contr"),
            soroban_sdk::vec![env],
        );

        let has_sbt: bool = env.invoke_contract(
            &sbt_contract,
            &symbol_short!("has"),
            soroban_sdk::vec![env, dao_id.into_val(env), member.clone().into_val(env)],
        );

        if !has_sbt {
            panic_with_error!(env, CommentsError::NotDaoMember);
        }
    }

    fn assert_proposal_exists(env: &Env, dao_id: u64, proposal_id: u64) {
        let voting_contract: Address = Self::voting_contract(env.clone());

        // Get proposal count - will panic if DAO doesn't exist in voting contract
        let count: u64 = env.invoke_contract(
            &voting_contract,
            &Symbol::new(env, "proposal_count"),
            soroban_sdk::vec![env, dao_id.into_val(env)],
        );

        // Check if proposal_id is within valid range
        if proposal_id == 0 || proposal_id > count {
            panic_with_error!(env, CommentsError::ProposalNotFound);
        }
    }

    /// Verify Groth16 proof using shared verification library.
    fn verify_groth16(
        env: &Env,
        vk: &VerificationKey,
        proof: &Proof,
        pub_signals: &Vec<U256>,
    ) -> bool {
        zkvote_groth16::verify_groth16(env, vk, proof, pub_signals)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    // ========================================================================
    // Mock Contracts
    // ========================================================================

    mod mock_tree {
        use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, U256};

        #[contracttype]
        pub enum DataKey {
            SbtContract,
            CurrentRoot(u64),
            RootValid(u64, U256),
            RootIndex(u64, U256),
            MinRoot(u64),
        }

        #[contract]
        pub struct MockTree;

        #[contractimpl]
        impl MockTree {
            pub fn set_sbt_contract(env: Env, sbt: Address) {
                env.storage().persistent().set(&DataKey::SbtContract, &sbt);
            }

            pub fn sbt_contr(env: Env) -> Address {
                env.storage()
                    .persistent()
                    .get(&DataKey::SbtContract)
                    .unwrap()
            }

            pub fn set_root(env: Env, dao_id: u64, root: U256) {
                env.storage()
                    .persistent()
                    .set(&DataKey::CurrentRoot(dao_id), &root);
                // Also mark this root as valid with index 0
                env.storage()
                    .persistent()
                    .set(&DataKey::RootValid(dao_id, root.clone()), &true);
                env.storage()
                    .persistent()
                    .set(&DataKey::RootIndex(dao_id, root), &0u32);
            }

            pub fn set_root_valid(env: Env, dao_id: u64, root: U256, valid: bool, index: u32) {
                env.storage()
                    .persistent()
                    .set(&DataKey::RootValid(dao_id, root.clone()), &valid);
                env.storage()
                    .persistent()
                    .set(&DataKey::RootIndex(dao_id, root), &index);
            }

            pub fn set_min_root(env: Env, dao_id: u64, min_root: u32) {
                env.storage()
                    .persistent()
                    .set(&DataKey::MinRoot(dao_id), &min_root);
            }

            pub fn root_ok(env: Env, dao_id: u64, root: U256) -> bool {
                env.storage()
                    .persistent()
                    .get(&DataKey::RootValid(dao_id, root))
                    .unwrap_or(false)
            }

            pub fn root_idx(env: Env, dao_id: u64, root: U256) -> u32 {
                env.storage()
                    .persistent()
                    .get(&DataKey::RootIndex(dao_id, root))
                    .unwrap_or(0)
            }

            pub fn min_root(env: Env, dao_id: u64) -> u32 {
                env.storage()
                    .persistent()
                    .get(&DataKey::MinRoot(dao_id))
                    .unwrap_or(0)
            }
        }
    }

    mod mock_sbt {
        use soroban_sdk::{
            contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol,
        };

        const REGISTRY: Symbol = symbol_short!("registry");

        #[contracttype]
        pub enum DataKey {
            Member(u64, Address),
        }

        #[contract]
        pub struct MockSbt;

        #[contractimpl]
        impl MockSbt {
            pub fn set_registry(env: Env, registry: Address) {
                env.storage().instance().set(&REGISTRY, &registry);
            }

            pub fn registry(env: Env) -> Address {
                env.storage().instance().get(&REGISTRY).unwrap()
            }

            pub fn set_member(env: Env, dao_id: u64, member: Address, has: bool) {
                let key = DataKey::Member(dao_id, member);
                env.storage().persistent().set(&key, &has);
            }

            pub fn has(env: Env, dao_id: u64, of: Address) -> bool {
                let key = DataKey::Member(dao_id, of);
                env.storage().persistent().get(&key).unwrap_or(false)
            }
        }
    }

    mod mock_registry {
        use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

        #[contracttype]
        pub enum DataKey {
            Admin(u64),
        }

        #[contract]
        pub struct MockRegistry;

        #[contractimpl]
        impl MockRegistry {
            pub fn set_admin(env: Env, dao_id: u64, admin: Address) {
                env.storage()
                    .persistent()
                    .set(&DataKey::Admin(dao_id), &admin);
            }

            pub fn get_admin(env: Env, dao_id: u64) -> Address {
                env.storage()
                    .persistent()
                    .get(&DataKey::Admin(dao_id))
                    .unwrap()
            }
        }
    }

    mod mock_voting {
        use soroban_sdk::{contract, contractimpl, contracttype, BytesN, Env, U256};

        use crate::{VerificationKey, VoteMode};

        #[contracttype]
        pub enum DataKey {
            VK(u64),
            ProposalCount(u64),
            VoteMode(u64, u64),
            EligibleRoot(u64, u64),
            EarliestRootIndex(u64, u64),
        }

        #[contract]
        pub struct MockVoting;

        #[contractimpl]
        impl MockVoting {
            pub fn set_vk(env: Env, dao_id: u64, vk: VerificationKey) {
                env.storage().persistent().set(&DataKey::VK(dao_id), &vk);
            }

            pub fn get_vk(env: Env, dao_id: u64) -> VerificationKey {
                env.storage()
                    .persistent()
                    .get(&DataKey::VK(dao_id))
                    .unwrap()
            }

            pub fn set_proposal_count(env: Env, dao_id: u64, count: u64) {
                env.storage()
                    .persistent()
                    .set(&DataKey::ProposalCount(dao_id), &count);
            }

            pub fn proposal_count(env: Env, dao_id: u64) -> u64 {
                env.storage()
                    .persistent()
                    .get(&DataKey::ProposalCount(dao_id))
                    .unwrap_or(0)
            }

            pub fn set_vote_mode(env: Env, dao_id: u64, proposal_id: u64, mode: VoteMode) {
                env.storage()
                    .persistent()
                    .set(&DataKey::VoteMode(dao_id, proposal_id), &mode);
            }

            pub fn get_vote_mode(env: Env, dao_id: u64, proposal_id: u64) -> VoteMode {
                env.storage()
                    .persistent()
                    .get(&DataKey::VoteMode(dao_id, proposal_id))
                    .unwrap_or(VoteMode::Fixed)
            }

            pub fn set_eligible_root(env: Env, dao_id: u64, proposal_id: u64, root: U256) {
                env.storage()
                    .persistent()
                    .set(&DataKey::EligibleRoot(dao_id, proposal_id), &root);
            }

            pub fn get_eligible_root(env: Env, dao_id: u64, proposal_id: u64) -> U256 {
                env.storage()
                    .persistent()
                    .get(&DataKey::EligibleRoot(dao_id, proposal_id))
                    .unwrap()
            }

            pub fn set_earliest_idx(env: Env, dao_id: u64, proposal_id: u64, idx: u32) {
                env.storage()
                    .persistent()
                    .set(&DataKey::EarliestRootIndex(dao_id, proposal_id), &idx);
            }

            pub fn get_earliest_idx(env: Env, dao_id: u64, proposal_id: u64) -> u32 {
                env.storage()
                    .persistent()
                    .get(&DataKey::EarliestRootIndex(dao_id, proposal_id))
                    .unwrap_or(0)
            }
        }

        // Helper to create dummy VK for tests
        pub fn create_dummy_vk(env: &Env) -> VerificationKey {
            let g1 = bn254_g1_generator(env);
            let g2 = bn254_g2_generator(env);
            VerificationKey {
                alpha: g1.clone(),
                beta: g2.clone(),
                gamma: g2.clone(),
                delta: g2.clone(),
                ic: soroban_sdk::vec![
                    env,
                    g1.clone(),
                    g1.clone(),
                    g1.clone(),
                    g1.clone(),
                    g1.clone(),
                    g1.clone()
                ],
            }
        }

        fn bn254_g1_generator(env: &Env) -> BytesN<64> {
            let mut bytes = [0u8; 64];
            bytes[31] = 1;
            bytes[63] = 2;
            BytesN::from_array(env, &bytes)
        }

        fn bn254_g2_generator(env: &Env) -> BytesN<128> {
            let bytes: [u8; 128] = [
                0x18, 0x00, 0x50, 0x6a, 0x06, 0x12, 0x86, 0xeb, 0x6a, 0x84, 0xa5, 0x73, 0x0b, 0x8f,
                0x10, 0x29, 0x3e, 0x29, 0x81, 0x6c, 0xd1, 0x91, 0x3d, 0x53, 0x38, 0xf7, 0x15, 0xde,
                0x3e, 0x98, 0xf9, 0xad, 0x19, 0x83, 0x90, 0x42, 0x11, 0xa5, 0x3f, 0x6e, 0x0b, 0x08,
                0x53, 0xa9, 0x0a, 0x00, 0xef, 0xbf, 0xf1, 0x70, 0x0c, 0x7b, 0x1d, 0xc0, 0x06, 0x32,
                0x4d, 0x85, 0x9d, 0x75, 0xe3, 0xca, 0xa5, 0xa2, 0x12, 0xc8, 0x5e, 0xa5, 0xdb, 0x8c,
                0x6d, 0xeb, 0x4a, 0xab, 0x71, 0x8e, 0x80, 0x6a, 0x51, 0xa5, 0x66, 0x08, 0x21, 0x4c,
                0x3f, 0x62, 0x8b, 0x96, 0x2c, 0xf1, 0x91, 0xea, 0xcd, 0xc8, 0x0e, 0x7a, 0x09, 0x0d,
                0x97, 0xc0, 0x9c, 0xe1, 0x48, 0x60, 0x63, 0xb3, 0x59, 0xf3, 0xdd, 0x89, 0xb7, 0xc4,
                0x3c, 0x5f, 0x18, 0x95, 0x8f, 0xb3, 0xe6, 0xb9, 0x6d, 0xb5, 0x5e, 0x19, 0xa3, 0xb7,
                0xc0, 0xfb,
            ];
            BytesN::from_array(env, &bytes)
        }
    }

    // ========================================================================
    // Test Setup Helpers
    // ========================================================================

    fn setup_env() -> (Env, Address, Address, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        // Register mock contracts
        let registry_id = env.register(mock_registry::MockRegistry, ());
        let sbt_id = env.register(mock_sbt::MockSbt, ());
        let tree_id = env.register(mock_tree::MockTree, ());
        let voting_id = env.register(mock_voting::MockVoting, ());
        // Pass registry to constructor (cached to reduce cross-contract calls)
        let comments_id = env.register(Comments, (&tree_id, &voting_id, &registry_id));

        // Link tree -> sbt
        let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
        tree_client.set_sbt_contract(&sbt_id);

        // Link sbt -> registry
        let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
        sbt_client.set_registry(&registry_id);

        let member = Address::generate(&env);

        (
            env,
            comments_id,
            voting_id,
            tree_id,
            sbt_id,
            registry_id,
            member,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn setup_dao_and_proposal(
        env: &Env,
        voting_id: &Address,
        tree_id: &Address,
        registry_id: &Address,
        admin: &Address,
        dao_id: u64,
        proposal_id: u64,
        vote_mode: VoteMode,
    ) -> U256 {
        let root = U256::from_u32(env, 12345);

        // Setup mock voting contract
        let voting_client = mock_voting::MockVotingClient::new(env, voting_id);
        voting_client.set_vk(&dao_id, &mock_voting::create_dummy_vk(env));
        voting_client.set_proposal_count(&dao_id, &proposal_id);
        voting_client.set_vote_mode(&dao_id, &proposal_id, &vote_mode);
        voting_client.set_eligible_root(&dao_id, &proposal_id, &root);
        voting_client.set_earliest_idx(&dao_id, &proposal_id, &0u32);

        // Setup mock tree contract
        let tree_client = mock_tree::MockTreeClient::new(env, tree_id);
        tree_client.set_root(&dao_id, &root);

        // Setup admin in registry
        let registry_client = mock_registry::MockRegistryClient::new(env, registry_id);
        registry_client.set_admin(&dao_id, admin);

        root
    }

    fn create_dummy_proof(env: &Env) -> Proof {
        let g1 = {
            let mut bytes = [0u8; 64];
            bytes[31] = 1;
            bytes[63] = 2;
            BytesN::from_array(env, &bytes)
        };
        let g2 = {
            let bytes: [u8; 128] = [
                0x18, 0x00, 0x50, 0x6a, 0x06, 0x12, 0x86, 0xeb, 0x6a, 0x84, 0xa5, 0x73, 0x0b, 0x8f,
                0x10, 0x29, 0x3e, 0x29, 0x81, 0x6c, 0xd1, 0x91, 0x3d, 0x53, 0x38, 0xf7, 0x15, 0xde,
                0x3e, 0x98, 0xf9, 0xad, 0x19, 0x83, 0x90, 0x42, 0x11, 0xa5, 0x3f, 0x6e, 0x0b, 0x08,
                0x53, 0xa9, 0x0a, 0x00, 0xef, 0xbf, 0xf1, 0x70, 0x0c, 0x7b, 0x1d, 0xc0, 0x06, 0x32,
                0x4d, 0x85, 0x9d, 0x75, 0xe3, 0xca, 0xa5, 0xa2, 0x12, 0xc8, 0x5e, 0xa5, 0xdb, 0x8c,
                0x6d, 0xeb, 0x4a, 0xab, 0x71, 0x8e, 0x80, 0x6a, 0x51, 0xa5, 0x66, 0x08, 0x21, 0x4c,
                0x3f, 0x62, 0x8b, 0x96, 0x2c, 0xf1, 0x91, 0xea, 0xcd, 0xc8, 0x0e, 0x7a, 0x09, 0x0d,
                0x97, 0xc0, 0x9c, 0xe1, 0x48, 0x60, 0x63, 0xb3, 0x59, 0xf3, 0xdd, 0x89, 0xb7, 0xc4,
                0x3c, 0x5f, 0x18, 0x95, 0x8f, 0xb3, 0xe6, 0xb9, 0x6d, 0xb5, 0x5e, 0x19, 0xa3, 0xb7,
                0xc0, 0xfb,
            ];
            BytesN::from_array(env, &bytes)
        };
        Proof {
            a: g1.clone(),
            b: g2,
            c: g1,
        }
    }

    /// BN254 scalar field modulus r (big-endian) for tests
    const BN254_FR_MODULUS_TEST: [u8; 32] = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58,
        0x5d, 0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00,
        0x00, 0x01,
    ];

    fn u256_from_be(env: &Env, bytes: &[u8; 32]) -> U256 {
        U256::from_be_bytes(env, &Bytes::from_array(env, bytes))
    }

    fn modulus_plus(env: &Env, offset: u8) -> U256 {
        let mut bytes = BN254_FR_MODULUS_TEST;
        let mut carry = offset as u16;
        for i in (0..32).rev() {
            let sum = bytes[i] as u16 + carry;
            bytes[i] = (sum & 0xFF) as u8;
            carry = sum >> 8;
            if carry == 0 {
                break;
            }
        }
        u256_from_be(env, &bytes)
    }

    // ========================================================================
    // Basic Tests
    // ========================================================================

    #[test]
    fn test_contract_creation() {
        let env = Env::default();
        let tree = Address::generate(&env);
        let voting = Address::generate(&env);
        let registry = Address::generate(&env);
        let contract = env.register(Comments, (&tree, &voting, &registry));
        let client = CommentsClient::new(&env, &contract);

        assert_eq!(client.tree_contract(), tree);
        assert_eq!(client.voting_contract(), voting);
    }

    #[test]
    fn test_add_public_comment() {
        let (env, comments_id, voting_id, tree_id, sbt_id, registry_id, member) = setup_env();
        let comments_client = CommentsClient::new(&env, &comments_id);
        let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);

        let dao_id = 1u64;
        let proposal_id = 1u64;
        let admin = Address::generate(&env);

        // Setup DAO and proposal
        setup_dao_and_proposal(
            &env,
            &voting_id,
            &tree_id,
            &registry_id,
            &admin,
            dao_id,
            proposal_id,
            VoteMode::Fixed,
        );

        // Give member SBT
        sbt_client.set_member(&dao_id, &member, &true);

        // Add comment
        let content_cid = String::from_str(&env, "QmTestComment123");
        let comment_id =
            comments_client.add_comment(&dao_id, &proposal_id, &content_cid, &None, &member);

        assert_eq!(comment_id, 1);
        assert_eq!(comments_client.comment_count(&dao_id, &proposal_id), 1);

        let comment = comments_client.get_comment(&dao_id, &proposal_id, &comment_id);
        assert_eq!(comment.author, Some(member));
        assert_eq!(comment.content_cid, content_cid);
        assert!(!comment.deleted);
        assert_eq!(comment.nullifier, None);
    }

    #[test]
    fn test_add_anonymous_comment() {
        let (env, comments_id, voting_id, tree_id, _sbt_id, registry_id, _member) = setup_env();
        let comments_client = CommentsClient::new(&env, &comments_id);

        let dao_id = 1u64;
        let proposal_id = 1u64;
        let admin = Address::generate(&env);

        // Setup DAO and proposal (Trailing mode to allow any valid root)
        let root = setup_dao_and_proposal(
            &env,
            &voting_id,
            &tree_id,
            &registry_id,
            &admin,
            dao_id,
            proposal_id,
            VoteMode::Trailing,
        );

        let content_cid = String::from_str(&env, "QmAnonComment");
        let nullifier = U256::from_u32(&env, 99999);
        let proof = create_dummy_proof(&env);

        // Add anonymous comment (verify_groth16 returns true in test mode)
        let comment_id = comments_client.add_anonymous_comment(
            &dao_id,
            &proposal_id,
            &content_cid,
            &None,
            &nullifier,
            &root,
            &true,
            &proof,
        );

        assert_eq!(comment_id, 1);

        let comment = comments_client.get_comment(&dao_id, &proposal_id, &comment_id);
        assert_eq!(comment.author, None);
        assert_eq!(comment.content_cid, content_cid);
        assert_eq!(comment.nullifier, Some(nullifier));
    }

    #[test]
    fn test_edit_public_comment() {
        let (env, comments_id, voting_id, tree_id, sbt_id, registry_id, member) = setup_env();
        let comments_client = CommentsClient::new(&env, &comments_id);
        let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);

        let dao_id = 1u64;
        let proposal_id = 1u64;
        let admin = Address::generate(&env);

        setup_dao_and_proposal(
            &env,
            &voting_id,
            &tree_id,
            &registry_id,
            &admin,
            dao_id,
            proposal_id,
            VoteMode::Fixed,
        );
        sbt_client.set_member(&dao_id, &member, &true);

        // Add comment
        let content_cid = String::from_str(&env, "QmOriginal");
        let comment_id =
            comments_client.add_comment(&dao_id, &proposal_id, &content_cid, &None, &member);

        // Edit comment
        let new_cid = String::from_str(&env, "QmEdited");
        comments_client.edit_comment(&dao_id, &proposal_id, &comment_id, &new_cid, &member);

        let comment = comments_client.get_comment(&dao_id, &proposal_id, &comment_id);
        assert_eq!(comment.content_cid, new_cid);
        assert_eq!(comment.revision_cids.len(), 1);
    }

    #[test]
    fn test_delete_public_comment() {
        let (env, comments_id, voting_id, tree_id, sbt_id, registry_id, member) = setup_env();
        let comments_client = CommentsClient::new(&env, &comments_id);
        let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);

        let dao_id = 1u64;
        let proposal_id = 1u64;
        let admin = Address::generate(&env);

        setup_dao_and_proposal(
            &env,
            &voting_id,
            &tree_id,
            &registry_id,
            &admin,
            dao_id,
            proposal_id,
            VoteMode::Fixed,
        );
        sbt_client.set_member(&dao_id, &member, &true);

        // Add comment
        let content_cid = String::from_str(&env, "QmToDelete");
        let comment_id =
            comments_client.add_comment(&dao_id, &proposal_id, &content_cid, &None, &member);

        // Delete comment
        comments_client.delete_comment(&dao_id, &proposal_id, &comment_id, &member);

        let comment = comments_client.get_comment(&dao_id, &proposal_id, &comment_id);
        assert!(comment.deleted);
        assert_eq!(comment.deleted_by, DELETED_BY_USER);
    }

    #[test]
    fn test_admin_can_delete_any_comment() {
        let (env, comments_id, voting_id, tree_id, sbt_id, registry_id, member) = setup_env();
        let comments_client = CommentsClient::new(&env, &comments_id);
        let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);

        let dao_id = 1u64;
        let proposal_id = 1u64;
        let admin = Address::generate(&env);

        setup_dao_and_proposal(
            &env,
            &voting_id,
            &tree_id,
            &registry_id,
            &admin,
            dao_id,
            proposal_id,
            VoteMode::Fixed,
        );
        sbt_client.set_member(&dao_id, &member, &true);

        // Add comment as member
        let content_cid = String::from_str(&env, "QmMemberComment");
        let comment_id =
            comments_client.add_comment(&dao_id, &proposal_id, &content_cid, &None, &member);

        // Admin deletes member's comment
        comments_client.admin_delete_comment(&dao_id, &proposal_id, &comment_id, &admin);

        let comment = comments_client.get_comment(&dao_id, &proposal_id, &comment_id);
        assert!(comment.deleted);
        assert_eq!(comment.deleted_by, DELETED_BY_ADMIN);
    }

    #[test]
    fn test_reply_to_comment() {
        let (env, comments_id, voting_id, tree_id, sbt_id, registry_id, member) = setup_env();
        let comments_client = CommentsClient::new(&env, &comments_id);
        let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);

        let dao_id = 1u64;
        let proposal_id = 1u64;
        let admin = Address::generate(&env);

        setup_dao_and_proposal(
            &env,
            &voting_id,
            &tree_id,
            &registry_id,
            &admin,
            dao_id,
            proposal_id,
            VoteMode::Fixed,
        );
        sbt_client.set_member(&dao_id, &member, &true);

        // Add parent comment
        let parent_cid = String::from_str(&env, "QmParent");
        let parent_id =
            comments_client.add_comment(&dao_id, &proposal_id, &parent_cid, &None, &member);

        // Add reply
        let reply_cid = String::from_str(&env, "QmReply");
        let reply_id = comments_client.add_comment(
            &dao_id,
            &proposal_id,
            &reply_cid,
            &Some(parent_id),
            &member,
        );

        let reply = comments_client.get_comment(&dao_id, &proposal_id, &reply_id);
        assert_eq!(reply.parent_id, Some(parent_id));
    }

    // ========================================================================
    // Error Tests
    // ========================================================================

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_add_comment_without_membership_fails() {
        // NotDaoMember = 5
        let (env, comments_id, voting_id, tree_id, _sbt_id, registry_id, member) = setup_env();
        let comments_client = CommentsClient::new(&env, &comments_id);

        let dao_id = 1u64;
        let proposal_id = 1u64;
        let admin = Address::generate(&env);

        setup_dao_and_proposal(
            &env,
            &voting_id,
            &tree_id,
            &registry_id,
            &admin,
            dao_id,
            proposal_id,
            VoteMode::Fixed,
        );
        // Don't give member SBT

        let content_cid = String::from_str(&env, "QmNoMembership");
        comments_client.add_comment(&dao_id, &proposal_id, &content_cid, &None, &member);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #25)")]
    fn test_reply_to_nonexistent_comment_fails() {
        // InvalidParentComment = 25
        let (env, comments_id, voting_id, tree_id, sbt_id, registry_id, member) = setup_env();
        let comments_client = CommentsClient::new(&env, &comments_id);
        let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);

        let dao_id = 1u64;
        let proposal_id = 1u64;
        let admin = Address::generate(&env);

        setup_dao_and_proposal(
            &env,
            &voting_id,
            &tree_id,
            &registry_id,
            &admin,
            dao_id,
            proposal_id,
            VoteMode::Fixed,
        );
        sbt_client.set_member(&dao_id, &member, &true);

        // Try to reply to nonexistent comment
        let content_cid = String::from_str(&env, "QmReply");
        comments_client.add_comment(&dao_id, &proposal_id, &content_cid, &Some(999), &member);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #27)")]
    fn test_content_cid_too_long_fails() {
        // CommentContentTooLong = 27
        let (env, comments_id, voting_id, tree_id, sbt_id, registry_id, member) = setup_env();
        let comments_client = CommentsClient::new(&env, &comments_id);
        let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);

        let dao_id = 1u64;
        let proposal_id = 1u64;
        let admin = Address::generate(&env);

        setup_dao_and_proposal(
            &env,
            &voting_id,
            &tree_id,
            &registry_id,
            &admin,
            dao_id,
            proposal_id,
            VoteMode::Fixed,
        );
        sbt_client.set_member(&dao_id, &member, &true);

        // CID longer than 64 chars
        let long_cid = String::from_str(
            &env,
            "QmTooLong12345678901234567890123456789012345678901234567890123456789",
        );
        comments_client.add_comment(&dao_id, &proposal_id, &long_cid, &None, &member);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")]
    fn test_non_admin_cannot_admin_delete() {
        // NotAdmin = 1
        let (env, comments_id, voting_id, tree_id, sbt_id, registry_id, member) = setup_env();
        let comments_client = CommentsClient::new(&env, &comments_id);
        let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);

        let dao_id = 1u64;
        let proposal_id = 1u64;
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);

        setup_dao_and_proposal(
            &env,
            &voting_id,
            &tree_id,
            &registry_id,
            &admin,
            dao_id,
            proposal_id,
            VoteMode::Fixed,
        );
        sbt_client.set_member(&dao_id, &member, &true);

        let content_cid = String::from_str(&env, "QmComment");
        let comment_id =
            comments_client.add_comment(&dao_id, &proposal_id, &content_cid, &None, &member);

        // Non-admin tries to admin-delete
        comments_client.admin_delete_comment(&dao_id, &proposal_id, &comment_id, &non_admin);
    }

    // ========================================================================
    // Field Modulus Validation Tests
    // ========================================================================

    #[test]
    #[should_panic(expected = "Error(Contract, #31)")]
    fn test_anonymous_comment_rejects_nullifier_at_modulus() {
        // SignalNotInField = 31
        let (env, comments_id, voting_id, tree_id, _sbt_id, registry_id, _member) = setup_env();
        let comments_client = CommentsClient::new(&env, &comments_id);

        let dao_id = 1u64;
        let proposal_id = 1u64;
        let admin = Address::generate(&env);

        let root = setup_dao_and_proposal(
            &env,
            &voting_id,
            &tree_id,
            &registry_id,
            &admin,
            dao_id,
            proposal_id,
            VoteMode::Trailing,
        );

        let content_cid = String::from_str(&env, "QmTest");
        let nullifier_at_modulus = u256_from_be(&env, &BN254_FR_MODULUS_TEST);
        let proof = create_dummy_proof(&env);

        comments_client.add_anonymous_comment(
            &dao_id,
            &proposal_id,
            &content_cid,
            &None,
            &nullifier_at_modulus,
            &root,
            &true,
            &proof,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #31)")]
    fn test_anonymous_comment_rejects_nullifier_above_modulus() {
        // SignalNotInField = 31
        let (env, comments_id, voting_id, tree_id, _sbt_id, registry_id, _member) = setup_env();
        let comments_client = CommentsClient::new(&env, &comments_id);

        let dao_id = 1u64;
        let proposal_id = 1u64;
        let admin = Address::generate(&env);

        let root = setup_dao_and_proposal(
            &env,
            &voting_id,
            &tree_id,
            &registry_id,
            &admin,
            dao_id,
            proposal_id,
            VoteMode::Trailing,
        );

        let content_cid = String::from_str(&env, "QmTest");
        let nullifier_above_modulus = modulus_plus(&env, 1);
        let proof = create_dummy_proof(&env);

        comments_client.add_anonymous_comment(
            &dao_id,
            &proposal_id,
            &content_cid,
            &None,
            &nullifier_above_modulus,
            &root,
            &true,
            &proof,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #31)")]
    fn test_anonymous_comment_rejects_root_at_modulus() {
        // SignalNotInField = 31
        let (env, comments_id, voting_id, tree_id, _sbt_id, registry_id, _member) = setup_env();
        let comments_client = CommentsClient::new(&env, &comments_id);

        let dao_id = 1u64;
        let proposal_id = 1u64;
        let admin = Address::generate(&env);

        setup_dao_and_proposal(
            &env,
            &voting_id,
            &tree_id,
            &registry_id,
            &admin,
            dao_id,
            proposal_id,
            VoteMode::Trailing,
        );

        let content_cid = String::from_str(&env, "QmTest");
        let nullifier = U256::from_u32(&env, 99999);
        let root_at_modulus = u256_from_be(&env, &BN254_FR_MODULUS_TEST);
        let proof = create_dummy_proof(&env);

        comments_client.add_anonymous_comment(
            &dao_id,
            &proposal_id,
            &content_cid,
            &None,
            &nullifier,
            &root_at_modulus,
            &true,
            &proof,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #32)")]
    fn test_anonymous_comment_rejects_zero_nullifier() {
        // InvalidNullifier = 32
        let (env, comments_id, voting_id, tree_id, _sbt_id, registry_id, _member) = setup_env();
        let comments_client = CommentsClient::new(&env, &comments_id);

        let dao_id = 1u64;
        let proposal_id = 1u64;
        let admin = Address::generate(&env);

        let root = setup_dao_and_proposal(
            &env,
            &voting_id,
            &tree_id,
            &registry_id,
            &admin,
            dao_id,
            proposal_id,
            VoteMode::Trailing,
        );

        let content_cid = String::from_str(&env, "QmTest");
        let zero_nullifier = U256::from_u32(&env, 0);
        let proof = create_dummy_proof(&env);

        comments_client.add_anonymous_comment(
            &dao_id,
            &proposal_id,
            &content_cid,
            &None,
            &zero_nullifier,
            &root,
            &true,
            &proof,
        );
    }

    // ========================================================================
    // Root Validation Tests (Fixed vs Trailing Mode)
    // ========================================================================

    #[test]
    #[should_panic(expected = "Error(Contract, #29)")]
    fn test_fixed_mode_rejects_wrong_root() {
        // RootMismatch = 29
        let (env, comments_id, voting_id, tree_id, _sbt_id, registry_id, _member) = setup_env();
        let comments_client = CommentsClient::new(&env, &comments_id);

        let dao_id = 1u64;
        let proposal_id = 1u64;
        let admin = Address::generate(&env);

        // Setup with Fixed mode (0)
        let _eligible_root = setup_dao_and_proposal(
            &env,
            &voting_id,
            &tree_id,
            &registry_id,
            &admin,
            dao_id,
            proposal_id,
            VoteMode::Fixed,
        );

        let content_cid = String::from_str(&env, "QmTest");
        let nullifier = U256::from_u32(&env, 99999);
        let wrong_root = U256::from_u32(&env, 54321); // Different from eligible_root
        let proof = create_dummy_proof(&env);

        comments_client.add_anonymous_comment(
            &dao_id,
            &proposal_id,
            &content_cid,
            &None,
            &nullifier,
            &wrong_root,
            &true,
            &proof,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #12)")]
    fn test_trailing_mode_rejects_invalid_root() {
        // RootNotInHistory = 12
        let (env, comments_id, voting_id, tree_id, _sbt_id, registry_id, _member) = setup_env();
        let comments_client = CommentsClient::new(&env, &comments_id);
        let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);

        let dao_id = 1u64;
        let proposal_id = 1u64;
        let admin = Address::generate(&env);

        // Setup with Trailing mode (1)
        setup_dao_and_proposal(
            &env,
            &voting_id,
            &tree_id,
            &registry_id,
            &admin,
            dao_id,
            proposal_id,
            VoteMode::Trailing,
        );

        // Set a root that's NOT valid
        let invalid_root = U256::from_u32(&env, 99999);
        tree_client.set_root_valid(&dao_id, &invalid_root, &false, &0);

        let content_cid = String::from_str(&env, "QmTest");
        let nullifier = U256::from_u32(&env, 88888);
        let proof = create_dummy_proof(&env);

        comments_client.add_anonymous_comment(
            &dao_id,
            &proposal_id,
            &content_cid,
            &None,
            &nullifier,
            &invalid_root,
            &true,
            &proof,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #33)")]
    fn test_trailing_mode_rejects_root_predating_removal() {
        // RootPredatesRemoval = 33
        let (env, comments_id, voting_id, tree_id, _sbt_id, registry_id, _member) = setup_env();
        let comments_client = CommentsClient::new(&env, &comments_id);
        let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);

        let dao_id = 1u64;
        let proposal_id = 1u64;
        let admin = Address::generate(&env);

        // Setup with Trailing mode
        setup_dao_and_proposal(
            &env,
            &voting_id,
            &tree_id,
            &registry_id,
            &admin,
            dao_id,
            proposal_id,
            VoteMode::Trailing,
        );

        // Create a root that's valid but predates removal (index 5)
        let old_root = U256::from_u32(&env, 54321);
        tree_client.set_root_valid(&dao_id, &old_root, &true, &5);

        // Set min_root to 10 (simulating member was revoked at index 10)
        tree_client.set_min_root(&dao_id, &10);

        let content_cid = String::from_str(&env, "QmTest");
        let nullifier = U256::from_u32(&env, 88888);
        let proof = create_dummy_proof(&env);

        // This should fail because root index (5) < min_root (10)
        comments_client.add_anonymous_comment(
            &dao_id,
            &proposal_id,
            &content_cid,
            &None,
            &nullifier,
            &old_root,
            &true,
            &proof,
        );
    }
}
