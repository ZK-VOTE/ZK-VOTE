#![no_std]
#![allow(clippy::too_many_arguments)]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Bytes, BytesN, Env, IntoVal, String, Symbol, Vec,
};

const DAO_COUNT: Symbol = symbol_short!("dao_cnt");
// #592 deployer attestation: registry publishes its own code hash so voting
// contracts can pin it per-DAO (registry_hash) instead of trusting any
// contract id that answers get_admin.
const REGISTRY_CODE_HASH: Symbol = symbol_short!("rg_code");
const VERSION: u32 = 2;
const VERSION_KEY: Symbol = symbol_short!("ver");

// TTL management: bump on every interaction to keep contract alive
//
// SECURITY (#audit-H1): `DaoInfo` was on the old 535_680-ledger (~31 day)
// window, refreshed only when that specific DAO was read or written. A DAO
// nobody touched for a month lost its `DaoInfo` entry, and because *every*
// admin path resolves authority through `get_admin(dao_id)` — in this contract
// and in membership-sbt, membership-tree, voting and comments alike — the
// result was a DAO that had lost not just its settings but its ability to have
// any: `get_admin` returned "missing", every admin entrypoint raised
// `DaoNotFound`, and nothing could restore it because the entry that would
// identify the admin no longer existed. A DAO's unadministrability is
// unrecoverable by design here, so the record that decides it must not be
// allowed to lapse silently.
//
// The window is now the protocol ceiling (`maxEntryTTL` = 6_312_000 ledgers,
// ~365 days at 5s/ledger). `sweep_dao` tops up a DAO that is otherwise idle.
const INSTANCE_TTL_THRESHOLD: u32 = 120_960; // ~7 days
const INSTANCE_TTL_EXTEND: u32 = 6_312_000; // ~365 days — protocol maxEntryTTL
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 6_312_000; // ~365 days — protocol maxEntryTTL
/// Upper bound on how many DAOs one `sweep_dao` call refreshes, so a registry
/// with many DAOs cannot push the call past the transaction budget. Callers
/// paginate by advancing `start`.
pub const SWEEP_MAX_DAOS: u32 = 50;

/// Durable receipt for an idempotent DAO creation.
///
/// The backend provisioner can safely retry `create_dao_idempotent` after a
/// crash: the key is the idempotency token, and the receipt records the DAO it
/// produced. Later bootstrap steps still need their own idempotency (the
/// backend saga records checkpoints), but a retried registry step can never
/// create a duplicate DAO.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DaoCreationReceipt {
    pub dao_id: u64,
    pub idempotency_key: BytesN<32>,
    pub creator: Address,
    pub created_at: u64,
}

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum RegistryError {
    NameTooLong = 1,
    DaoNotFound = 2,
    NotAdmin = 3,
    MetadataCidTooLong = 4,
    UpgradeNotFound = 5,
    UpgradeTimelockNotReady = 6,
    UpgradeExpired = 7,
    UpgradeAlreadyExecuted = 8,
    UpgradeInvalidWindow = 9,
    UpgradePayloadTooLarge = 10,
    // Role and multisig errors
    InvalidRole = 11,
    NotMultisigAdmin = 12,
    InsufficientSignatures = 13,
    ProposalNotFound = 14,
    ProposalAlreadyExecuted = 15,
    InvalidSignature = 16,
    DuplicateSigner = 17,
    InvalidThreshold = 18,
    SignerNotFound = 19,
    // Issue #734 — name squatting / front-running mitigations
    /// A commit-reveal reservation for this name already exists and has not
    /// yet expired. The caller must wait for it to expire or be the same
    /// address that committed.
    NameAlreadyReserved = 20,
    /// The provided reveal does not match the on-chain commitment hash.
    CommitRevealMismatch = 21,
    /// The reservation has expired; the caller must commit again.
    ReservationExpired = 22,
    /// The reservation window has not passed; reveal is too early.
    RevealTooEarly = 23,
}

// Size limit to prevent DoS attacks
const MAX_DAO_NAME_LEN: u32 = 24; // Max DAO name length (24 chars)
const MAX_METADATA_CID_LEN: u32 = 64; // Max IPFS CID length

// ── Storage-rent DoS mitigations (SPIKE-052 / issue #732) ────────────────────
//
// Soroban storage rent is billed per-entry at ledger close. Without per-DAO
// footprint accounting an attacker can create many DAOs and grow tree/proposal
// state cheaply, externalizing rent costs to the network.
//
// Policy (v1):
//   MAX_PROPOSALS_PER_DAO  — caps the maximum number of concurrent open
//     proposals per DAO; limits voting-contract state growth.
//   MAX_MEMBERS_PER_DAO    — soft cap on SBT mints / tree leaves per DAO
//     before the DAO admin must explicitly raise the limit (prevents depth-18
//     tree exhaustion attacks on small DAOs).
//   MAX_COMMENTS_PER_PROPOSAL — limits comment-contract entries per proposal.
//
// These constants are readable by sibling contracts (voting, comments,
// membership-tree) via a future cross-contract call so the policy is
// authoritative here. They are conservative defaults; a governance action on
// the registry contract can raise them for a specific DAO.
//
// Reverse-griefing note: a cap on DAO state can be used by an attacker to
// pin a victim DAO at its quota and freeze legitimate growth. Mitigation:
// only the DAO admin may raise per-DAO caps (via `set_dao_quota`), and
// the protocol-global defaults are set high enough to not affect real DAOs.
pub const MAX_PROPOSALS_PER_DAO: u32 = 1_000;
pub const MAX_MEMBERS_PER_DAO: u32 = 100_000; // 2^18 = 262_144 is the tree hard limit
pub const MAX_COMMENTS_PER_PROPOSAL: u32 = 500;
const MIN_UPGRADE_DELAY: u64 = 24 * 60 * 60;
const MAX_UPGRADE_PAYLOAD_LEN: u32 = 4096;

