//! Upgrade, rollback, and circuit-registry migration hooks.
//!
//! Invariants:
//! - Upgrades are registry-gated; the registry enforces DAO governance and the
//!   timelock. This module only validates version monotonicity and payload size.
//! - `VERSION` and `STORAGE_VERSION` keys are append-only in value; a storage
//!   downgrade is rejected with `StorageVersionDowngrade`.
//! - Each upgrade writes `UpgradeMigration(to_version)` and emits both
//!   `StorageMigratedEvent` and `ContractUpgraded` before swapping Wasm.

#[allow(unused_imports)]
use soroban_sdk::{
    panic_with_error, symbol_short, Address, Bytes, BytesN, Env, IntoVal, String, Symbol, Vec, U256,
};

use crate::*;


/// Constructor: Initialize contract with MembershipTree address
pub(crate) fn __constructor(env: Env, tree_contract: Address, registry: Address, guardian: Address) {

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


/// Current persistent storage layout version.
pub(crate) fn storage_version(env: Env) -> u32 {

        crate::Voting::bump_instance(&env);
        env.storage()
            .instance()
            .get(&STORAGE_VERSION_KEY)
            .unwrap_or(STORAGE_VERSION)
    
}


/// Version negotiation metadata for clients before submitting transactions.
pub(crate) fn storage_layout(env: Env) -> StorageLayoutInfo {

        crate::Voting::bump_instance(&env);
        let contract_version = crate::Voting::version(env.clone());
        let storage_version = crate::Voting::storage_version(env.clone());
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
pub(crate) fn migration_for_version(env: Env, version: u32) -> Option<ContractMigrationInfo> {

        crate::Voting::bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::UpgradeMigration(version))
    
}


/// Registry-gated upgrade entrypoint.
///
/// The registry enforces DAO-admin governance and the timelock. This hook
/// verifies the expected current version, records storage migration
/// metadata, then swaps this contract's Wasm.
pub(crate) fn apply_upgrade_from_registry(
        env: Env,
        wasm_hash: BytesN<32>,
        from_version: u32,
        to_version: u32,
        storage_version: u32,
        migration_payload: Bytes,
    ) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_registry(&env);

        let current_version = crate::Voting::version(env.clone());
        if current_version != from_version || to_version <= from_version {
            panic_with_error!(&env, VotingError::UpgradeVersionMismatch);
        }
        let current_storage_version = crate::Voting::storage_version(env.clone());
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
        crate::Voting::bump_persistent(&env, &key);

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
pub(crate) fn rollback_upgrade_from_registry(
        env: Env,
        wasm_hash: BytesN<32>,
        from_version: u32,
        to_version: u32,
    ) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_registry(&env);

        let current_version = crate::Voting::version(env.clone());
        if current_version != from_version || to_version >= from_version {
            panic_with_error!(&env, VotingError::UpgradeVersionMismatch);
        }

        env.storage().instance().set(&VERSION_KEY, &to_version);
        let key = DataKey::UpgradeRollback(from_version);
        env.storage().persistent().set(&key, &to_version);
        crate::Voting::bump_persistent(&env, &key);

        ContractRollbackEvent {
            from: from_version,
            to: to_version,
        }
        .publish(&env);

        env.deployer().update_current_contract_wasm(wasm_hash);
    
}


/// Set verification key from registry during DAO initialization
/// This function is called by the registry contract during create_and_init_dao
/// to avoid re-entrancy issues. The registry is a trusted system contract.
///
/// CRIT-3 fix (2026-05-24): require the registry contract's auth — the
/// previous code documented "registry is a trusted system contract" but
/// did NOT enforce it. Sibling `init_tree_from_registry`/`register_from_registry`
/// already do this; this one was missed in the original audit pass.
pub(crate) fn set_vk_from_registry(env: Env, dao_id: u64, vk: VerificationKey) {

        let registry: Address = env.storage().instance().get(&REGISTRY).unwrap();
        registry.require_auth();
        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        crate::Voting::validate_vk(&env, &vk);

        // Bump VK version
        let new_version = crate::Voting::bump_vk_version(&env, dao_id);

        let key = DataKey::VotingKey(dao_id);
        env.storage().persistent().set(&key, &vk);
        crate::Voting::bump_persistent(&env, &key);
        let vk_ver_key = DataKey::VkByVersion(dao_id, new_version);
        env.storage().persistent().set(&vk_ver_key, &vk);
        crate::Voting::bump_persistent(&env, &vk_ver_key);

        VKSetEvent { dao_id }.publish(&env);
    
}


