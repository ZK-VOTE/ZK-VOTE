#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    BytesN, Env, String, Symbol, Vec, U256,
};

use zkvote_groth16::{verify_groth16, Proof, VerificationKey};

const VERSION: u32 = 1;
const VERSION_KEY: Symbol = symbol_short!("ver");
const GOVERNANCE: Symbol = symbol_short!("gov");
const ADMINS: Symbol = symbol_short!("admins");
const VK_PROPOSAL_COUNTER: Symbol = symbol_short!("vk_pr_cnt");
/// Minimum timelock (seconds) for VK upgrades — not caller-chosen (#650)
const MIN_VK_TIMELOCK: Symbol = symbol_short!("min_tl");
/// Required distinct admin approvals for VK upgrades (#650)
const VK_QUORUM: Symbol = symbol_short!("vk_qrm");

const DEFAULT_MIN_VK_TIMELOCK: u64 = 86_400; // 24h
const DEFAULT_VK_QUORUM: u32 = 1;

const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
const INSTANCE_TTL_EXTEND: u32 = 535_680;
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 535_680;

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum RegistryError {
    NotGovernance = 1,
    CircuitNotFound = 2,
    CircuitAlreadyRegistered = 3,
    InvalidCircuitType = 4,
    MigrationNotFound = 5,
    MigrationAlreadyExists = 6,
    MigrationDeadlinePassed = 7,
    CircuitExpired = 8,
    VkProposalNotFound = 9,
    VkProposalAlreadyExecuted = 10,
    VkProposalTimelockNotElapsed = 11,
    VkProposalQuorumNotMet = 12,
    VkProposalAlreadyApproved = 13,
    VkProposalNotActive = 14,
    VkProposalInvalidQuorum = 15,
    VkProposalAlreadyCancelled = 16,
    NotAdmin = 17,
    /// #726: Circuit registration rejected because no ceremony transcript hash
    /// was provided. Every new circuit artifact must be backed by an auditable
    /// trusted-setup transcript whose SHA-256 hash is recorded on-chain so
    /// downstream verifiers can trace the VK to the ceremony.
    MissingCeremonyProvenance = 18,
}

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CircuitType {
    Vote,
    Comment,
    Tally,
}

#[contracttype]
#[derive(Clone)]
pub struct CircuitInfo {
    pub circuit_id: String,
    pub circuit_type: CircuitType,
    pub vk: VerificationKey,
    pub wasm_hash: BytesN<32>,
    pub registered_at: u64,
    pub expiration: u64,
    pub num_public_signals: u32,
    /// #726 — SHA-256 hash of the MPC trusted-setup ceremony transcript that
    /// produced the parameters embedded in `vk`. Computed by
    /// `circuits/ceremony/verify-ceremony.js` and stored here so any party can
    /// independently verify that the on-chain VK matches the published
    /// transcript without re-running the full ceremony.
    ///
    /// `None` is rejected by `register_circuit` for new registrations; it is
    /// kept optional in the storage type only to preserve backward
    /// compatibility with circuit records written by earlier versions of this
    /// contract that pre-date this field.
    pub ceremony_transcript_hash: Option<BytesN<32>>,
}

#[contracttype]
#[derive(Clone)]
pub struct DaoMigration {
    pub dao_id: u64,
    pub from_circuit_id: String,
    pub to_circuit_id: String,
    pub migration_start: u64,
    pub deadline: u64,
    pub active: bool,
}

#[contracttype]
#[derive(Clone)]
pub struct CircuitVKMap {
    pub vk: VerificationKey,
    pub num_public_signals: u32,
}

/// Additive, richer VK record. `get_vk` is unchanged for existing callers;
/// this struct is returned by the new `get_vk_record` getter so clients can
/// bind a proof to one exact circuit instance (version + ceremony transcript).
#[contracttype]
#[derive(Clone)]
pub struct VkRecord {
    pub vk: VerificationKey,
    pub num_public_signals: u32,
    pub version: u32,
    pub ceremony_transcript_hash: Option<String>,
    pub circuit_id: String,
    pub registered_at: u64,
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
    /// Distinct approver addresses (duplicate approvals rejected) (#650)
    pub approvers: Vec<Address>,
    pub status: VkProposalStatus,
    pub dao_id: Option<u64>,
}