// ── Commit-reveal name reservation (SPIKE-055 / issue #734) ──────────────────
//
// DAOs are identified by a numeric `dao_id` (squatting-proof). Names are
// non-unique labels on top of that numeric identity. To mitigate creation
// front-running (a watcher races to register the same name with a higher
// ledger-sequence fee), we provide an optional commit-reveal flow:
//
//   1. Caller hashes: commitment = SHA-256(name || nonce || caller_address)
//      and calls `commit_name(commitment, caller)`.
//   2. After REVEAL_MIN_WAIT_LEDGERS ledgers, caller calls `create_dao` with
//      the same name + nonce. The contract verifies the commitment and clears
//      the reservation.
//
// The reservation expires after RESERVATION_TTL_LEDGERS so a failed reveal
// doesn't permanently block a name.
//
// Commit-reveal is OPTIONAL — callers that don't care about front-running can
// skip it and call `create_dao` directly. The numeric dao_id is always the
// canonical identity regardless of the name label.
/// Minimum ledgers between commit and reveal (~5 minutes at 5s/ledger).
pub const REVEAL_MIN_WAIT_LEDGERS: u32 = 60;
/// Reservation TTL in ledgers (~1 hour).
pub const RESERVATION_TTL_LEDGERS: u32 = 720;

#[contracttype]
#[derive(Clone)]
pub struct NameReservation {
    /// Address that committed (only this address may reveal).
    pub reserver: Address,
    /// SHA-256(name || nonce || reserver) — stored as 32-byte hash.
    pub commitment: BytesN<32>,
    /// Ledger sequence when the commitment was made.
    pub committed_at: u32,
    /// Ledger sequence when this reservation expires.
    pub expires_at: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct DaoInfo {
    pub id: u64,
    pub name: String,
    pub admin: Address,
    pub created_at: u64,
    pub membership_open: bool,
    /// If true, any member can create proposals. If false, only admin can create proposals.
    pub members_can_propose: bool,
    /// IPFS CID for extended metadata (description, images, links)
    pub metadata_cid: Option<String>,
}

pub use zkvote_groth16::VerificationKey;

// ============================================
// ROLE MODEL
// ============================================

#[contracttype]
#[derive(Clone, Copy, Eq, PartialEq, Debug)]
#[repr(u32)]
pub enum DaoRole {
    Admin = 0,
    Member = 1,
    Auditor = 2,
}

#[contracttype]
#[derive(Clone)]
pub struct MemberRole {
    pub member: Address,
    pub role: DaoRole,
    pub assigned_at: u64,
}

// ============================================
// MULTISIG MODEL
// ============================================

#[contracttype]
#[derive(Clone)]
pub struct MultisigConfig {
    pub dao_id: u64,
    pub signers: Vec<Address>,
    pub threshold: u32,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct MultisigProposal {
    pub dao_id: u64,
    pub proposal_id: u64,
    pub title: String,
    pub description: String,
    pub action_type: String, // "TransferAdmin", "SetRole", "UpdateMultisig", etc
    pub action_data: Bytes,
    pub proposer: Address,
    pub created_at: u64,
    pub expires_at: u64,
    pub signatures: Vec<Address>,
    pub executed: bool,
}

#[contracttype]
#[derive(Clone)]
pub struct CircuitUpgradeProposal {
    pub dao_id: u64,
    pub from_circuit_id: String,
    pub to_circuit_id: String,
    pub circuit_type: String, // "Vote" or "Comment"
    pub proposed_at: u64,
    pub deadline: u64,
    pub approved: bool,
}

#[contracttype]
#[derive(Clone)]
pub struct ContractUpgradeProposal {
    pub dao_id: u64,
    pub target_contract: Address,
    pub wasm_hash: BytesN<32>,
    pub rollback_wasm_hash: BytesN<32>,
    pub from_version: u32,
    pub to_version: u32,
    pub storage_version: u32,
    pub migration_payload: Bytes,
    pub proposed_at: u64,
    pub eta: u64,
    pub expires_at: u64,
    pub executed: bool,
    pub rolled_back: bool,
}

// ============================================
// EVENTS
// ============================================

// Role and Multisig Events
#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct RoleAssignedEvent {
    #[topic]
    pub dao_id: u64,
    pub member: Address,
    pub role: u32, // 0=Admin, 1=Member, 2=Auditor
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct RoleRevokedEvent {
    #[topic]
    pub dao_id: u64,
    pub member: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct MultisigConfiguredEvent {
    #[topic]
    pub dao_id: u64,
    pub signer_count: u32,
    pub threshold: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct MultisigProposalCreatedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub proposer: Address,
    pub action_type: String,
    pub expires_at: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct MultisigProposalSignedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub signer: Address,
    pub signature_count: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct MultisigProposalExecutedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub action_type: String,
}

// Typed Events
#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct DaoCreateEvent {
    #[topic]
    pub dao_id: u64,
    pub admin: Address,
    pub name: String,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct DaoCreatedIdempotentEvent {
    #[topic]
    pub idempotency_key: BytesN<32>,
    pub dao_id: u64,
    pub created: bool,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct CircuitUpgradeProposedEvent {
    #[topic]
    pub dao_id: u64,
    pub from_circuit_id: String,
    pub to_circuit_id: String,
    pub deadline: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct CircuitUpgradeApprovedEvent {
    #[topic]
    pub dao_id: u64,
    pub proposal_id: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractUpgradeProposedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub target_contract: Address,
    pub from_version: u32,
    pub to_version: u32,
    pub eta: u64,
    pub expires_at: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractUpgradeExecutedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub target_contract: Address,
    pub to_version: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractRollbackEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub target_contract: Address,
    pub to_version: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct AdminXferEvent {
    #[topic]
    pub dao_id: u64,
    pub old_admin: Address,
    pub new_admin: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractUpgraded {
    pub from: u32,
    pub to: u32,
}

#[contract]
pub struct DaoRegistry;

#[contractimpl]
impl DaoRegistry {
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

    // ============================================
    // ROLE MANAGEMENT
    // ============================================

    /// Assign a role to a DAO member (admin only)
    pub fn assign_role(env: Env, dao_id: u64, member: Address, role: u32, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();

        // Validate DAO exists and caller is admin
        Self::require_dao_admin(&env, dao_id, &admin);

        // Validate role
        if role > 2 {
            panic_with_error!(&env, RegistryError::InvalidRole);
        }

        let role_enum = match role {
            0 => DaoRole::Admin,
            1 => DaoRole::Member,
            2 => DaoRole::Auditor,
            _ => panic_with_error!(&env, RegistryError::InvalidRole),
        };

        let key = Self::member_role_key(dao_id, &member);
        let member_role = MemberRole {
            member: member.clone(),
            role: role_enum,
            assigned_at: env.ledger().timestamp(),
        };

        env.storage().persistent().set(&key, &member_role);
        Self::bump_persistent(&env, &key);

        RoleAssignedEvent {
            dao_id,
            member,
            role,
        }
        .publish(&env);
    }

    /// Get member role in a DAO
    pub fn get_member_role(env: Env, dao_id: u64, member: Address) -> Option<u32> {
        Self::bump_instance(&env);

        let key = Self::member_role_key(dao_id, &member);
        if let Some(member_role) = env.storage().persistent().get::<_, MemberRole>(&key) {
            Self::bump_persistent(&env, &key);
            let role_val = match member_role.role {
                DaoRole::Admin => 0,
                DaoRole::Member => 1,
                DaoRole::Auditor => 2,
            };
            return Some(role_val);
        }
        None
    }

    /// Revoke member role (admin only)
    pub fn revoke_role(env: Env, dao_id: u64, member: Address, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();

        // Validate DAO exists and caller is admin
        Self::require_dao_admin(&env, dao_id, &admin);

        let key = Self::member_role_key(dao_id, &member);
        if env.storage().persistent().has(&key) {
            env.storage().persistent().remove(&key);

            RoleRevokedEvent { dao_id, member }.publish(&env);
        }
    }

    // ============================================
    // MULTISIG MANAGEMENT
    // ============================================

    /// Initialize multisig for a DAO (admin only)
    pub fn init_multisig(
        env: Env,
        dao_id: u64,
        signers: Vec<Address>,
        threshold: u32,
        admin: Address,
    ) {
        Self::bump_instance(&env);
        admin.require_auth();

        // Validate DAO exists and caller is admin
        Self::require_dao_admin(&env, dao_id, &admin);

        // Validate threshold
        if threshold == 0 || threshold > signers.len() as u32 {
            panic_with_error!(&env, RegistryError::InvalidThreshold);
        }

        // Check for duplicate signers
        for i in 0..signers.len() {
            for j in (i + 1)..signers.len() {
                if signers.get_unchecked(i) == signers.get_unchecked(j) {
                    panic_with_error!(&env, RegistryError::DuplicateSigner);
                }
            }
        }

        let config = MultisigConfig {
            dao_id,
            signers,
            threshold,
            created_at: env.ledger().timestamp(),
        };

        let key = Self::multisig_config_key(dao_id);
        env.storage().persistent().set(&key, &config);
        Self::bump_persistent(&env, &key);

        MultisigConfiguredEvent {
            dao_id,
            signer_count: config.signers.len() as u32,
            threshold,
        }
        .publish(&env);
    }

    /// Get multisig configuration for a DAO
    pub fn get_multisig(env: Env, dao_id: u64) -> Option<MultisigConfig> {
        Self::bump_instance(&env);

        let key = Self::multisig_config_key(dao_id);
        if let Some(config) = env.storage().persistent().get::<_, MultisigConfig>(&key) {
            Self::bump_persistent(&env, &key);
            return Some(config);
        }
        None
    }

    /// Create a multisig proposal (any signer can propose)
    pub fn create_multisig_proposal(
        env: Env,
        dao_id: u64,
        title: String,
        description: String,
        action_type: String,
        action_data: Bytes,
        proposer: Address,
    ) -> u64 {
        Self::bump_instance(&env);
        proposer.require_auth();

        // Verify DAO exists
        if !Self::dao_exists(env.clone(), dao_id) {
            panic_with_error!(&env, RegistryError::DaoNotFound);
        }

        // Get multisig config
        let key = Self::multisig_config_key(dao_id);
        let config: MultisigConfig = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::NotMultisigAdmin));

        // Verify proposer is a signer
        let mut is_signer = false;
        for signer in config.signers.iter() {
            if signer == proposer {
                is_signer = true;
                break;
            }
        }
        if !is_signer {
            panic_with_error!(&env, RegistryError::NotMultisigAdmin);
        }

        let proposal_id = Self::next_multisig_proposal_id(&env);
        let now = env.ledger().timestamp();
        let expires_at = now + 7 * 24 * 60 * 60; // 7 days

        let mut signatures = Vec::new(&env);
        signatures.push_back(proposer.clone());

        let proposal = MultisigProposal {
            dao_id,
            proposal_id,
            title: title.clone(),
            description: description.clone(),
            action_type: action_type.clone(),
            action_data,
            proposer: proposer.clone(),
            created_at: now,
            expires_at,
            signatures,
            executed: false,
        };

        let proposal_key = Self::multisig_proposal_key(dao_id, proposal_id);
        env.storage().persistent().set(&proposal_key, &proposal);
        Self::bump_persistent(&env, &proposal_key);

        MultisigProposalCreatedEvent {
            dao_id,
            proposal_id,
            proposer,
            action_type,
            expires_at,
        }
        .publish(&env);

        proposal_id
    }

    /// Sign a multisig proposal (must be a signer)
    pub fn sign_multisig_proposal(env: Env, dao_id: u64, proposal_id: u64, signer: Address) {
        Self::bump_instance(&env);
        signer.require_auth();

        let proposal_key = Self::multisig_proposal_key(dao_id, proposal_id);
        let mut proposal: MultisigProposal = env
            .storage()
            .persistent()
            .get(&proposal_key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::ProposalNotFound));

        // Check if already executed
        if proposal.executed {
            panic_with_error!(&env, RegistryError::ProposalAlreadyExecuted);
        }

        // Check if expired
        if env.ledger().timestamp() > proposal.expires_at {
            panic_with_error!(&env, RegistryError::UpgradeExpired);
        }

        // Verify signer is authorized
        let config_key = Self::multisig_config_key(dao_id);
        let config: MultisigConfig = env
            .storage()
            .persistent()
            .get(&config_key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::NotMultisigAdmin));

        let mut is_authorized = false;
        for authorized_signer in config.signers.iter() {
            if authorized_signer == signer {
                is_authorized = true;
                break;
            }
        }
        if !is_authorized {
            panic_with_error!(&env, RegistryError::InvalidSignature);
        }

        // Check if already signed
        for sig in proposal.signatures.iter() {
            if sig == signer {
                panic_with_error!(&env, RegistryError::DuplicateSigner);
            }
        }

        proposal.signatures.push_back(signer.clone());
        env.storage().persistent().set(&proposal_key, &proposal);
        Self::bump_persistent(&env, &proposal_key);

        MultisigProposalSignedEvent {
            dao_id,
            proposal_id,
            signer,
            signature_count: proposal.signatures.len() as u32,
        }
        .publish(&env);
    }

    /// Get a multisig proposal
    pub fn get_multisig_proposal(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
    ) -> Option<MultisigProposal> {
        Self::bump_instance(&env);

        let proposal_key = Self::multisig_proposal_key(dao_id, proposal_id);
        if let Some(proposal) = env
            .storage()
            .persistent()
            .get::<_, MultisigProposal>(&proposal_key)
        {
            Self::bump_persistent(&env, &proposal_key);
            return Some(proposal);
        }
        None
    }

    /// Execute a multisig proposal (when threshold met)
    pub fn execute_multisig_proposal(env: Env, dao_id: u64, proposal_id: u64, executor: Address) {
        Self::bump_instance(&env);
        executor.require_auth();

        let proposal_key = Self::multisig_proposal_key(dao_id, proposal_id);
        let mut proposal: MultisigProposal = env
            .storage()
            .persistent()
            .get(&proposal_key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::ProposalNotFound));

        // Check if already executed
        if proposal.executed {
            panic_with_error!(&env, RegistryError::ProposalAlreadyExecuted);
        }

        // Get multisig config
        let config_key = Self::multisig_config_key(dao_id);
        let config: MultisigConfig = env
            .storage()
            .persistent()
            .get(&config_key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::NotMultisigAdmin));

        // Verify executor is a signer
        let mut is_signer = false;
        for signer in config.signers.iter() {
            if signer == executor {
                is_signer = true;
                break;
            }
        }
        if !is_signer {
            panic_with_error!(&env, RegistryError::InvalidSignature);
        }

        // Check threshold met
        if (proposal.signatures.len() as u32) < config.threshold {
            panic_with_error!(&env, RegistryError::InsufficientSignatures);
        }

        // Mark as executed
        proposal.executed = true;
        env.storage().persistent().set(&proposal_key, &proposal);
        Self::bump_persistent(&env, &proposal_key);

        MultisigProposalExecutedEvent {
            dao_id,
            proposal_id,
            action_type: proposal.action_type,
        }
        .publish(&env);
    }