/// Set BLS12-381 verification key from registry during DAO initialization
pub(crate) fn set_vk_from_registry_bls381(env: Env, dao_id: u64, vk: VerificationKeyBls381) {

        let registry: Address = env.storage().instance().get(&REGISTRY).unwrap();
        registry.require_auth();
        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        crate::Voting::validate_vk_bls381(&env, &vk);

        // Store curve ID
        let curve_key = DataKey::CurveId(dao_id);
        env.storage()
            .persistent()
            .set(&curve_key, &CurveId::Bls12381);
        crate::Voting::bump_persistent(&env, &curve_key);

        // Bump BLS12-381 VK version
        let version_key = DataKey::VkVersionBls381(dao_id);
        let current_version: u32 = env.storage().persistent().get(&version_key).unwrap_or(0);
        let new_version = current_version + 1;
        env.storage().persistent().set(&version_key, &new_version);
        crate::Voting::bump_persistent(&env, &version_key);

        let key = DataKey::VotingKeyBls381(dao_id);
        env.storage().persistent().set(&key, &vk);
        crate::Voting::bump_persistent(&env, &key);
        let vk_ver_key = DataKey::VkByVersionBls381(dao_id, new_version);
        env.storage().persistent().set(&vk_ver_key, &vk);
        crate::Voting::bump_persistent(&env, &vk_ver_key);

        VKSetEvent { dao_id }.publish(&env);
    
}


/// Contract version for upgrade tracking.
pub(crate) fn version(env: Env) -> u32 {

        crate::Voting::bump_instance(&env);
        env.storage()
            .instance()
            .get(&VERSION_KEY)
            .unwrap_or(VERSION)
    
}


pub(crate) fn set_circuit_registry(env: Env, circuit_registry: Address) {

        crate::Voting::require_not_paused(&env);
        env.storage()
            .instance()
            .set(&CIRCUIT_REGISTRY, &circuit_registry);
    
}


pub(crate) fn set_transcript_registry(env: Env, transcript_registry: Address) {

        crate::Voting::require_not_paused(&env);
        env.storage()
            .instance()
            .set(&TRANSCRIPT_REGISTRY, &transcript_registry);
    
}


pub(crate) fn get_transcript_registry(env: Env) -> Option<Address> {

        env.storage().instance().get(&TRANSCRIPT_REGISTRY)
    
}


pub(crate) fn set_dao_current_circuit(
        env: Env,
        dao_id: u64,
        circuit_id: String,
        _circuit_type: CircuitType,
    ) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        let registry: Address = env.storage().instance().get(&REGISTRY).unwrap();
        registry.require_auth();
        let key = DataKey::DaoCurrentCircuit(dao_id);
        env.storage().persistent().set(&key, &circuit_id);
        crate::Voting::bump_persistent(&env, &key);
    
}


pub(crate) fn get_dao_current_circuit(env: Env, dao_id: u64) -> String {

        crate::Voting::bump_instance(&env);
        let key = DataKey::DaoCurrentCircuit(dao_id);
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| String::from_str(&env, "vote_v1"))
    
}


pub(crate) fn set_migration(
        env: Env,
        dao_id: u64,
        old_circuit_id: String,
        new_circuit_id: String,
        deadline: u64,
    ) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        let registry: Address = env.storage().instance().get(&REGISTRY).unwrap();
        registry.require_auth();
        let migration = MigrationInfo {
            old_circuit_id,
            new_circuit_id,
            deadline,
        };
        let key = DataKey::DaoMigration(dao_id);
        env.storage().persistent().set(&key, &migration);
        crate::Voting::bump_persistent(&env, &key);
    
}


pub(crate) fn get_migration(env: Env, dao_id: u64) -> MigrationInfo {

        crate::Voting::bump_instance(&env);
        let key = DataKey::DaoMigration(dao_id);
        env.storage()
            .persistent()
            .get(&key)
            .expect("migration not found")
    
}


/// Check if there is a pending VK upgrade proposal for this DAO in the circuit-registry.
/// Returns Some(proposal_id) if pending, None otherwise.
pub(crate) fn get_pending_vk_proposal(env: Env, dao_id: u64) -> Option<u32> {

        crate::Voting::bump_instance(&env);
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
pub(crate) fn is_vk_proposal_ready(env: Env, proposal_id: u32) -> bool {

        crate::Voting::bump_instance(&env);
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
                    && proposal.approvals >= proposal.required_approvals
            }
            None => false,
        }
    
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_layout_is_stable() {
        assert_eq!(VERSION, 2);
        assert_eq!(STORAGE_VERSION, 1);
        assert_eq!(MAX_UPGRADE_PAYLOAD_LEN, 4096);
    }
}