#[contracttype]
pub enum DataKey {
    Circuit(String, CircuitType),
    DaoMigration(u64),
    DaoCurrentCircuit(u64, CircuitType),
    VkProposal(u32),
    VkProposalCounter,
    DaoVkProposal(u64),
    /// Per-circuit version, incremented when a VkProposal is executed.
    CircuitVersion(String, CircuitType),
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct CircuitRegisteredEvent {
    #[topic]
    pub circuit_id: String,
    pub circuit_type: CircuitType,
    pub registered_at: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct DaoMigrationEvent {
    #[topic]
    pub dao_id: u64,
    pub from_circuit_id: String,
    pub to_circuit_id: String,
    pub deadline: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct CircuitUpgradedEvent {
    #[topic]
    pub dao_id: u64,
    pub circuit_type: CircuitType,
    pub to_circuit_id: String,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VkProposalCreatedEvent {
    #[topic]
    pub proposal_id: u32,
    pub circuit_id: String,
    pub circuit_type: CircuitType,
    pub proposed_by: Address,
    pub execute_after: u64,
    pub required_approvals: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VkProposalApprovedEvent {
    #[topic]
    pub proposal_id: u32,
    pub approver: Address,
    pub current_approvals: u32,
    pub required_approvals: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VkProposalExecutedEvent {
    #[topic]
    pub proposal_id: u32,
    pub circuit_id: String,
    pub circuit_type: CircuitType,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VkProposalCancelledEvent {
    #[topic]
    pub proposal_id: u32,
    pub cancelled_by: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct CeremonyHashUpdatedEvent {
    #[topic]
    pub circuit_id: String,
    pub circuit_type: CircuitType,
    pub ceremony_transcript_hash: String,
}

#[contract]
pub struct CircuitRegistry;

#[contractimpl]
impl CircuitRegistry {
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

    pub fn __constructor(env: Env, governance: Address) {
        if env.storage().instance().has(&VERSION_KEY) {
            panic_with_error!(&env, RegistryError::NotGovernance);
        }
        env.storage().instance().set(&VERSION_KEY, &VERSION);
        env.storage().instance().set(&GOVERNANCE, &governance);
        // Seed admins with governance so VK upgrades are not permissionless (#650)
        let mut admins: Vec<Address> = Vec::new(&env);
        admins.push_back(governance.clone());
        env.storage().instance().set(&ADMINS, &admins);
        env.storage()
            .instance()
            .set(&MIN_VK_TIMELOCK, &DEFAULT_MIN_VK_TIMELOCK);
        env.storage().instance().set(&VK_QUORUM, &DEFAULT_VK_QUORUM);
    }

    fn assert_governance(env: &Env) {
        let governance: Address = env.storage().instance().get(&GOVERNANCE).unwrap();
        governance.require_auth();
    }

    fn is_admin(env: &Env, addr: &Address) -> bool {
        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&ADMINS)
            .unwrap_or_else(|| Vec::new(env));
        for a in admins.iter() {
            if &a == addr {
                return true;
            }
        }
        // Governance address is always an admin
        let governance: Address = env.storage().instance().get(&GOVERNANCE).unwrap();
        addr == &governance
    }

    fn assert_admin(env: &Env, addr: &Address) {
        addr.require_auth();
        if !Self::is_admin(env, addr) {
            panic_with_error!(env, RegistryError::NotAdmin);
        }
    }

    /// Governance-only: replace the admin set used for VK upgrade approvals.
    pub fn set_admins(env: Env, admins: Vec<Address>) {
        Self::bump_instance(&env);
        Self::assert_governance(&env);
        if admins.is_empty() {
            panic_with_error!(&env, RegistryError::VkProposalInvalidQuorum);
        }
        env.storage().instance().set(&ADMINS, &admins);
    }

    /// Governance-only: configure minimum timelock and required approvals.
    pub fn set_vk_upgrade_params(env: Env, min_timelock: u64, required_approvals: u32) {
        Self::bump_instance(&env);
        Self::assert_governance(&env);
        if required_approvals == 0 {
            panic_with_error!(&env, RegistryError::VkProposalInvalidQuorum);
        }
        env.storage()
            .instance()
            .set(&MIN_VK_TIMELOCK, &min_timelock);
        env.storage()
            .instance()
            .set(&VK_QUORUM, &required_approvals);
    }

    pub fn register_circuit(
        env: Env,
        circuit_id: String,
        circuit_type: CircuitType,
        vk: VerificationKey,
        wasm_hash: BytesN<32>,
        expiration: u64,
        num_public_signals: u32,
        // #726: SHA-256 hash of the MPC ceremony transcript (output of
        // `circuits/ceremony/verify-ceremony.js`). Required for all new
        // circuit registrations; absent provenance is rejected so that
        // downstream verifiers can always trace any on-chain VK back to
        // its trusted-setup ceremony.
        ceremony_transcript_hash: Option<BytesN<32>>,
    ) {
        Self::bump_instance(&env);
        Self::assert_governance(&env);

        // #726: reject registration without ceremony provenance.
        if ceremony_transcript_hash.is_none() {
            panic_with_error!(&env, RegistryError::MissingCeremonyProvenance);
        }

        let key = DataKey::Circuit(circuit_id.clone(), circuit_type);
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, RegistryError::CircuitAlreadyRegistered);
        }

        let circuit = CircuitInfo {
            circuit_id: circuit_id.clone(),
            circuit_type,
            vk,
            wasm_hash,
            registered_at: env.ledger().timestamp(),
            expiration,
            num_public_signals,
            ceremony_transcript_hash,
        };

        env.storage().persistent().set(&key, &circuit);
        Self::bump_persistent(&env, &key);

        // Single source of truth for VK versioning. Starts at 1 and is bumped
        // by execute_vk_upgrade, so clients can detect stale cached VKs.
        let version_key = DataKey::CircuitVersion(circuit_id.clone(), circuit_type);
        env.storage().persistent().set(&version_key, &1u32);
        Self::bump_persistent(&env, &version_key);

        CircuitRegisteredEvent {
            circuit_id,
            circuit_type,
            registered_at: env.ledger().timestamp(),
        }
        .publish(&env);
    }

    pub fn get_circuit(env: Env, circuit_id: String, circuit_type: CircuitType) -> CircuitInfo {
        Self::bump_instance(&env);
        let key = DataKey::Circuit(circuit_id.clone(), circuit_type);
        let circuit: CircuitInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::CircuitNotFound));
        Self::bump_persistent(&env, &key);
        circuit
    }

    /// Current on-chain version of a circuit's verification key.
    pub fn get_circuit_version(
        env: Env,
        circuit_id: String,
        circuit_type: CircuitType,
    ) -> u32 {
        Self::bump_instance(&env);
        let key = DataKey::CircuitVersion(circuit_id.clone(), circuit_type);
        let version: u32 = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::CircuitNotFound));
        Self::bump_persistent(&env, &key);
        version
    }

    pub fn get_vk(env: Env, circuit_id: String, circuit_type: CircuitType) -> CircuitVKMap {
        Self::bump_instance(&env);
        let key = DataKey::Circuit(circuit_id.clone(), circuit_type);
        let circuit: CircuitInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::CircuitNotFound));