    /// Create a new DAO (permissionless).
    /// Creator automatically becomes the admin.
    /// Cannot create DAOs for other people - you can only create your own DAO.
    /// - `members_can_propose`: if true, any member can create proposals; if false, only admin
    /// - `metadata_cid`: optional IPFS CID for extended metadata (description, images, links)
    pub fn create_dao(
        env: Env,
        name: String,
        creator: Address,
        membership_open: bool,
        members_can_propose: bool,
        metadata_cid: Option<String>,
    ) -> u64 {
        Self::bump_instance(&env);
        creator.require_auth();

        // Validate name length to prevent DoS
        if name.len() > MAX_DAO_NAME_LEN {
            panic_with_error!(&env, RegistryError::NameTooLong);
        }

        // Validate metadata CID length if provided
        if let Some(ref cid) = metadata_cid {
            if cid.len() > MAX_METADATA_CID_LEN {
                panic_with_error!(&env, RegistryError::MetadataCidTooLong);
            }
        }

        let dao_id = Self::next_dao_id(&env);

        // Creator automatically becomes admin (prevents making others admin without consent)
        let info = DaoInfo {
            id: dao_id,
            name: name.clone(),
            admin: creator.clone(),
            created_at: env.ledger().timestamp(),
            membership_open,
            members_can_propose,
            metadata_cid,
        };

        let key = Self::dao_key(dao_id);
        env.storage().persistent().set(&key, &info);
        Self::bump_persistent(&env, &key);

        DaoCreateEvent {
            dao_id,
            admin: creator,
            name,
        }
        .publish(&env);

        dao_id
    }

