#![no_std]
#![allow(clippy::too_many_arguments)]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    BytesN, Env, String, Symbol, Vec,
};

const DAO_COUNT: Symbol = symbol_short!("dao_cnt");
const VERSION: u32 = 1;
const VERSION_KEY: Symbol = symbol_short!("ver");

// TTL management: bump on every interaction to keep contract alive
const INSTANCE_TTL_THRESHOLD: u32 = 120_960; // ~7 days
const INSTANCE_TTL_EXTEND: u32 = 535_680; // ~31 days
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 535_680;

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum RegistryError {
    NameTooLong = 1,
    DaoNotFound = 2,
    NotAdmin = 3,
    MetadataCidTooLong = 4,
}

// Size limit to prevent DoS attacks
const MAX_DAO_NAME_LEN: u32 = 24; // Max DAO name length (24 chars)
const MAX_METADATA_CID_LEN: u32 = 64; // Max IPFS CID length

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

/// Groth16 Verification Key for BN254
#[contracttype]
#[derive(Clone)]
pub struct VerificationKey {
    pub alpha: BytesN<64>,   // G1 point
    pub beta: BytesN<128>,   // G2 point
    pub gamma: BytesN<128>,  // G2 point
    pub delta: BytesN<128>,  // G2 point
    pub ic: Vec<BytesN<64>>, // IC points (G1)
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
        let init_tree_args =
            soroban_sdk::vec![&env, dao_id.into_val(&env), tree_depth.into_val(&env)];
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
        let init_tree_args =
            soroban_sdk::vec![&env, dao_id.into_val(&env), tree_depth.into_val(&env)];
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
}

#[cfg(test)]
mod test;