        let now = env.ledger().timestamp();
        if circuit.expiration != 0 && now > circuit.expiration {
            panic_with_error!(&env, RegistryError::CircuitExpired);
        }

        Self::bump_persistent(&env, &key);
        CircuitVKMap {
            vk: circuit.vk,
            num_public_signals: circuit.num_public_signals,
        }
    }

    /// Governance-only ceremony transcript hash setter. Additive: does not
    /// change `register_circuit` or any existing storage key/signature.
    pub fn set_ceremony_hash(
        env: Env,
        circuit_id: String,
        circuit_type: CircuitType,
        ceremony_transcript_hash: String,
    ) {
        Self::bump_instance(&env);
        Self::assert_governance(&env);

        if ceremony_transcript_hash.is_empty() {
            panic_with_error!(&env, RegistryError::InvalidCeremonyHash);
        }

        let circuit_key = DataKey::Circuit(circuit_id.clone(), circuit_type);
        if !env.storage().persistent().has(&circuit_key) {
            panic_with_error!(&env, RegistryError::CircuitNotFound);
        }

        let key = DataKey::CeremonyHash(circuit_id.clone(), circuit_type);
        env.storage()
            .persistent()
            .set(&key, &ceremony_transcript_hash);
        Self::bump_persistent(&env, &key);

        CeremonyHashUpdatedEvent {
            circuit_id,
            circuit_type,
            ceremony_transcript_hash,
        }
        .publish(&env);
    }

    /// Additive richer getter. Returns the same VK as `get_vk` plus the
    /// monotonic version, ceremony transcript hash, circuit id and timestamp.
    pub fn get_vk_record(env: Env, circuit_id: String, circuit_type: CircuitType) -> VkRecord {
        Self::bump_instance(&env);
        let key = DataKey::Circuit(circuit_id.clone(), circuit_type);
        let circuit: CircuitInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::CircuitNotFound));

        let now = env.ledger().timestamp();
        if circuit.expiration != 0 && now > circuit.expiration {
            panic_with_error!(&env, RegistryError::CircuitExpired);
        }
        Self::bump_persistent(&env, &key);

        let version_key = DataKey::CircuitVersion(circuit_id.clone(), circuit_type);
        let version: u32 = env
            .storage()
            .persistent()
            .get(&version_key)
            .unwrap_or(1);

        let ceremony_key = DataKey::CeremonyHash(circuit_id.clone(), circuit_type);
        let ceremony_transcript_hash: Option<String> = env
            .storage()
            .persistent()
            .get(&ceremony_key);

        VkRecord {
            vk: circuit.vk,
            num_public_signals: circuit.num_public_signals,
            version,
            ceremony_transcript_hash,
            circuit_id,
            registered_at: circuit.registered_at,
        }
    }

    pub fn verify_tally_proof(
        env: Env,
        dao_id: u64,
        proof: Proof,
        public_inputs: Vec<U256>,
    ) -> bool {
        let circuit_id = Self::get_dao_current_circuit(env.clone(), dao_id, CircuitType::Tally);
        let vk_map = Self::get_vk(env.clone(), circuit_id, CircuitType::Tally);
        verify_groth16(&env, &vk_map.vk, &proof, &public_inputs)
    }

    pub fn migrate_dao(
        env: Env,
        dao_id: u64,
        from_circuit_id: String,
        to_circuit_id: String,
        circuit_type: CircuitType,
        deadline: u64,
    ) {
        Self::bump_instance(&env);
        Self::assert_governance(&env);

        let from_key = DataKey::Circuit(from_circuit_id.clone(), circuit_type);
        if !env.storage().persistent().has(&from_key) {
            panic_with_error!(&env, RegistryError::CircuitNotFound);
        }

        let to_key = DataKey::Circuit(to_circuit_id.clone(), circuit_type);
        if !env.storage().persistent().has(&to_key) {
            panic_with_error!(&env, RegistryError::CircuitNotFound);
        }

        let migration_key = DataKey::DaoMigration(dao_id);
        if env.storage().persistent().has(&migration_key) {
            let existing: DaoMigration = env.storage().persistent().get(&migration_key).unwrap();
            if existing.active {
                panic_with_error!(&env, RegistryError::MigrationAlreadyExists);
            }
        }

        let now = env.ledger().timestamp();
        if deadline <= now {
            panic_with_error!(&env, RegistryError::MigrationDeadlinePassed);
        }

        let migration = DaoMigration {
            dao_id,
            from_circuit_id: from_circuit_id.clone(),
            to_circuit_id: to_circuit_id.clone(),
            migration_start: now,
            deadline,
            active: true,
        };

        env.storage().persistent().set(&migration_key, &migration);
        Self::bump_persistent(&env, &migration_key);

        DaoMigrationEvent {
            dao_id,
            from_circuit_id,
            to_circuit_id,
            deadline,
        }
        .publish(&env);
    }

    pub fn finalize_migration(env: Env, dao_id: u64, circuit_type: CircuitType) {
        Self::bump_instance(&env);
        Self::assert_governance(&env);

        let migration_key = DataKey::DaoMigration(dao_id);
        let mut migration: DaoMigration = env
            .storage()
            .persistent()
            .get(&migration_key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::MigrationNotFound));

        let now = env.ledger().timestamp();
        if now < migration.deadline {
            panic_with_error!(&env, RegistryError::MigrationDeadlinePassed);
        }

        migration.active = false;
        env.storage().persistent().set(&migration_key, &migration);
        Self::bump_persistent(&env, &migration_key);

        let current_key = DataKey::DaoCurrentCircuit(dao_id, circuit_type);
        env.storage()
            .persistent()
            .set(&current_key, &migration.to_circuit_id);
        Self::bump_persistent(&env, &current_key);

        CircuitUpgradedEvent {
            dao_id,
            circuit_type,
            to_circuit_id: migration.to_circuit_id,
        }
        .publish(&env);
    }

    pub fn get_migration(env: Env, dao_id: u64) -> DaoMigration {
        Self::bump_instance(&env);
        let migration_key = DataKey::DaoMigration(dao_id);
        let migration: DaoMigration = env
            .storage()
            .persistent()
            .get(&migration_key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::MigrationNotFound));
        Self::bump_persistent(&env, &migration_key);
        migration
    }

    pub fn is_in_overlap_window(env: Env, dao_id: u64) -> bool {
        Self::bump_instance(&env);
        let migration_key = DataKey::DaoMigration(dao_id);
        if !env.storage().persistent().has(&migration_key) {
            return false;
        }
        let migration: DaoMigration = env.storage().persistent().get(&migration_key).unwrap();
        if !migration.active {
            return false;
        }
        let now = env.ledger().timestamp();
        now >= migration.migration_start && now < migration.deadline
    }

    pub fn get_dao_current_circuit(env: Env, dao_id: u64, circuit_type: CircuitType) -> String {
        Self::bump_instance(&env);
        let key = DataKey::DaoCurrentCircuit(dao_id, circuit_type);
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::CircuitNotFound))
    }

    pub fn set_dao_current_circuit(
        env: Env,
        dao_id: u64,
        circuit_type: CircuitType,
        circuit_id: String,
    ) {
        Self::bump_instance(&env);
        Self::assert_governance(&env);

        let circuit_key = DataKey::Circuit(circuit_id.clone(), circuit_type);
        if !env.storage().persistent().has(&circuit_key) {
            panic_with_error!(&env, RegistryError::CircuitNotFound);
        }

        let current_key = DataKey::DaoCurrentCircuit(dao_id, circuit_type);
        env.storage()
            .persistent()
            .set(&current_key, &circuit_id.clone());
        Self::bump_persistent(&env, &current_key);
    }

    /// Compensating step for a release-train rollback: restore the circuit ID
    /// that was active before a migration. Governance-gated like the forward
    /// setter, and additive-only — it never deletes a registered circuit.
    pub fn restore_current_circuit(
        env: Env,
        dao_id: u64,
        circuit_type: CircuitType,
        circuit_id: String,
    ) {
        Self::bump_instance(&env);
        Self::assert_governance(&env);

        let circuit_key = DataKey::Circuit(circuit_id.clone(), circuit_type.clone());
        if !env.storage().persistent().has(&circuit_key) {
            panic_with_error!(&env, RegistryError::CircuitNotFound);
        }
        let current_key = DataKey::DaoCurrentCircuit(dao_id, circuit_type.clone());
        env.storage().persistent().set(&current_key, &circuit_id);
        Self::bump_persistent(&env, &current_key);
        CircuitUpgradedEvent {
            dao_id,
            circuit_type,
            to_circuit_id: circuit_id,
        }
        .publish(&env);
    }

    pub fn propose_vk_upgrade(
        env: Env,
        circuit_id: String,
        circuit_type: CircuitType,
        new_vk: VerificationKey,
        new_wasm_hash: BytesN<32>,
        // Caller-supplied values are IGNORED for security — contract config wins (#650)
        _timelock_duration: u64,
        _required_approvals: u32,
        dao_id: Option<u64>,
        proposer: Address,
    ) -> u32 {
        Self::bump_instance(&env);
        Self::assert_admin(&env, &proposer);

        let circuit_key = DataKey::Circuit(circuit_id.clone(), circuit_type);
        if !env.storage().persistent().has(&circuit_key) {
            panic_with_error!(&env, RegistryError::CircuitNotFound);
        }

        let required_approvals: u32 = env
            .storage()
            .instance()
            .get(&VK_QUORUM)
            .unwrap_or(DEFAULT_VK_QUORUM);
        if required_approvals == 0 {
            panic_with_error!(&env, RegistryError::VkProposalInvalidQuorum);
        }

        let min_timelock: u64 = env
            .storage()
            .instance()
            .get(&MIN_VK_TIMELOCK)
            .unwrap_or(DEFAULT_MIN_VK_TIMELOCK);

        let now = env.ledger().timestamp();
        let execute_after = now.saturating_add(min_timelock);

        let counter_key = DataKey::VkProposalCounter;
        let proposal_id: u32 = env
            .storage()
            .instance()
            .get(&counter_key)
            .unwrap_or(0u32)
            .saturating_add(1);
        env.storage().instance().set(&counter_key, &proposal_id);

        let proposal = VkProposal {
            id: proposal_id,
            circuit_id: circuit_id.clone(),
            circuit_type,
            new_vk,
            new_wasm_hash,
            proposed_by: proposer.clone(),
            proposed_at: now,
            execute_after,
            required_approvals,
            approvers: Vec::new(&env),
            status: VkProposalStatus::Pending,
            dao_id,
        };

        let proposal_key = DataKey::VkProposal(proposal_id);
        env.storage().persistent().set(&proposal_key, &proposal);
        Self::bump_persistent(&env, &proposal_key);

        if let Some(did) = dao_id {
            let dao_proposal_key = DataKey::DaoVkProposal(did);
            env.storage()
                .persistent()
                .set(&dao_proposal_key, &proposal_id);
            Self::bump_persistent(&env, &dao_proposal_key);
        }

        VkProposalCreatedEvent {
            proposal_id,
            circuit_id: circuit_id.clone(),
            circuit_type,
            proposed_by: proposer,
            execute_after,
            required_approvals,
        }
        .publish(&env);

        proposal_id
    }

    pub fn approve_vk_upgrade(env: Env, proposal_id: u32, approver: Address) {
        Self::bump_instance(&env);
        Self::assert_admin(&env, &approver);

        let proposal_key = DataKey::VkProposal(proposal_id);
        let mut proposal: VkProposal = env
            .storage()
            .persistent()
            .get(&proposal_key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::VkProposalNotFound));

        if proposal.status != VkProposalStatus::Pending {
            panic_with_error!(&env, RegistryError::VkProposalNotActive);
        }

        for a in proposal.approvers.iter() {
            if a == approver {
                panic_with_error!(&env, RegistryError::VkProposalAlreadyApproved);
            }
        }

        proposal.approvers.push_back(approver.clone());
        env.storage().persistent().set(&proposal_key, &proposal);
        Self::bump_persistent(&env, &proposal_key);

        VkProposalApprovedEvent {
            proposal_id,
            approver,
            current_approvals: proposal.approvers.len(),
            required_approvals: proposal.required_approvals,
        }
        .publish(&env);
    }

    pub fn execute_vk_upgrade(env: Env, proposal_id: u32, executor: Address) {
        Self::bump_instance(&env);
        // Only governance may execute (mirrors token clawback pattern) (#650)
        Self::assert_governance(&env);
        executor.require_auth();

        let proposal_key = DataKey::VkProposal(proposal_id);
        let mut proposal: VkProposal = env
            .storage()
            .persistent()
            .get(&proposal_key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::VkProposalNotFound));

        if proposal.status != VkProposalStatus::Pending {
            panic_with_error!(&env, RegistryError::VkProposalNotActive);
        }

        let now = env.ledger().timestamp();
        if now < proposal.execute_after {
            panic_with_error!(&env, RegistryError::VkProposalTimelockNotElapsed);
        }

        if proposal.approvers.len() < proposal.required_approvals {
            panic_with_error!(&env, RegistryError::VkProposalQuorumNotMet);
        }

        proposal.status = VkProposalStatus::Executed;
        env.storage().persistent().set(&proposal_key, &proposal);
        Self::bump_persistent(&env, &proposal_key);

        let circuit_key = DataKey::Circuit(proposal.circuit_id.clone(), proposal.circuit_type);
        let mut circuit: CircuitInfo = env
            .storage()
            .persistent()
            .get(&circuit_key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::CircuitNotFound));

        circuit.vk = proposal.new_vk.clone();
        circuit.wasm_hash = proposal.new_wasm_hash;
        circuit.registered_at = now;
        env.storage().persistent().set(&circuit_key, &circuit);
        Self::bump_persistent(&env, &circuit_key);

        let version_key =
            DataKey::CircuitVersion(proposal.circuit_id.clone(), proposal.circuit_type);
        let previous_version: u32 = env.storage().persistent().get(&version_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&version_key, &(previous_version + 1));
        Self::bump_persistent(&env, &version_key);

        VkProposalExecutedEvent {
            proposal_id,
            circuit_id: proposal.circuit_id.clone(),
            circuit_type: proposal.circuit_type,
        }
        .publish(&env);
    }

    pub fn cancel_vk_upgrade(env: Env, proposal_id: u32, canceller: Address) {
        Self::bump_instance(&env);
        canceller.require_auth();

        let proposal_key = DataKey::VkProposal(proposal_id);
        let mut proposal: VkProposal = env
            .storage()
            .persistent()
            .get(&proposal_key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::VkProposalNotFound));

        if proposal.status != VkProposalStatus::Pending {
            panic_with_error!(&env, RegistryError::VkProposalNotActive);
        }

        if proposal.proposed_by != canceller {
            let governance: Address = env.storage().instance().get(&GOVERNANCE).unwrap();
            if governance != canceller {
                panic_with_error!(&env, RegistryError::NotGovernance);
            }
        }

        proposal.status = VkProposalStatus::Cancelled;
        env.storage().persistent().set(&proposal_key, &proposal);
        Self::bump_persistent(&env, &proposal_key);

        VkProposalCancelledEvent {
            proposal_id,
            cancelled_by: canceller,
        }
        .publish(&env);
    }

    pub fn get_vk_proposal(env: Env, proposal_id: u32) -> VkProposal {
        Self::bump_instance(&env);
        let proposal_key = DataKey::VkProposal(proposal_id);
        env.storage()
            .persistent()
            .get(&proposal_key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::VkProposalNotFound))
    }

    pub fn get_dao_vk_proposal(env: Env, dao_id: u64) -> Option<VkProposal> {
        Self::bump_instance(&env);
        let dao_proposal_key = DataKey::DaoVkProposal(dao_id);
        if !env.storage().persistent().has(&dao_proposal_key) {
            return None;
        }
        let proposal_id: u32 = env.storage().persistent().get(&dao_proposal_key).unwrap();
        let proposal_key = DataKey::VkProposal(proposal_id);
        env.storage().persistent().get(&proposal_key)
    }

    pub fn version(env: Env) -> u32 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&VERSION_KEY)
            .unwrap_or(VERSION)
    }
}