    /// Idempotent DAO creation used by the bootstrap saga.
    ///
    /// Retrying with the same 32-byte key returns the original DAO id with
    /// `created == false` instead of minting a duplicate DAO. The receipt is
    /// durable for the life of the contract and lets the backend prove which
    /// step actually committed after a crash.
    pub fn create_dao_idempotent(
        env: Env,
        idempotency_key: BytesN<32>,
        name: String,
        creator: Address,
        membership_open: bool,
        members_can_propose: bool,
        metadata_cid: Option<String>,
    ) -> (u64, bool) {
        Self::bump_instance(&env);

        let key = (symbol_short!("idem"), idempotency_key.clone());
        if let Some(dao_id) = env.storage().persistent().get::<_, u64>(&key) {
            Self::bump_persistent(&env, &key);
            DaoCreatedIdempotentEvent {
                idempotency_key,
                dao_id,
                created: false,
            }
            .publish(&env);
            return (dao_id, false);
        }

        let dao_id = Self::create_dao(
            env.clone(),
            name,
            creator.clone(),
            membership_open,
            members_can_propose,
            metadata_cid,
        );

        env.storage().persistent().set(&key, &dao_id);
        Self::bump_persistent(&env, &key);

        let receipt = DaoCreationReceipt {
            dao_id,
            idempotency_key: idempotency_key.clone(),
            creator,
            created_at: env.ledger().timestamp(),
        };
        let receipt_key = (symbol_short!("receipt"), dao_id);
        env.storage().persistent().set(&receipt_key, &receipt);
        Self::bump_persistent(&env, &receipt_key);

        DaoCreatedIdempotentEvent {
            idempotency_key,
            dao_id,
            created: true,
        }
        .publish(&env);

        (dao_id, true)
    }

    /// Resolve an idempotency key to the DAO it created, if any.
    pub fn get_dao_by_idempotency_key(env: Env, idempotency_key: BytesN<32>) -> Option<u64> {
        Self::bump_instance(&env);
        let key = (symbol_short!("idem"), idempotency_key);
        env.storage().persistent().get(&key)
    }

    /// Read the durable creation receipt for a DAO.
    pub fn get_creation_receipt(env: Env, dao_id: u64) -> Option<DaoCreationReceipt> {
        Self::bump_instance(&env);
        let key = (symbol_short!("receipt"), dao_id);
        env.storage().persistent().get(&key)
    }

