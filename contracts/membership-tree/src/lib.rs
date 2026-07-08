#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Env, IntoVal, Symbol, Vec, U256,
};

mod poseidon_params;

const SBT_CONTRACT: Symbol = symbol_short!("sbt");
const REGISTRY: Symbol = symbol_short!("registry");
// FIFO history of Merkle roots - older roots are evicted. See THREAT_MODEL.md for impact.
const MAX_ROOT_HISTORY: u32 = 30;
// Circuit depth must match vote.circom. Supports ~262K members (2^18 = 262,144)
const MAX_TREE_DEPTH: u32 = 18;
const ZEROS_CACHE: Symbol = symbol_short!("zeros");
const VERSION: u32 = 1;
const VERSION_KEY: Symbol = symbol_short!("ver");

// TTL management: bump on every interaction to keep contract alive
const INSTANCE_TTL_THRESHOLD: u32 = 120_960; // ~7 days
const INSTANCE_TTL_EXTEND: u32 = 535_680; // ~31 days
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 535_680;

// Poseidon params cache keys (stored in persistent storage)
const POSEIDON_MDS: Symbol = symbol_short!("pos_mds");
const POSEIDON_RC: Symbol = symbol_short!("pos_rc");

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum TreeError {
    NotAdmin = 1,
    InvalidDepth = 2,
    TreeInitialized = 3,
    TreeNotInitialized = 4,
    CommitmentExists = 5,
    MemberExists = 6,
    TreeFull = 7,
    NoSbt = 8,
    NotOpenMembership = 9,
    LeafOutOfBounds = 10,
    MemberRemoved = 11,
    MemberNotInTree = 12,
    RootNotFound = 13,
    AlreadyInitialized = 14,
    MemberNotRevoked = 15, // Member hasn't been revoked (for reinstatement)
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    TreeDepth(u64),                // dao_id -> depth
    NextLeafIndex(u64),            // dao_id -> next index
    FilledSubtrees(u64),           // dao_id -> Vec<U256>
    Roots(u64),                    // dao_id -> Vec<U256> (history)
    LeafIndex(u64, U256),          // (dao_id, commitment) -> index
    MemberLeafIndex(u64, Address), // (dao_id, member) -> index
    LeafValue(u64, u32),           // (dao_id, index) -> commitment (or 0 if removed)
    NextRootIndex(u64),            // dao_id -> next root index counter
    RootIndex(u64, U256),          // (dao_id, root) -> root index
    RevokedAt(u64, U256),          // (dao_id, commitment) -> timestamp when revoked
    ReinstatedAt(u64, U256),       // (dao_id, commitment) -> timestamp when reinstated
    NodeHash(u64, u32, u32),       // (dao_id, level, node_index) -> hash value at that position
    MinValidRootIdx(u64),          // dao_id -> minimum valid root index (after member removals)
}