// Additive regression tests for the ceremony-hash / version record. Kept in
// lib.rs so no existing test file needs to be touched.
#[cfg(test)]
mod registry_rotation_tests {
    extern crate std;
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

    fn test_vk(env: &Env, fill: u8) -> VerificationKey {
        let alpha = BytesN::from_array(env, &[fill; 64]);
        let g2 = BytesN::from_array(env, &[fill; 128]);
        VerificationKey {
            alpha: alpha.clone(),
            beta: g2.clone(),
            gamma: g2.clone(),
            delta: g2,
            ic: Vec::from_array(env, [alpha]),
        }
    }

    #[test]
    fn vk_record_tracks_ceremony_hash_and_rotation_version() {
        let env = Env::default();
        env.mock_all_auths();
        let governance = Address::generate(&env);
        let registry = env.register(CircuitRegistry, (governance.clone(),));
        let client = CircuitRegistryClient::new(&env, &registry);

        let circuit_id = String::from_str(&env, "vote_v1");
        let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);
        client.register_circuit(
            &circuit_id,
            &CircuitType::Vote,
            &test_vk(&env, 1),
            &wasm_hash,
            &0,
            &5,
        );

        let initial = client.get_vk_record(&circuit_id, &CircuitType::Vote);
        assert_eq!(initial.version, 1);
        assert_eq!(initial.num_public_signals, 5);
        assert_eq!(initial.ceremony_transcript_hash, None);