    /// Get DAO info
    pub fn get_dao(env: Env, dao_id: u64) -> DaoInfo {
        Self::bump_instance(&env);
        let key = Self::dao_key(dao_id);
        let info: DaoInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::DaoNotFound));
        Self::bump_persistent(&env, &key);
        info
    }

    /// Check if DAO exists
    pub fn dao_exists(env: Env, dao_id: u64) -> bool {
        Self::bump_instance(&env);
        let key = Self::dao_key(dao_id);
        env.storage().persistent().has(&key)
    }

    /// Get admin of a DAO
    pub fn get_admin(env: Env, dao_id: u64) -> Address {
        // bump_instance called inside get_dao
        Self::get_dao(env, dao_id).admin
    }

    /// Transfer admin rights (current admin only)
    pub fn transfer_admin(env: Env, dao_id: u64, new_admin: Address) {
        Self::bump_instance(&env);
        let key = Self::dao_key(dao_id);
        let mut info: DaoInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::DaoNotFound));

        info.admin.require_auth();

        let old_admin = info.admin.clone();
        info.admin = new_admin.clone();
        env.storage().persistent().set(&key, &info);
        Self::bump_persistent(&env, &key);

        AdminXferEvent {
            dao_id,
            old_admin,
            new_admin,
        }
        .publish(&env);
    }

    /// Get total number of DAOs created
    pub fn dao_count(env: Env) -> u64 {
        Self::bump_instance(&env);
        env.storage().instance().get(&DAO_COUNT).unwrap_or(0)
    }

    // ── Keepalive (#audit-H1) ───────────────────────────────────────────────
    //
    // A `DaoInfo` entry is the one record in this contract whose loss is
    // unrecoverable: every admin path in the whole system resolves authority
    // through `get_admin`, so once `DaoInfo` is archived the DAO has no
    // identifiable admin, every admin entrypoint in every contract raises
    // `DaoNotFound`, and there is no call left that could put the entry back.
    //
    // The window is already the protocol ceiling, so this only has to cover the
    // case the ceiling cannot: a DAO nobody touches for a full year. It is
    // permissionless on purpose — gating a keepalive behind the very admin
    // record that might be the thing at risk is how a DAO ends up unadministrable
    // in the first place. It only extends TTLs and never creates, mutates or
    // deletes a DAO, so there is nothing for a caller to gain.

    /// Refresh one page of `DaoInfo` records back to the protocol ceiling.
    ///
    /// Walks `dao_id` from `start` and refreshes every record that still
    /// exists; returns how many were refreshed. Callers repeat with
    /// `start += SWEEP_MAX_DAOS` until it returns 0. Gaps left by deleted DAOs
    /// are skipped rather than treated as failures.
    pub fn sweep_dao(env: Env, start: u64, limit: u32) -> u32 {
        Self::bump_instance(&env);
        let limit = if limit == 0 || limit > SWEEP_MAX_DAOS {
            SWEEP_MAX_DAOS
        } else {
            limit
        };
        let total = env.storage().instance().get(&DAO_COUNT).unwrap_or(0);
        let end = total.min(start.saturating_add(limit as u64));

        let mut swept = 0u32;
        let mut id = start;
        while id < end {
            let key = Self::dao_key(id);
            if env.storage().persistent().has(&key) {
                Self::bump_persistent(&env, &key);
                swept += 1;
            }
            id += 1;
        }
        swept
    }

    /// Check if a DAO has open membership
    pub fn is_membership_open(env: Env, dao_id: u64) -> bool {
        // bump_instance called inside get_dao
        Self::get_dao(env, dao_id).membership_open
    }

    /// Check if members can create proposals (vs admin-only)
    pub fn members_can_propose(env: Env, dao_id: u64) -> bool {
        // bump_instance called inside get_dao
        Self::get_dao(env, dao_id).members_can_propose
    }

    /// Set proposal mode (admin only).
    /// If `members_can_propose` is true, any member can create proposals.
    /// If false, only the DAO admin can create proposals.
    pub fn set_proposal_mode(env: Env, dao_id: u64, members_can_propose: bool, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();

        let key = Self::dao_key(dao_id);
        let mut info: DaoInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::DaoNotFound));

        // Only admin can change proposal mode
        if admin != info.admin {
            panic_with_error!(&env, RegistryError::NotAdmin);
        }

        info.members_can_propose = members_can_propose;
        env.storage().persistent().set(&key, &info);
        Self::bump_persistent(&env, &key);
    }

    /// Set membership open/closed (admin only).
    /// If `membership_open` is true, users can join (mint SBT) themselves.
    /// If false, only the admin can add members.
    pub fn set_membership_open(env: Env, dao_id: u64, membership_open: bool, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();

        let key = Self::dao_key(dao_id);
        let mut info: DaoInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::DaoNotFound));

        // Only admin can change membership mode
        if admin != info.admin {
            panic_with_error!(&env, RegistryError::NotAdmin);
        }

        info.membership_open = membership_open;
        env.storage().persistent().set(&key, &info);
        Self::bump_persistent(&env, &key);
    }

    /// Set DAO name (admin only). Max 100 characters.
    pub fn set_name(env: Env, dao_id: u64, name: String, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();

        // Validate name length
        if name.len() > MAX_DAO_NAME_LEN {
            panic_with_error!(&env, RegistryError::NameTooLong);
        }

        let key = Self::dao_key(dao_id);
        let mut info: DaoInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::DaoNotFound));

        // Only admin can change name
        if admin != info.admin {
            panic_with_error!(&env, RegistryError::NotAdmin);
        }

        info.name = name;
        env.storage().persistent().set(&key, &info);
        Self::bump_persistent(&env, &key);
    }

    /// Set DAO metadata CID (admin only).
    /// The CID points to IPFS JSON with description, images, and links.
    /// Pass None to clear metadata.
    pub fn set_metadata_cid(env: Env, dao_id: u64, metadata_cid: Option<String>, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();

        // Validate CID length if provided
        if let Some(ref cid) = metadata_cid {
            if cid.len() > MAX_METADATA_CID_LEN {
                panic_with_error!(&env, RegistryError::MetadataCidTooLong);
            }
        }

        let key = Self::dao_key(dao_id);
        let mut info: DaoInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::DaoNotFound));

        // Only admin can change metadata
        if admin != info.admin {
            panic_with_error!(&env, RegistryError::NotAdmin);
        }

        info.metadata_cid = metadata_cid;
        env.storage().persistent().set(&key, &info);
        Self::bump_persistent(&env, &key);
    }

    /// Get DAO metadata CID
    pub fn get_metadata_cid(env: Env, dao_id: u64) -> Option<String> {
        Self::get_dao(env, dao_id).metadata_cid
    }

    /// Create and initialize DAO without registering creator for voting.
    /// Creator must register separately using deterministic credentials.
    /// This calls:
    /// 1. create_dao (creates registry entry)
    /// 2. membership_sbt.mint (mints SBT to creator)
    /// 3. membership_tree.init_tree (initializes Merkle tree)
    /// 4. voting.set_vk (sets verification key)
    /// `field` is `"BN254"` or `"BLS12_381"`
    pub fn create_and_init_dao_no_reg(
        env: Env,
        name: String,
        creator: Address,
        membership_open: bool,
        members_can_propose: bool,
        metadata_cid: Option<String>,
        sbt_contract: Address,
        tree_contract: Address,
        voting_contract: Address,
        tree_depth: u32,
        field: Symbol,
        vk: VerificationKey,
    ) -> u64 {
        Self::bump_instance(&env);
        creator.require_auth();

        // Validate name length to prevent DoS
        if name.len() > MAX_DAO_NAME_LEN {
            panic_with_error!(&env, RegistryError::NameTooLong);
        }

        // Validate metadata CID length if provided
        if let Some(ref cid) = metadata_cid {
            if cid.len() > MAX_METADATA_CID_LEN {
                panic_with_error!(&env, RegistryError::MetadataCidTooLong);
            }
        }

        // Step 1: Create DAO registry entry
        let dao_id = Self::next_dao_id(&env);
        let info = DaoInfo {
            id: dao_id,
            name: name.clone(),
            admin: creator.clone(),
            created_at: env.ledger().timestamp(),
            membership_open,
            members_can_propose,
            metadata_cid,
        };

        let key = Self::dao_key(dao_id);
        env.storage().persistent().set(&key, &info);
        Self::bump_persistent(&env, &key);

        DaoCreateEvent {
            dao_id,
            admin: creator.clone(),
            name,
        }
        .publish(&env);

        // Step 2: Mint SBT to creator
        use soroban_sdk::IntoVal;
        let mint_args =
            soroban_sdk::vec![&env, dao_id.into_val(&env), creator.clone().into_val(&env)];
        env.invoke_contract::<()>(
            &sbt_contract,
            &Symbol::new(&env, "mint_from_registry"),
            mint_args,
        );

        // Step 3: Initialize Merkle tree
        let init_tree_args = soroban_sdk::vec![
            &env,
            dao_id.into_val(&env),
            tree_depth.into_val(&env),
            field.into_val(&env),
        ];
        env.invoke_contract::<()>(
            &tree_contract,
            &Symbol::new(&env, "init_tree_from_registry"),
            init_tree_args,
        );

        // Step 4: Set verification key
        let set_vk_args = soroban_sdk::vec![&env, dao_id.into_val(&env), vk.into_val(&env)];
        env.invoke_contract::<()>(
            &voting_contract,
            &Symbol::new(&env, "set_vk_from_registry"),
            set_vk_args,
        );

        dao_id
    }

    /// Create and fully initialize a DAO in a single transaction.
    /// This calls:
    /// 1. create_dao (creates registry entry)
    /// 2. membership_sbt.mint (mints SBT to creator)
    /// 3. membership_tree.init_tree (initializes Merkle tree)
    /// 4. membership_tree.register_from_registry (registers creator's commitment)
    /// 5. voting.set_vk (sets verification key)
    /// `field` is `"BN254"` or `"BLS12_381"`
    /// Note: metadata_cid must be set separately via set_metadata_cid (10-param limit)
    pub fn create_and_init_dao(
        env: Env,
        name: String,
        creator: Address,
        membership_open: bool,
        members_can_propose: bool,
        sbt_contract: Address,
        tree_contract: Address,
        voting_contract: Address,
        tree_depth: u32,
        creator_commitment: soroban_sdk::U256,
        field: Symbol,
        vk: VerificationKey,
    ) -> u64 {
        Self::bump_instance(&env);
        creator.require_auth();

        // Validate name length to prevent DoS
        if name.len() > MAX_DAO_NAME_LEN {
            panic_with_error!(&env, RegistryError::NameTooLong);
        }

        // Step 1: Create DAO registry entry
        let dao_id = Self::next_dao_id(&env);
        let info = DaoInfo {
            id: dao_id,
            name: name.clone(),
            admin: creator.clone(),
            created_at: env.ledger().timestamp(),
            membership_open,
            members_can_propose,
            metadata_cid: None,
        };

        let key = Self::dao_key(dao_id);
        env.storage().persistent().set(&key, &info);
        Self::bump_persistent(&env, &key);

        DaoCreateEvent {
            dao_id,
            admin: creator.clone(),
            name,
        }
        .publish(&env);

        // Step 2: Mint SBT to creator (using mint_from_registry to avoid re-entrancy)
        use soroban_sdk::IntoVal;
        let mint_args =
            soroban_sdk::vec![&env, dao_id.into_val(&env), creator.clone().into_val(&env)];
        env.invoke_contract::<()>(
            &sbt_contract,
            &Symbol::new(&env, "mint_from_registry"),
            mint_args,
        );

        // Step 3: Initialize Merkle tree (using init_tree_from_registry to avoid re-entrancy)
        let init_tree_args = soroban_sdk::vec![
            &env,
            dao_id.into_val(&env),
            tree_depth.into_val(&env),
            field.into_val(&env),
        ];
        env.invoke_contract::<()>(
            &tree_contract,
            &Symbol::new(&env, "init_tree_from_registry"),
            init_tree_args,
        );

        // Step 4: Register creator's commitment in the tree
        let register_args = soroban_sdk::vec![
            &env,
            dao_id.into_val(&env),
            creator_commitment.into_val(&env),
            creator.clone().into_val(&env)
        ];
        env.invoke_contract::<()>(
            &tree_contract,
            &Symbol::new(&env, "register_from_registry"),
            register_args,
        );

        // Step 5: Set verification key (using set_vk_from_registry to avoid re-entrancy)
        let set_vk_args = soroban_sdk::vec![&env, dao_id.into_val(&env), vk.into_val(&env)];
        env.invoke_contract::<()>(
            &voting_contract,
            &Symbol::new(&env, "set_vk_from_registry"),
            set_vk_args,
        );

        dao_id
    }

    /// Contract version for upgrade tracking.
    pub fn version(env: Env) -> u32 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&VERSION_KEY)
            .unwrap_or(VERSION)
    }

    // Internal helpers

    fn next_dao_id(env: &Env) -> u64 {
        // Lazily record contract version on first mutation
        if !env.storage().instance().has(&VERSION_KEY) {
            env.storage().instance().set(&VERSION_KEY, &VERSION);
            ContractUpgraded {
                from: 0,
                to: VERSION,
            }
            .publish(env);
        }

        let count: u64 = env.storage().instance().get(&DAO_COUNT).unwrap_or(0);
        let new_id = count + 1;
        env.storage().instance().set(&DAO_COUNT, &new_id);
        new_id
    }

    fn dao_key(dao_id: u64) -> (Symbol, u64) {
        (symbol_short!("dao"), dao_id)
    }

    fn member_role_key(dao_id: u64, member: &Address) -> (Symbol, u64, Address) {
        (symbol_short!("mrole"), dao_id, member.clone())
    }

    fn multisig_config_key(dao_id: u64) -> (Symbol, u64) {
        (symbol_short!("msig_cfg"), dao_id)
    }

    fn multisig_proposal_key(dao_id: u64, proposal_id: u64) -> (Symbol, u64, u64) {
        (symbol_short!("msig_prp"), dao_id, proposal_id)
    }

    fn circuit_upgrade_key(dao_id: u64, proposal_id: u64) -> (Symbol, u64, u64) {
        (symbol_short!("c_upgrade"), dao_id, proposal_id)
    }

    fn contract_upgrade_key(dao_id: u64, proposal_id: u64) -> (Symbol, u64, u64) {
        (symbol_short!("upgrade"), dao_id, proposal_id)
    }

    fn next_upgrade_proposal_id(env: &Env) -> u64 {
        let key = symbol_short!("c_upg_cnt");
        let count: u64 = env.storage().instance().get(&key).unwrap_or(0);
        let new_id = count + 1;
        env.storage().instance().set(&key, &new_id);
        new_id
    }

    /// Storage key for a name reservation commitment (issue #734).
    fn name_reservation_key(commitment: &BytesN<32>) -> (Symbol, BytesN<32>) {
        (symbol_short!("nm_rsv"), commitment.clone())
    }

    fn next_multisig_proposal_id(env: &Env) -> u64 {
        let key = symbol_short!("msig_cnt");
        let count: u64 = env.storage().instance().get(&key).unwrap_or(0);
        let new_id = count + 1;
        env.storage().instance().set(&key, &new_id);
        new_id
    }

    fn require_dao_admin(env: &Env, dao_id: u64, admin: &Address) {
        let key = Self::dao_key(dao_id);
        let dao: DaoInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(env, RegistryError::DaoNotFound));

        if admin != &dao.admin {
            panic_with_error!(env, RegistryError::NotAdmin);
        }
    }

    /// Propose a protocol contract upgrade behind DAO-admin approval and a timelock.
    ///
    /// The registry is the governance gate. Target contracts must expose
    /// `apply_upgrade_from_registry` and require this registry contract's auth
    /// before migrating storage or replacing Wasm.
    pub fn propose_contract_upgrade(
        env: Env,
        dao_id: u64,
        target_contract: Address,
        wasm_hash: BytesN<32>,
        rollback_wasm_hash: BytesN<32>,
        from_version: u32,
        to_version: u32,
        storage_version: u32,
        migration_payload: Bytes,
        eta: u64,
        expires_at: u64,
        proposer: Address,
    ) -> u64 {
        Self::bump_instance(&env);
        proposer.require_auth();
        Self::require_dao_admin(&env, dao_id, &proposer);

        let now = env.ledger().timestamp();
        if eta < now.saturating_add(MIN_UPGRADE_DELAY) || expires_at <= eta {
            panic_with_error!(&env, RegistryError::UpgradeInvalidWindow);
        }
        if migration_payload.len() > MAX_UPGRADE_PAYLOAD_LEN {
            panic_with_error!(&env, RegistryError::UpgradePayloadTooLarge);
        }

        let proposal_id = Self::next_upgrade_proposal_id(&env);
        let proposal = ContractUpgradeProposal {
            dao_id,
            target_contract: target_contract.clone(),
            wasm_hash,
            rollback_wasm_hash,
            from_version,
            to_version,
            storage_version,
            migration_payload,
            proposed_at: now,
            eta,
            expires_at,
            executed: false,
            rolled_back: false,
        };

        let key = Self::contract_upgrade_key(dao_id, proposal_id);
        env.storage().persistent().set(&key, &proposal);
        Self::bump_persistent(&env, &key);

        ContractUpgradeProposedEvent {
            dao_id,
            proposal_id,
            target_contract,
            from_version,
            to_version,
            eta,
            expires_at,
        }
        .publish(&env);

        proposal_id
    }

    /// Execute a matured contract upgrade proposal.
    ///
    /// The target contract performs its own version/migration checks before
    /// replacing Wasm, so the registry remains a governance router.
    pub fn execute_contract_upgrade(env: Env, dao_id: u64, proposal_id: u64, executor: Address) {
        Self::bump_instance(&env);
        executor.require_auth();
        Self::require_dao_admin(&env, dao_id, &executor);

        let key = Self::contract_upgrade_key(dao_id, proposal_id);
        let mut proposal: ContractUpgradeProposal = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::UpgradeNotFound));

        let now = env.ledger().timestamp();
        if proposal.executed {
            panic_with_error!(&env, RegistryError::UpgradeAlreadyExecuted);
        }
        if now < proposal.eta {
            panic_with_error!(&env, RegistryError::UpgradeTimelockNotReady);
        }
        if now > proposal.expires_at {
            panic_with_error!(&env, RegistryError::UpgradeExpired);
        }

        let args = soroban_sdk::vec![
            &env,
            proposal.wasm_hash.clone().into_val(&env),
            proposal.from_version.into_val(&env),
            proposal.to_version.into_val(&env),
            proposal.storage_version.into_val(&env),
            proposal.migration_payload.clone().into_val(&env),
        ];
        env.invoke_contract::<()>(
            &proposal.target_contract,
            &Symbol::new(&env, "apply_upgrade_from_registry"),
            args,
        );

        proposal.executed = true;
        env.storage().persistent().set(&key, &proposal);
        Self::bump_persistent(&env, &key);

        ContractUpgradeExecutedEvent {
            dao_id,
            proposal_id,
            target_contract: proposal.target_contract,
            to_version: proposal.to_version,
        }
        .publish(&env);
    }

    /// Roll back an executed upgrade to the pre-approved rollback Wasm hash.
    pub fn rollback_contract_upgrade(env: Env, dao_id: u64, proposal_id: u64, executor: Address) {
        Self::bump_instance(&env);
        executor.require_auth();
        Self::require_dao_admin(&env, dao_id, &executor);

        let key = Self::contract_upgrade_key(dao_id, proposal_id);
        let mut proposal: ContractUpgradeProposal = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::UpgradeNotFound));

        if !proposal.executed || proposal.rolled_back {
            panic_with_error!(&env, RegistryError::UpgradeInvalidWindow);
        }

        let args = soroban_sdk::vec![
            &env,
            proposal.rollback_wasm_hash.clone().into_val(&env),
            proposal.to_version.into_val(&env),
            proposal.from_version.into_val(&env),
        ];
        env.invoke_contract::<()>(
            &proposal.target_contract,
            &Symbol::new(&env, "rollback_upgrade_from_registry"),
            args,
        );

        proposal.rolled_back = true;
        env.storage().persistent().set(&key, &proposal);
        Self::bump_persistent(&env, &key);

        ContractRollbackEvent {
            dao_id,
            proposal_id,
            target_contract: proposal.target_contract,
            to_version: proposal.from_version,
        }
        .publish(&env);
    }

    pub fn get_contract_upgrade_proposal(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
    ) -> ContractUpgradeProposal {
        Self::bump_instance(&env);
        let key = Self::contract_upgrade_key(dao_id, proposal_id);
        let proposal = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::UpgradeNotFound));
        Self::bump_persistent(&env, &key);
        proposal
    }

    pub fn propose_circuit_upgrade(
        env: Env,
        dao_id: u64,
        from_circuit_id: String,
        to_circuit_id: String,
        circuit_type: String,
        deadline: u64,
        proposer: Address,
    ) -> u64 {
        Self::bump_instance(&env);
        proposer.require_auth();

        let key = Self::dao_key(dao_id);
        let dao: DaoInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::DaoNotFound));

        if proposer != dao.admin {
            panic_with_error!(&env, RegistryError::NotAdmin);
        }

        let now = env.ledger().timestamp();
        if deadline <= now {
            panic_with_error!(&env, RegistryError::DaoNotFound);
        }

        let proposal_id = Self::next_upgrade_proposal_id(&env);

        let proposal = CircuitUpgradeProposal {
            dao_id,
            from_circuit_id: from_circuit_id.clone(),
            to_circuit_id: to_circuit_id.clone(),
            circuit_type: circuit_type.clone(),
            proposed_at: now,
            deadline,
            approved: false,
        };

        let proposal_key = Self::circuit_upgrade_key(dao_id, proposal_id);
        env.storage().persistent().set(&proposal_key, &proposal);
        Self::bump_persistent(&env, &proposal_key);

        CircuitUpgradeProposedEvent {
            dao_id,
            from_circuit_id,
            to_circuit_id,
            deadline,
        }
        .publish(&env);

        proposal_id
    }

    pub fn approve_circuit_upgrade(env: Env, dao_id: u64, proposal_id: u64, approver: Address) {
        Self::bump_instance(&env);
        approver.require_auth();

        let proposal_key = Self::circuit_upgrade_key(dao_id, proposal_id);
        let mut proposal: CircuitUpgradeProposal = env
            .storage()
            .persistent()
            .get(&proposal_key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::DaoNotFound));

        let dao_key = Self::dao_key(dao_id);
        let dao: DaoInfo = env
            .storage()
            .persistent()
            .get(&dao_key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::DaoNotFound));

        if approver != dao.admin {
            panic_with_error!(&env, RegistryError::NotAdmin);
        }

        let now = env.ledger().timestamp();
        if now > proposal.deadline {
            panic_with_error!(&env, RegistryError::DaoNotFound);
        }

        proposal.approved = true;
        env.storage().persistent().set(&proposal_key, &proposal);
        Self::bump_persistent(&env, &proposal_key);

        CircuitUpgradeApprovedEvent {
            dao_id,
            proposal_id,
        }
        .publish(&env);
    }

    // ── Commit-reveal name reservation (SPIKE-055 / issue #734) ─────────────
    //
    // Optional front-running mitigation for `create_dao`. The caller hashes
    //   commitment = SHA-256(name || nonce || caller_address)
    // off-chain and stores only the hash. After REVEAL_MIN_WAIT_LEDGERS ledgers
    // the caller can prove ownership of the name by supplying the preimage in
    // `create_dao`. The DAO's canonical identity is always the numeric `dao_id`
    // assigned at creation; names are non-unique labels on that identity.

    /// Store a name reservation commitment. Only the `reserver` address may
    /// later reveal it. The same commitment hash may not be re-committed while
    /// an unexpired reservation exists.
    pub fn commit_name(env: Env, commitment: BytesN<32>, reserver: Address) {
        Self::bump_instance(&env);
        reserver.require_auth();

        let key = Self::name_reservation_key(&commitment);
        let now_ledger = env.ledger().sequence();

        // If a reservation already exists and has not expired, reject.
        if let Some(existing) = env.storage().temporary().get::<_, NameReservation>(&key) {
            if existing.expires_at >= now_ledger {
                panic_with_error!(&env, RegistryError::NameAlreadyReserved);
            }
        }

        let reservation = NameReservation {
            reserver,
            commitment: commitment.clone(),
            committed_at: now_ledger,
            expires_at: now_ledger + RESERVATION_TTL_LEDGERS,
        };
        env.storage().temporary().set(&key, &reservation);
        // Extend TTL so the entry survives until expiry.
        env.storage().temporary().extend_ttl(
            &key,
            RESERVATION_TTL_LEDGERS,
            RESERVATION_TTL_LEDGERS,
        );
    }

    /// Read back a name reservation (for frontend UX / availability checks).
    pub fn get_name_reservation(env: Env, commitment: BytesN<32>) -> Option<NameReservation> {
        Self::bump_instance(&env);
        let key = Self::name_reservation_key(&commitment);
        let now_ledger = env.ledger().sequence();
        env.storage()
            .temporary()
            .get(&key)
            .filter(|r: &NameReservation| r.expires_at >= now_ledger)
    }

    pub fn get_circuit_upgrade_proposal(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
    ) -> CircuitUpgradeProposal {
        Self::bump_instance(&env);
        let proposal_key = Self::circuit_upgrade_key(dao_id, proposal_id);
        let proposal: CircuitUpgradeProposal = env
            .storage()
            .persistent()
            .get(&proposal_key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::DaoNotFound));
        Self::bump_persistent(&env, &proposal_key);
        proposal
    }
}

#[cfg(test)]
mod test;