// Typed Events
#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct TreeInitEvent {
    #[topic]
    pub dao_id: u64,
    pub depth: u32,
    pub empty_root: U256,
    pub root_index: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct CommitEvent {
    #[topic]
    pub dao_id: u64,
    pub commitment: U256,
    pub index: u32,
    pub new_root: U256,
    pub root_index: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct RemovalEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub member: Address,
    pub index: u32,
    pub new_root: U256,
    pub root_index: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ReinstatementEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub member: Address,
    pub reinstated_at: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractUpgraded {
    pub from: u32,
    pub to: u32,
}

#[contract]
pub struct MembershipTree;

#[contractimpl]
impl MembershipTree {
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

    /// Constructor: Initialize contract with SBT contract address
    /// Also pre-computes zeros cache to avoid expensive initialization during first DAO creation
    pub fn __constructor(env: Env, sbt_contract: Address, registry: Address) {
        if env.storage().instance().has(&VERSION_KEY) {
            panic_with_error!(&env, TreeError::AlreadyInitialized);
        }
        env.storage().instance().set(&VERSION_KEY, &VERSION);
        ContractUpgraded {
            from: 0,
            to: VERSION,
        }
        .publish(&env);

        env.storage().instance().set(&SBT_CONTRACT, &sbt_contract);
        env.storage().instance().set(&REGISTRY, &registry);

        // Pre-initialize zeros cache during deployment to spread the cost
        // This avoids hitting budget limits during first DAO creation
        Self::ensure_zeros_cache(&env);
    }

    fn sbt_contract(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&SBT_CONTRACT)
            .unwrap_or_else(|| panic_with_error!(env, TreeError::TreeNotInitialized))
    }

    /// Initialize a tree for a specific DAO
    /// Only DAO admin can initialize (via SBT contract which checks registry)
    pub fn init_tree(env: Env, dao_id: u64, depth: u32, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();

        // Verify admin owns the DAO via SBT -> Registry chain
        let sbt_contract: Address = Self::sbt_contract(&env);
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
        if dao_admin != admin {
            panic_with_error!(&env, TreeError::NotAdmin);
        }

        if depth == 0 || depth > MAX_TREE_DEPTH {
            panic_with_error!(&env, TreeError::InvalidDepth);
        }

        let depth_key = DataKey::TreeDepth(dao_id);
        if env.storage().persistent().has(&depth_key) {
            panic_with_error!(&env, TreeError::TreeInitialized);
        }

        // Store tree parameters
        env.storage().persistent().set(&depth_key, &depth);
        Self::bump_persistent(&env, &depth_key);
        let next_leaf_key = DataKey::NextLeafIndex(dao_id);
        env.storage().persistent().set(&next_leaf_key, &0u32);
        Self::bump_persistent(&env, &next_leaf_key);

        // Initialize root index counter
        let next_root_key = DataKey::NextRootIndex(dao_id);
        env.storage().persistent().set(&next_root_key, &0u32);
        Self::bump_persistent(&env, &next_root_key);

        // Initialize filled subtrees with zeros (use cached zeros for O(1) lookup)
        let mut filled = Vec::new(&env);
        for level in 0..depth {
            filled.push_back(Self::zero_at_level(&env, level));
        }
        let filled_key = DataKey::FilledSubtrees(dao_id);
        env.storage().persistent().set(&filled_key, &filled);
        Self::bump_persistent(&env, &filled_key);

        // Initialize root history with empty tree root (cached zero at depth level)
        let empty_root = Self::zero_at_level(&env, depth);
        let mut roots = Vec::new(&env);
        roots.push_back(empty_root.clone());
        let roots_key = DataKey::Roots(dao_id);
        env.storage().persistent().set(&roots_key, &roots);
        Self::bump_persistent(&env, &roots_key);

        // Store root index for empty root
        let root_idx_key = DataKey::RootIndex(dao_id, empty_root.clone());
        env.storage().persistent().set(&root_idx_key, &0u32);
        Self::bump_persistent(&env, &root_idx_key);

        TreeInitEvent {
            dao_id,
            depth,
            empty_root,
            root_index: 0,
        }
        .publish(&env);
    }

    /// Initialize tree from registry during DAO initialization
    /// This function is called by the registry contract during create_and_init_dao
    /// to avoid re-entrancy issues. The registry is a trusted system contract.
    pub fn init_tree_from_registry(env: Env, dao_id: u64, depth: u32) {
        Self::bump_instance(&env);
        // Verify caller is the registry contract
        let registry: Address = env
            .storage()
            .instance()
            .get(&REGISTRY)
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::NotAdmin));
        registry.require_auth();

        if depth == 0 || depth > MAX_TREE_DEPTH {
            panic_with_error!(&env, TreeError::InvalidDepth);
        }

        let depth_key = DataKey::TreeDepth(dao_id);
        if env.storage().persistent().has(&depth_key) {
            panic_with_error!(&env, TreeError::TreeInitialized);
        }

        // Store tree parameters
        env.storage().persistent().set(&depth_key, &depth);
        Self::bump_persistent(&env, &depth_key);
        let next_leaf_key = DataKey::NextLeafIndex(dao_id);
        env.storage().persistent().set(&next_leaf_key, &0u32);
        Self::bump_persistent(&env, &next_leaf_key);

        // Initialize root index counter
        let next_root_key = DataKey::NextRootIndex(dao_id);
        env.storage().persistent().set(&next_root_key, &0u32);
        Self::bump_persistent(&env, &next_root_key);

        // Initialize filled subtrees with zeros (use cached zeros for O(1) lookup)
        let mut filled = Vec::new(&env);
        for level in 0..depth {
            filled.push_back(Self::zero_at_level(&env, level));
        }
        let filled_key = DataKey::FilledSubtrees(dao_id);
        env.storage().persistent().set(&filled_key, &filled);
        Self::bump_persistent(&env, &filled_key);

        // Initialize root history with empty tree root (cached zero at depth level)
        let empty_root = Self::zero_at_level(&env, depth);
        let mut roots = Vec::new(&env);
        roots.push_back(empty_root.clone());
        let roots_key = DataKey::Roots(dao_id);
        env.storage().persistent().set(&roots_key, &roots);
        Self::bump_persistent(&env, &roots_key);

        // Store root index for empty root
        let root_idx_key = DataKey::RootIndex(dao_id, empty_root.clone());
        env.storage().persistent().set(&root_idx_key, &0u32);
        Self::bump_persistent(&env, &root_idx_key);

        TreeInitEvent {
            dao_id,
            depth,
            empty_root,
            root_index: 0,
        }
        .publish(&env);
    }

    /// Register a commitment from registry during DAO initialization
    /// This function is called by the registry contract during create_and_init_dao
    /// to automatically register the creator's commitment.
    /// The registry is trusted to have already verified SBT ownership.
    pub fn register_from_registry(env: Env, dao_id: u64, commitment: U256, member: Address) {
        Self::bump_instance(&env);
        // Verify caller is the registry contract
        let registry: Address = env
            .storage()
            .instance()
            .get(&REGISTRY)
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::NotAdmin));
        registry.require_auth();

        // Check tree is initialized
        let depth_key = DataKey::TreeDepth(dao_id);
        if !env.storage().persistent().has(&depth_key) {
            panic_with_error!(&env, TreeError::TreeNotInitialized);
        }

        // Check commitment not already registered
        let leaf_key = DataKey::LeafIndex(dao_id, commitment.clone());
        if env.storage().persistent().has(&leaf_key) {
            panic_with_error!(&env, TreeError::CommitmentExists);
        }

        // Check member hasn't already registered
        let member_key = DataKey::MemberLeafIndex(dao_id, member.clone());
        if env.storage().persistent().has(&member_key) {
            panic_with_error!(&env, TreeError::MemberExists);
        }

        // Get tree parameters
        let depth: u32 = env
            .storage()
            .persistent()
            .get(&depth_key)
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized));
        let next_index: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::NextLeafIndex(dao_id))
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized));

        if next_index >= (1u32 << depth) {
            panic_with_error!(&env, TreeError::TreeFull);
        }

        // Insert leaf into tree
        let (new_root, root_index) =
            Self::insert_leaf(&env, dao_id, commitment.clone(), next_index, depth);

        // Update next index
        let next_leaf_key = DataKey::NextLeafIndex(dao_id);
        env.storage()
            .persistent()
            .set(&next_leaf_key, &(next_index + 1));
        Self::bump_persistent(&env, &next_leaf_key);

        // Store leaf index for this commitment
        env.storage().persistent().set(&leaf_key, &next_index);
        Self::bump_persistent(&env, &leaf_key);

        // Store member -> index mapping
        env.storage().persistent().set(&member_key, &next_index);
        Self::bump_persistent(&env, &member_key);

        // Store leaf value
        let leaf_value_key = DataKey::LeafValue(dao_id, next_index);
        env.storage().persistent().set(&leaf_value_key, &commitment);
        Self::bump_persistent(&env, &leaf_value_key);

        CommitEvent {
            dao_id,
            commitment,
            index: next_index,
            new_root,
            root_index,
        }
        .publish(&env);
    }

    /// Register a commitment with explicit caller (requires SBT membership)
    pub fn register_with_caller(env: Env, dao_id: u64, commitment: U256, caller: Address) {
        Self::bump_instance(&env);
        caller.require_auth();

        // Verify caller has SBT for this DAO
        let sbt_contract: Address = Self::sbt_contract(&env);
        let has_sbt: bool = env.invoke_contract(
            &sbt_contract,
            &symbol_short!("has"),
            soroban_sdk::vec![&env, dao_id.into_val(&env), caller.clone().into_val(&env)],
        );

        if !has_sbt {
            panic_with_error!(&env, TreeError::NoSbt);
        }

        // Check tree is initialized
        let depth_key = DataKey::TreeDepth(dao_id);
        if !env.storage().persistent().has(&depth_key) {
            panic_with_error!(&env, TreeError::TreeNotInitialized);
        }

        // Check commitment not already registered
        let leaf_key = DataKey::LeafIndex(dao_id, commitment.clone());
        if env.storage().persistent().has(&leaf_key) {
            panic_with_error!(&env, TreeError::CommitmentExists);
        }

        // Check member hasn't already registered
        let member_key = DataKey::MemberLeafIndex(dao_id, caller.clone());
        if env.storage().persistent().has(&member_key) {
            panic_with_error!(&env, TreeError::MemberExists);
        }

        // Get tree parameters
        let depth: u32 = env
            .storage()
            .persistent()
            .get(&depth_key)
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized));
        let next_index: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::NextLeafIndex(dao_id))
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized));

        if next_index >= (1u32 << depth) {
            panic_with_error!(&env, TreeError::TreeFull);
        }

        // Insert leaf into tree
        let (new_root, root_index) =
            Self::insert_leaf(&env, dao_id, commitment.clone(), next_index, depth);

        // Update next index
        let next_leaf_key = DataKey::NextLeafIndex(dao_id);
        env.storage()
            .persistent()
            .set(&next_leaf_key, &(next_index + 1));
        Self::bump_persistent(&env, &next_leaf_key);

        // Store leaf index for this commitment
        env.storage().persistent().set(&leaf_key, &next_index);
        Self::bump_persistent(&env, &leaf_key);

        // Store member -> index mapping
        env.storage().persistent().set(&member_key, &next_index);
        Self::bump_persistent(&env, &member_key);

        // Store leaf value
        let leaf_value_key = DataKey::LeafValue(dao_id, next_index);
        env.storage().persistent().set(&leaf_value_key, &commitment);
        Self::bump_persistent(&env, &leaf_value_key);

        CommitEvent {
            dao_id,
            commitment,
            index: next_index,
            new_root,
            root_index,
        }
        .publish(&env);
    }

    /// Self-register a commitment in a public DAO (requires SBT membership)
    /// For public DAOs, anyone with an SBT can register their commitment
    pub fn self_register(env: Env, dao_id: u64, commitment: U256, member: Address) {
        Self::bump_instance(&env);
        member.require_auth();

        // Get SBT contract and verify membership
        let sbt_contract: Address = Self::sbt_contract(&env);
        let has_sbt: bool = env.invoke_contract(
            &sbt_contract,
            &symbol_short!("has"),
            soroban_sdk::vec![&env, dao_id.into_val(&env), member.clone().into_val(&env)],
        );

        if !has_sbt {
            panic_with_error!(&env, TreeError::NoSbt);
        }

        // Get registry from SBT contract
        let registry: Address = env.invoke_contract(
            &sbt_contract,
            &symbol_short!("registry"),
            soroban_sdk::vec![&env],
        );

        // Check if DAO has open membership
        let membership_open: bool = env.invoke_contract(
            &registry,
            &Symbol::new(&env, "is_membership_open"),
            soroban_sdk::vec![&env, dao_id.into_val(&env)],
        );

        if !membership_open {
            panic_with_error!(&env, TreeError::NotOpenMembership);
        }

        // Check tree is initialized
        let depth_key = DataKey::TreeDepth(dao_id);
        if !env.storage().persistent().has(&depth_key) {
            panic_with_error!(&env, TreeError::TreeNotInitialized);
        }

        // Check commitment not already registered
        let leaf_key = DataKey::LeafIndex(dao_id, commitment.clone());
        if env.storage().persistent().has(&leaf_key) {
            panic_with_error!(&env, TreeError::CommitmentExists);
        }

        // Check member hasn't already registered
        let member_key = DataKey::MemberLeafIndex(dao_id, member.clone());
        if env.storage().persistent().has(&member_key) {
            panic_with_error!(&env, TreeError::MemberExists);
        }

        // Get tree parameters
        let depth: u32 = env
            .storage()
            .persistent()
            .get(&depth_key)
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized));
        let next_index: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::NextLeafIndex(dao_id))
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized));

        if next_index >= (1u32 << depth) {
            panic_with_error!(&env, TreeError::TreeFull);
        }

        // Insert leaf into tree
        let (new_root, root_index) =
            Self::insert_leaf(&env, dao_id, commitment.clone(), next_index, depth);

        // Update next index
        let next_leaf_key = DataKey::NextLeafIndex(dao_id);
        env.storage()
            .persistent()
            .set(&next_leaf_key, &(next_index + 1));
        Self::bump_persistent(&env, &next_leaf_key);

        // Store leaf index for this commitment
        env.storage().persistent().set(&leaf_key, &next_index);
        Self::bump_persistent(&env, &leaf_key);

        // Store member -> index mapping
        env.storage().persistent().set(&member_key, &next_index);
        Self::bump_persistent(&env, &member_key);

        // Store leaf value
        let leaf_value_key = DataKey::LeafValue(dao_id, next_index);
        env.storage().persistent().set(&leaf_value_key, &commitment);
        Self::bump_persistent(&env, &leaf_value_key);

        CommitEvent {
            dao_id,
            commitment,
            index: next_index,
            new_root,
            root_index,
        }
        .publish(&env);
    }

    /// Get current root for a DAO
    pub fn current_root(env: Env, dao_id: u64) -> U256 {
        Self::bump_instance(&env);
        let roots_key = DataKey::Roots(dao_id);
        let roots: Vec<U256> = env
            .storage()
            .persistent()
            .get(&roots_key)
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized));
        Self::bump_persistent(&env, &roots_key);
        roots
            .get(roots.len().saturating_sub(1))
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized))
    }

    /// Get current root (short alias for cross-contract calls)
    pub fn get_root(env: Env, dao_id: u64) -> U256 {
        Self::current_root(env, dao_id)
    }

    /// Check if a root is valid (in history)
    pub fn root_ok(env: Env, dao_id: u64, root: U256) -> bool {
        Self::bump_instance(&env);
        let roots_key = DataKey::Roots(dao_id);
        if !env.storage().persistent().has(&roots_key) {
            return false;
        }

        let roots: Vec<U256> = env
            .storage()
            .persistent()
            .get(&roots_key)
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized));
        for i in 0..roots.len() {
            if roots
                .get(i)
                .unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized))
                == root
            {
                return true;
            }
        }
        false
    }

    /// Get root index for a specific root (for vote mode validation)
    pub fn root_idx(env: Env, dao_id: u64, root: U256) -> u32 {
        Self::bump_instance(&env);
        let key = DataKey::RootIndex(dao_id, root);
        let idx: u32 = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::RootNotFound));
        Self::bump_persistent(&env, &key);
        idx
    }

    /// Get current root index (for proposal creation)
    pub fn curr_idx(env: Env, dao_id: u64) -> u32 {
        let current_root = Self::current_root(env.clone(), dao_id);
        Self::root_idx(env, dao_id, current_root)
    }

    /// Get leaf index for a commitment
    pub fn get_leaf_index(env: Env, dao_id: u64, commitment: U256) -> u32 {
        Self::bump_instance(&env);
        let key = DataKey::LeafIndex(dao_id, commitment);
        let idx: u32 = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::MemberNotInTree));
        Self::bump_persistent(&env, &key);
        idx
    }

    /// Get tree info for a DAO
    pub fn get_tree_info(env: Env, dao_id: u64) -> (u32, u32, U256) {
        Self::bump_instance(&env);
        let depth: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::TreeDepth(dao_id))
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized));
        let next_index: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::NextLeafIndex(dao_id))
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized));
        let root = Self::current_root(env, dao_id);
        (depth, next_index, root)
    }

    /// Get Merkle path for a specific leaf index
    /// Returns (pathElements, pathIndices) where:
    /// - pathElements[i] is the sibling hash at level i
    /// - pathIndices[i] is 0 if leaf is left child, 1 if right child
    ///
    /// This optimized version reads stored node hashes directly (O(depth) reads)
    /// instead of reconstructing subtrees (which was O(n * log n) hashes).
    pub fn get_merkle_path(env: Env, dao_id: u64, leaf_index: u32) -> (Vec<U256>, Vec<u32>) {
        Self::bump_instance(&env);
        let depth: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::TreeDepth(dao_id))
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized));

        let next_index: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::NextLeafIndex(dao_id))
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized));

        if leaf_index >= next_index {
            panic_with_error!(&env, TreeError::LeafOutOfBounds);
        }

        let mut path_elements = Vec::new(&env);
        let mut path_indices = Vec::new(&env);
        let mut current_index = leaf_index;

        for level in 0..depth {
            // Determine if current node is left (0) or right (1) child
            let is_left = current_index.is_multiple_of(2);
            path_indices.push_back(if is_left { 0 } else { 1 });

            // Calculate sibling index at THIS LEVEL
            let sibling_index = if is_left {
                current_index + 1
            } else {
                current_index - 1
            };

            // Get sibling value from stored node hashes (O(1) lookup)
            let sibling = if level == 0 {
                // Level 0: sibling is a raw leaf (commitment value)
                if sibling_index < next_index {
                    let leaf_key = DataKey::LeafValue(dao_id, sibling_index);
                    env.storage()
                        .persistent()
                        .get(&leaf_key)
                        .unwrap_or_else(|| Self::zero_value(&env))
                } else {
                    // Sibling leaf doesn't exist, use zero
                    Self::zero_value(&env)
                }
            } else {
                // Level > 0: look up stored node hash (written during insert_leaf)
                let node_key = DataKey::NodeHash(dao_id, level, sibling_index);
                env.storage()
                    .persistent()
                    .get(&node_key)
                    .unwrap_or_else(|| Self::zero_at_level(&env, level))
            };

            path_elements.push_back(sibling);
            current_index /= 2; // Move to parent level
        }

        (path_elements, path_indices)
    }

    /// Get SBT contract address
    pub fn sbt_contr(env: Env) -> Address {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&SBT_CONTRACT)
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized))
    }

    /// Pre-initialize the zeros cache to avoid budget issues during first tree operations.
    /// This should be called once during deployment to precompute zero values for all levels.
    pub fn init_zeros_cache(env: Env) {
        Self::bump_instance(&env);
        Self::ensure_zeros_cache(&env);
    }

    /// Remove a member by zeroing their leaf and recomputing the root
    /// Only callable by DAO admin
    /// This zeros the leaf in the Merkle tree, preventing proofs against new roots
    pub fn remove_member(env: Env, dao_id: u64, member: Address, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();

        // Verify admin owns the DAO via SBT -> Registry chain
        let sbt_contract: Address = Self::sbt_contr(env.clone());
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
        if dao_admin != admin {
            panic_with_error!(&env, TreeError::NotAdmin);
        }

        // Get member's leaf index
        let member_key = DataKey::MemberLeafIndex(dao_id, member.clone());
        let leaf_index: u32 = env
            .storage()
            .persistent()
            .get(&member_key)
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::MemberNotInTree));

        // Get their commitment from the tree
        let commitment: U256 = env
            .storage()
            .persistent()
            .get(&DataKey::LeafValue(dao_id, leaf_index))
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::MemberNotInTree));

        if commitment == Self::zero_value(&env) {
            panic_with_error!(&env, TreeError::MemberRemoved);
        }

        // Zero the leaf and recompute root
        let zero = Self::zero_value(&env);
        let (new_root, root_index) = Self::update_leaf(&env, dao_id, leaf_index, zero);

        // Update min_valid_root_index - all roots before this are now invalid for Trailing mode
        // This prevents removed members from using old proofs
        let min_root_key = DataKey::MinValidRootIdx(dao_id);
        env.storage().persistent().set(&min_root_key, &root_index);
        Self::bump_persistent(&env, &min_root_key);

        // Also revoke the member's SBT in the same transaction
        // The admin has already called require_auth(), so the SBT contract will accept this
        env.invoke_contract::<()>(
            &sbt_contract,
            &symbol_short!("revoke"),
            soroban_sdk::vec![
                &env,
                dao_id.into_val(&env),
                member.clone().into_val(&env),
                admin.into_val(&env),
            ],
        );

        RemovalEvent {
            dao_id,
            member,
            index: leaf_index,
            new_root,
            root_index,
        }
        .publish(&env);
    }

    /// Reinstate a previously removed member
    /// Clears their leaf index mapping so they can re-register with a new commitment
    /// The admin should also re-mint their SBT via the membership-sbt contract
    pub fn reinstate_member(env: Env, dao_id: u64, member: Address, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();

        // Verify admin is the DAO admin via cross-contract call
        let sbt_contract: Address = Self::sbt_contr(env.clone());
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
            panic_with_error!(&env, TreeError::NotAdmin);
        }

        // Get member's leaf index (they must have been registered before)
        let leaf_index_key = DataKey::MemberLeafIndex(dao_id, member.clone());
        let leaf_index: u32 = env
            .storage()
            .persistent()
            .get(&leaf_index_key)
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::MemberNotInTree));

        // Verify the member was actually removed (leaf should be zero)
        let current_value: U256 = env
            .storage()
            .persistent()
            .get(&DataKey::LeafValue(dao_id, leaf_index))
            .unwrap_or_else(|| panic_with_error!(&env, TreeError::MemberNotInTree));

        if current_value != Self::zero_value(&env) {
            panic_with_error!(&env, TreeError::MemberNotRevoked);
        }

        // Clear the leaf index mapping so they can re-register
        env.storage().persistent().remove(&leaf_index_key);

        // Record reinstatement timestamp
        let reinstated_at = env.ledger().timestamp();

        // Emit event
        ReinstatementEvent {
            dao_id,
            member,
            reinstated_at,
        }
        .publish(&env);
    }

    /// Get revocation timestamp for a commitment (returns None if never revoked)
    /// Used by voting contract to check if member was revoked
    pub fn revok_at(env: Env, dao_id: u64, commitment: U256) -> Option<u64> {
        Self::bump_instance(&env);
        let key = DataKey::RevokedAt(dao_id, commitment);
        let result: Option<u64> = env.storage().persistent().get(&key);
        if result.is_some() {
            Self::bump_persistent(&env, &key);
        }
        result
    }

    /// Get reinstatement timestamp for a commitment (returns None if never reinstated)
    /// Used by voting contract to check if member was reinstated after revocation
    pub fn reinst_at(env: Env, dao_id: u64, commitment: U256) -> Option<u64> {
        Self::bump_instance(&env);
        let key = DataKey::ReinstatedAt(dao_id, commitment);
        let result: Option<u64> = env.storage().persistent().get(&key);
        if result.is_some() {
            Self::bump_persistent(&env, &key);
        }
        result
    }

    /// Get the minimum valid root index for a DAO
    /// Roots with index < min_valid_root_index are invalid for Trailing mode proposals
    /// Returns 0 if no members have been removed
    pub fn min_root(env: Env, dao_id: u64) -> u32 {
        Self::bump_instance(&env);
        let key = DataKey::MinValidRootIdx(dao_id);
        let result: u32 = env.storage().persistent().get(&key).unwrap_or(0);
        if result > 0 {
            Self::bump_persistent(&env, &key);
        }
        result
    }

    // Internal: Insert leaf and update tree
    // Also stores intermediate node hashes at each level for O(depth) merkle path lookups
    fn insert_leaf(env: &Env, dao_id: u64, leaf: U256, index: u32, depth: u32) -> (U256, u32) {
        let mut filled: Vec<U256> = env
            .storage()
            .persistent()
            .get(&DataKey::FilledSubtrees(dao_id))
            .unwrap_or_else(|| panic_with_error!(env, TreeError::TreeNotInitialized));

        // Fast path for first leaf (index 0): pre-compute root directly
        // Since all siblings are zeros, we can compute the root in a tight loop
        // without repeatedly calling zero_at_level
        if index == 0 {
            filled.set(0, leaf.clone());
            let mut current_hash = leaf;
            let mut current_index = index;
            for level in 0..depth {
                let zero = Self::zero_at_level(env, level);
                current_hash = Self::hash_pair(env, &current_hash, &zero);
                // Store intermediate node hash at level+1 (since level 0 is leaves)
                let parent_index = current_index / 2;
                let node_key = DataKey::NodeHash(dao_id, level + 1, parent_index);
                env.storage().persistent().set(&node_key, &current_hash);
                Self::bump_persistent(env, &node_key);
                current_index = parent_index;
            }

            let filled_key = DataKey::FilledSubtrees(dao_id);
            env.storage().persistent().set(&filled_key, &filled);
            Self::bump_persistent(env, &filled_key);

            // Update root history
            let roots_key = DataKey::Roots(dao_id);
            let mut roots: Vec<U256> = env
                .storage()
                .persistent()
                .get(&roots_key)
                .unwrap_or_else(|| panic_with_error!(env, TreeError::TreeNotInitialized));
            roots.push_back(current_hash.clone());
            if roots.len() > MAX_ROOT_HISTORY {
                // Clean up RootIndex for evicted root
                if let Some(evicted_root) = roots.get(0) {
                    let evicted_key = DataKey::RootIndex(dao_id, evicted_root);
                    env.storage().persistent().remove(&evicted_key);
                }
                let mut new_roots = Vec::new(env);
                for i in 1..roots.len() {
                    if let Some(r) = roots.get(i) {
                        new_roots.push_back(r);
                    }
                }
                roots = new_roots;
            }
            env.storage().persistent().set(&roots_key, &roots);
            Self::bump_persistent(env, &roots_key);

            // Get and increment root index
            let next_root_key = DataKey::NextRootIndex(dao_id);
            let root_index: u32 = env.storage().persistent().get(&next_root_key).unwrap_or(0);
            env.storage()
                .persistent()
                .set(&next_root_key, &(root_index + 1));
            Self::bump_persistent(env, &next_root_key);

            // Store root index mapping
            let root_idx_key = DataKey::RootIndex(dao_id, current_hash.clone());
            env.storage().persistent().set(&root_idx_key, &root_index);
            Self::bump_persistent(env, &root_idx_key);

            return (current_hash, root_index);
        }

        // General case for index > 0
        let mut current_hash = leaf;
        let mut current_index = index;

        for i in 0..depth {
            let level = i;
            if current_index.is_multiple_of(2) {
                // Left child - update filled subtree at this level
                filled.set(level, current_hash.clone());
                let zero_at_level = Self::zero_at_level(env, level);
                current_hash = Self::hash_pair(env, &current_hash, &zero_at_level);
            } else {
                // Right child - use filled subtree from left
                let left = filled
                    .get(level)
                    .unwrap_or_else(|| Self::zero_at_level(env, level));
                current_hash = Self::hash_pair(env, &left, &current_hash);
            }
            // Store intermediate node hash at level+1 (since level 0 is leaves)
            let parent_index = current_index / 2;
            let node_key = DataKey::NodeHash(dao_id, level + 1, parent_index);
            env.storage().persistent().set(&node_key, &current_hash);
            Self::bump_persistent(env, &node_key);
            current_index = parent_index;
        }

        // Save updated filled subtrees
        let filled_key = DataKey::FilledSubtrees(dao_id);
        env.storage().persistent().set(&filled_key, &filled);
        Self::bump_persistent(env, &filled_key);

        // Update root history with FIFO cap
        let roots_key = DataKey::Roots(dao_id);
        let mut roots: Vec<U256> = env
            .storage()
            .persistent()
            .get(&roots_key)
            .unwrap_or_else(|| panic_with_error!(env, TreeError::TreeNotInitialized));

        roots.push_back(current_hash.clone());

        // Maintain max roots cap (FIFO)
        if roots.len() > MAX_ROOT_HISTORY {
            // Clean up RootIndex for evicted root
            if let Some(evicted_root) = roots.get(0) {
                let evicted_key = DataKey::RootIndex(dao_id, evicted_root);
                env.storage().persistent().remove(&evicted_key);
            }
            let mut new_roots = Vec::new(env);
            for i in 1..roots.len() {
                if let Some(r) = roots.get(i) {
                    new_roots.push_back(r);
                }
            }
            roots = new_roots;
        }

        env.storage().persistent().set(&roots_key, &roots);
        Self::bump_persistent(env, &roots_key);

        // Get and increment root index
        let next_root_key = DataKey::NextRootIndex(dao_id);
        let root_index: u32 = env.storage().persistent().get(&next_root_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&next_root_key, &(root_index + 1));
        Self::bump_persistent(env, &next_root_key);

        // Store root index mapping
        let root_idx_key = DataKey::RootIndex(dao_id, current_hash.clone());
        env.storage().persistent().set(&root_idx_key, &root_index);
        Self::bump_persistent(env, &root_idx_key);

        (current_hash, root_index)
    }

    /// Internal: Update an existing leaf value and recompute the path to root
    /// Used for revocation (zeroing) and reinstatement (restoring commitment)
    /// Returns (new_root, root_index)
    fn update_leaf(env: &Env, dao_id: u64, leaf_index: u32, new_value: U256) -> (U256, u32) {
        let depth: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::TreeDepth(dao_id))
            .unwrap_or_else(|| panic_with_error!(env, TreeError::TreeNotInitialized));

        // Update the leaf value
        let leaf_val_key = DataKey::LeafValue(dao_id, leaf_index);
        env.storage().persistent().set(&leaf_val_key, &new_value);
        Self::bump_persistent(env, &leaf_val_key);

        // Recompute path from leaf to root
        let mut current_index = leaf_index;
        let mut current_hash = new_value;

        for level in 0..depth {
            let is_left = current_index.is_multiple_of(2);
            let sibling_index = if is_left {
                current_index + 1
            } else {
                current_index - 1
            };

            // Get sibling hash from stored NodeHash or use zero if doesn't exist
            let sibling: U256 = if level == 0 {
                // At leaf level, sibling is another leaf value
                env.storage()
                    .persistent()
                    .get(&DataKey::LeafValue(dao_id, sibling_index))
                    .unwrap_or_else(|| Self::zero_at_level(env, level))
            } else {
                // At higher levels, sibling is stored in NodeHash
                env.storage()
                    .persistent()
                    .get(&DataKey::NodeHash(dao_id, level, sibling_index))
                    .unwrap_or_else(|| Self::zero_at_level(env, level))
            };

            // Hash pair
            let (left, right) = if is_left {
                (current_hash.clone(), sibling)
            } else {
                (sibling, current_hash.clone())
            };
            current_hash = Self::hash_pair(env, &left, &right);

            // Store updated node hash at level+1
            let parent_index = current_index / 2;
            let node_key = DataKey::NodeHash(dao_id, level + 1, parent_index);
            env.storage().persistent().set(&node_key, &current_hash);
            Self::bump_persistent(env, &node_key);

            current_index = parent_index;
        }

        // Update root history with FIFO cap
        let roots_key = DataKey::Roots(dao_id);
        let mut roots: Vec<U256> = env
            .storage()
            .persistent()
            .get(&roots_key)
            .unwrap_or_else(|| panic_with_error!(env, TreeError::TreeNotInitialized));

        roots.push_back(current_hash.clone());

        // Maintain max roots cap (FIFO)
        if roots.len() > MAX_ROOT_HISTORY {
            // Clean up RootIndex for evicted root
            if let Some(evicted_root) = roots.get(0) {
                let evicted_key = DataKey::RootIndex(dao_id, evicted_root);
                env.storage().persistent().remove(&evicted_key);
            }
            let mut new_roots = Vec::new(env);
            for i in 1..roots.len() {
                if let Some(r) = roots.get(i) {
                    new_roots.push_back(r);
                }
            }
            roots = new_roots;
        }

        env.storage().persistent().set(&roots_key, &roots);
        Self::bump_persistent(env, &roots_key);

        // Get and increment root index
        let next_root_key = DataKey::NextRootIndex(dao_id);
        let root_index: u32 = env.storage().persistent().get(&next_root_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&next_root_key, &(root_index + 1));
        Self::bump_persistent(env, &next_root_key);

        // Store root index mapping
        let root_idx_key = DataKey::RootIndex(dao_id, current_hash.clone());
        env.storage().persistent().set(&root_idx_key, &root_index);
        Self::bump_persistent(env, &root_idx_key);

        (current_hash, root_index)
    }

    // Internal: Ensure Poseidon params are cached in persistent storage
    // This is the key optimization - we only load params once and reuse
    fn ensure_poseidon_params_cached(env: &Env) {
        if env.storage().persistent().has(&POSEIDON_MDS) {
            return;
        }
        // Load params from our local module (expensive - only do once)
        let mds = poseidon_params::get_mds3(env);
        let rc = poseidon_params::get_rc3(env);
        env.storage().persistent().set(&POSEIDON_MDS, &mds);
        Self::bump_persistent(env, &POSEIDON_MDS);
        env.storage().persistent().set(&POSEIDON_RC, &rc);
        Self::bump_persistent(env, &POSEIDON_RC);
    }

    // Internal: Poseidon hash of two U256 values using cached params
    // Uses poseidon_permutation directly with pre-cached MDS and round constants
    fn hash_pair(env: &Env, left: &U256, right: &U256) -> U256 {
        Self::ensure_poseidon_params_cached(env);

        // Load cached params from persistent storage (safe: ensure_poseidon_params_cached guarantees these exist)
        let mds: Vec<Vec<U256>> = env
            .storage()
            .persistent()
            .get(&POSEIDON_MDS)
            .unwrap_or_else(|| panic_with_error!(env, TreeError::TreeNotInitialized));
        let rc: Vec<Vec<U256>> = env
            .storage()
            .persistent()
            .get(&POSEIDON_RC)
            .unwrap_or_else(|| panic_with_error!(env, TreeError::TreeNotInitialized));

        // Sponge construction: state = [0, left, right]
        let zero = U256::from_u32(env, 0);
        let state = soroban_sdk::vec![env, zero, left.clone(), right.clone()];
        let field = Symbol::new(env, "BN254");

        // Single permutation call with cached params via hazmat API
        let result = env.crypto_hazmat().poseidon_permutation(
            &state,
            field,
            poseidon_params::T,
            poseidon_params::SBOX_D,
            poseidon_params::ROUNDS_F,
            poseidon_params::ROUNDS_P,
            &mds,
            &rc,
        );

        // Output is first element of state (always exists after Poseidon permutation)
        result
            .get(0)
            .unwrap_or_else(|| panic_with_error!(env, TreeError::TreeNotInitialized))
    }

    // Internal: Zero value (empty leaf)
    fn zero_value(_env: &Env) -> U256 {
        // Standard Semaphore zero value
        U256::from_u32(_env, 0)
    }

    // Internal: Ensure zeros cache is initialized (lazy init, shared across all DAOs)
    fn ensure_zeros_cache(env: &Env) {
        if env.storage().instance().has(&ZEROS_CACHE) {
            return;
        }

        // Precompute zeros[0..MAX_TREE_DEPTH+1]
        // zeros[0] = 0
        // zeros[i+1] = Poseidon(zeros[i], zeros[i])
        let mut zeros = Vec::new(env);
        let mut current = Self::zero_value(env);
        zeros.push_back(current.clone());

        for _ in 0..MAX_TREE_DEPTH {
            current = Self::hash_pair(env, &current, &current);
            zeros.push_back(current.clone());
        }

        env.storage().instance().set(&ZEROS_CACHE, &zeros);
    }

    // Internal: O(1) lookup for precomputed zero at each level
    fn zero_at_level(env: &Env, level: u32) -> U256 {
        Self::ensure_zeros_cache(env);
        let zeros: Vec<U256> = env
            .storage()
            .instance()
            .get(&ZEROS_CACHE)
            .unwrap_or_else(|| panic_with_error!(env, TreeError::TreeNotInitialized));
        zeros
            .get(level)
            .unwrap_or_else(|| panic_with_error!(env, TreeError::InvalidDepth))
    }

    /// Contract version for upgrade tracking.
    pub fn version(env: Env) -> u32 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&VERSION_KEY)
            .unwrap_or(VERSION)
    }
}

// Test-only functions in separate contractimpl block
// This prevents the macro from generating references to these functions in production builds
#[cfg(any(test, feature = "testutils"))]
#[contractimpl]
impl MembershipTree {
    /// Test helper: Expose Poseidon hash for KAT verification
    /// This function is used to verify that Stellar P25's Poseidon implementation
    /// matches circomlib's parameters. Compare results with circuits/utils/poseidon_kat.js
    pub fn test_poseidon_hash(env: Env, a: U256, b: U256) -> U256 {
        Self::hash_pair(&env, &a, &b)
    }

    /// Test helper: Get zero value at specific tree level
    /// Used to verify Merkle tree zero values match between on-chain and circuit
    pub fn test_zero_at_level(env: Env, level: u32) -> U256 {
        Self::zero_at_level(&env, level)
    }
}

#[cfg(test)]
mod test;