        let ceremony = String::from_str(&env, "ceremony-abc123");
        client.set_ceremony_hash(&circuit_id, &CircuitType::Vote, &ceremony);
        let with_hash = client.get_vk_record(&circuit_id, &CircuitType::Vote);
        assert_eq!(with_hash.ceremony_transcript_hash, Some(ceremony));

        let start = env.ledger().timestamp();
        let proposal_id = client.propose_vk_upgrade(
            &circuit_id,
            &CircuitType::Vote,
            &test_vk(&env, 2),
            &wasm_hash,
            &10,
            &1,
            &Some(1u64),
            &governance,
        );
        client.approve_vk_upgrade(&proposal_id, &governance);
        env.ledger().with_mut(|l| l.timestamp = start + 11);
        client.execute_vk_upgrade(&proposal_id, &governance);

        let rotated = client.get_vk_record(&circuit_id, &CircuitType::Vote);
        assert_eq!(rotated.version, 2);
        assert_eq!(rotated.num_public_signals, 5);
        assert_eq!(
            rotated.ceremony_transcript_hash,
            Some(String::from_str(&env, "ceremony-abc123"))
        );

        // The original getter stays byte-for-byte compatible.
        assert_eq!(client.get_vk(&circuit_id, &CircuitType::Vote).num_public_signals, 5);
    }
}

#[cfg(test)]
mod test;
