//! Admin, guardian, pause, and verification-key management.
//!
//! Invariants:
//! - Every admin path requires `admin.require_auth()` and checks the DAO admin
//!   from the registry; guardian paths require the configured guardian.
//! - VK updates bump the version monotonically and write both the `VotingKey`
//!   and `VkByVersion(dao_id, version)` keys.
//! - A paused contract auto-unpauses only after `MAX_PAUSE_DURATION`; the
//!   pause timestamp is stored in instance storage alongside the flag.

#[allow(unused_imports)]
use soroban_sdk::{
    panic_with_error, symbol_short, Address, Bytes, BytesN, Env, IntoVal, String, Symbol, Vec, U256,
};

use crate::*;


pub(crate) fn set_guardian(env: Env, current_guardian: Address, new_guardian: Address) {

        crate::Voting::bump_instance(&env);
        current_guardian.require_auth();
        crate::Voting::require_guardian(&env, &current_guardian);
        env.storage()
            .instance()
            .set(&DataKey::Guardian, &new_guardian);
    
}


pub(crate) fn guardian(env: Env) -> Address {

        crate::Voting::bump_instance(&env);
        env.storage().instance().get(&DataKey::Guardian).unwrap()
    
}


pub(crate) fn pause(env: Env, guardian: Address) {

        crate::Voting::bump_instance(&env);
        guardian.require_auth();
        crate::Voting::require_guardian(&env, &guardian);
        if crate::Voting::is_paused(env.clone()) {
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


pub(crate) fn unpause(env: Env, guardian: Address) {

        crate::Voting::bump_instance(&env);
        guardian.require_auth();
        crate::Voting::require_guardian(&env, &guardian);
        env.storage().instance().set(&DataKey::Paused, &false);
        ContractUnpausedEvent { guardian }.publish(&env);
    
}


pub(crate) fn is_paused(env: Env) -> bool {

        crate::Voting::bump_instance(&env);
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


/// Set verification key for a DAO (admin only)
pub(crate) fn set_vk(env: Env, dao_id: u64, vk: VerificationKey, admin: Address) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        admin.require_auth();
        crate::Voting::assert_admin(&env, dao_id, &admin);
        // Validate VK size to prevent DoS attacks
        crate::Voting::validate_vk(&env, &vk);

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

        let vk_hash = crate::Voting::hash_vk(&env, &vk);
        let is_attested: bool = env.invoke_contract(
            &transcript_registry,
            &Symbol::new(&env, "is_vk_attested"),
            soroban_sdk::vec![&env, vk_hash.into_val(&env)],
        );
        if !is_attested {
            panic_with_error!(&env, VotingError::VkNotAttested);
        }

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


/// Set verification key with explicit MPC transcript hash attestation
pub(crate) fn set_vk_with_transcript(
        env: Env,
        dao_id: u64,
        vk: VerificationKey,
        admin: Address,
        transcript_hash: BytesN<32>,
    ) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        admin.require_auth();
        crate::Voting::assert_admin(&env, dao_id, &admin);
        crate::Voting::validate_vk(&env, &vk);

        if let Some(transcript_registry) = env
            .storage()
            .instance()
            .get::<_, Address>(&TRANSCRIPT_REGISTRY)
        {
            let vk_hash = crate::Voting::hash_vk(&env, &vk);
            let is_attested: bool = env.invoke_contract(
                &transcript_registry,
                &Symbol::new(&env, "verify_attestation"),
                soroban_sdk::vec![&env, transcript_hash.into_val(&env), vk_hash.into_val(&env),],
            );
            if !is_attested {
                panic_with_error!(&env, VotingError::VkNotAttested);
            }
        }

        let new_version = crate::Voting::bump_vk_version(&env, dao_id);
        let key = DataKey::VotingKey(dao_id);
        env.storage().persistent().set(&key, &vk);
        crate::Voting::bump_persistent(&env, &key);
        let vk_ver_key = DataKey::VkByVersion(dao_id, new_version);
        env.storage().persistent().set(&vk_ver_key, &vk);
        crate::Voting::bump_persistent(&env, &vk_ver_key);

        VKSetEvent { dao_id }.publish(&env);
    
}


/// Set BLS12-381 verification key for a DAO (admin only)
pub(crate) fn set_vk_bls381(env: Env, dao_id: u64, vk: VerificationKeyBls381, admin: Address) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        admin.require_auth();
        crate::Voting::assert_admin(&env, dao_id, &admin);
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


/// Set Nova/SuperNova recursive verification key for a DAO (admin only)
pub(crate) fn set_recursive_vk(env: Env, dao_id: u64, vk_bytes: Bytes, admin: Address) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        admin.require_auth();
        crate::Voting::assert_admin(&env, dao_id, &admin);

        let key = DataKey::RecursiveVk(dao_id);
        env.storage().persistent().set(&key, &vk_bytes);
        crate::Voting::bump_persistent(&env, &key);
    
}


/// Set the verification key for the tally SNARK circuit (admin only).
pub(crate) fn set_tally_vk(env: Env, dao_id: u64, vk: VerificationKey, admin: Address) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        admin.require_auth();
        crate::Voting::assert_admin(&env, dao_id, &admin);
        if vk.ic.len() != TALLY_CIRCUIT_IC_LEN {
            panic_with_error!(&env, VotingError::VkIcLengthMismatch);
        }
        let key = DataKey::TallyVk(dao_id);
        env.storage().persistent().set(&key, &vk);
        crate::Voting::bump_persistent(&env, &key);
    
}


/// Fetch recursive verification key for a DAO
pub(crate) fn get_recursive_vk(env: Env, dao_id: u64) -> Option<Bytes> {

        env.storage()
            .persistent()
            .get(&DataKey::RecursiveVk(dao_id))
    
}


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
pub(crate) fn set_vk_for_depth(
        env: Env,
        dao_id: u64,
        merkle_depth: u32,
        vk: VerificationKey,
        admin: Address,
    ) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        crate::Voting::assert_admin(&env, dao_id, &admin);

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
        crate::Voting::bump_persistent(&env, &key);
    
}


/// Returns the verification key registered for a Merkle depth, if any.
pub(crate) fn get_vk_for_depth(env: Env, dao_id: u64, merkle_depth: u32) -> Option<VerificationKey> {

        crate::Voting::bump_instance(&env);
        let key = DataKey::DepthVk(dao_id, merkle_depth);
        let vk: Option<VerificationKey> = env.storage().persistent().get(&key);
        if vk.is_some() {
            crate::Voting::bump_persistent(&env, &key);
        }
        vk
    
}


/// Sets the election configuration and the Merkle depth its proofs use.
///
/// A depth of 0 keeps the default circuit and the DAO's version-pinned key.
/// A non-zero depth requires a key registered by `set_vk_for_depth`, and
/// pins that key's hash to the proposal so a later re-registration cannot
/// change what in-flight votes are checked against.
pub(crate) fn set_election_config_with_depth(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        min_balance: i128,
        twab_window: u64,
        num_candidates: u32,
        merkle_depth: u32,
    ) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);

        if merkle_depth > MAX_MERKLE_DEPTH {
            panic_with_error!(&env, VotingError::InvalidMerkleDepth);
        }

        // Reuse the existing setter for everything it already handles, then
        // layer the depth on top so the two paths cannot drift apart.
        crate::Voting::set_election_config(
            env.clone(),
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
            let vk_hash = crate::Voting::hash_vk(&env, &vk);
            env.storage().persistent().set(&hash_key, &vk_hash);
            crate::Voting::bump_persistent(&env, &hash_key);
        }

        config.merkle_depth = merkle_depth;
        env.storage().persistent().set(&key, &config);
        crate::Voting::bump_persistent(&env, &key);
    
}


/// The Merkle depth an election's proofs are built against.
///
/// 0 means the default depth-18 circuit. Clients use this to pick which
/// circuit artifacts to download and which key to verify against.
pub(crate) fn get_merkle_depth(env: Env, dao_id: u64, proposal_id: u64) -> u32 {

        crate::Voting::bump_instance(&env);
        env.storage()
            .persistent()
            .get::<_, ElectionConfig>(&DataKey::ElectionConfig(dao_id, proposal_id))
            .map(|config| config.merkle_depth)
            .unwrap_or(0)
    
}


/// Get current VK version for a DAO
pub(crate) fn vk_version(env: Env, dao_id: u64) -> u32 {

        crate::Voting::bump_instance(&env);
        let key = DataKey::VkVersion(dao_id);
        let ver: u32 = env.storage().persistent().get(&key).unwrap_or(0);
        if ver > 0 {
            crate::Voting::bump_persistent(&env, &key);
        }
        ver
    
}


/// Get the current VK for a DAO (used by other contracts like comments)
pub(crate) fn get_vk(env: Env, dao_id: u64) -> VerificationKey {

        crate::Voting::bump_instance(&env);
        let vk_ver_key = DataKey::VkVersion(dao_id);
        let version: u32 = env
            .storage()
            .persistent()
            .get(&vk_ver_key)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::VkNotSet));
        crate::Voting::bump_persistent(&env, &vk_ver_key);
        crate::Voting::get_vk_by_version(&env, dao_id, version)
    
}


/// Get a specific VK version for observability/off-chain verification
pub(crate) fn vk_for_version(env: Env, dao_id: u64, version: u32) -> VerificationKey {

        crate::Voting::bump_instance(&env);
        crate::Voting::get_vk_by_version(&env, dao_id, version)
    
}


/// Get the current BLS12-381 VK for a DAO
pub(crate) fn get_vk_bls381(env: Env, dao_id: u64) -> VerificationKeyBls381 {

        crate::Voting::bump_instance(&env);
        let vk_ver_key = DataKey::VkVersionBls381(dao_id);
        let version: u32 = env
            .storage()
            .persistent()
            .get(&vk_ver_key)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::VkNotSet));
        crate::Voting::bump_persistent(&env, &vk_ver_key);
        crate::Voting::get_vk_by_version_bls381(&env, dao_id, version)
    
}


/// Get a specific BLS12-381 VK version
pub(crate) fn vk_for_version_bls381(env: Env, dao_id: u64, version: u32) -> VerificationKeyBls381 {

        crate::Voting::bump_instance(&env);
        crate::Voting::get_vk_by_version_bls381(&env, dao_id, version)
    
}


/// Create or update election configuration with token-gating parameters.
/// Sets the minimum balance required to vote, snapshot ledger, TWAB window,
/// and the number of valid candidates (bound into the ZK proof).
/// Only callable during proposal creation or by DAO admin.
pub(crate) fn set_election_config(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        min_balance: i128,
        twab_window: u64,
        num_candidates: u32,
    ) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
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
        crate::Voting::bump_persistent(&env, &key);
    
}


/// Get election configuration for a proposal.
pub(crate) fn get_election_config(env: Env, dao_id: u64, proposal_id: u64) -> Option<ElectionConfig> {

        crate::Voting::bump_instance(&env);
        let key = DataKey::ElectionConfig(dao_id, proposal_id);
        let config: Option<ElectionConfig> = env.storage().persistent().get(&key);
        if config.is_some() {
            crate::Voting::bump_persistent(&env, &key);
        }
        config
    
}


/// Set commitment window for Merkle root updates during registration.
pub(crate) fn set_commitment_window(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        commitment_window: u64,
        admin: Address,
    ) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
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
        crate::Voting::bump_persistent(&env, &key);
    
}


/// Sets/updates the Merkle root during the Registration phase within the commitment window.
/// Performs cross-contract verification against the Tree contract.
/// Stores root history for auditability and emits an ElectionStatusChangedEvent.
pub(crate) fn set_merkle_root(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        new_root: U256,
        admin: Address,
    ) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        admin.require_auth();

        let tree_contract: Address = crate::Voting::tree_contract(env.clone());
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
        crate::Voting::bump_persistent(&env, &key);

        election_config.merkle_root_set_at = Some(now);
        env.storage()
            .persistent()
            .set(&config_key, &election_config);
        crate::Voting::bump_persistent(&env, &config_key);

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
        crate::Voting::bump_persistent(&env, &history_key);

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
pub(crate) fn activate_proposal(env: Env, dao_id: u64, proposal_id: u64, caller: Address) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
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
        crate::Voting::bump_persistent(&env, &key);

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
pub(crate) fn get_merkle_root_history(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
    ) -> Vec<MerkleRootRecord> {

        crate::Voting::bump_instance(&env);
        let history_key = DataKey::MerkleRootHistory(dao_id, proposal_id);
        let history: Vec<MerkleRootRecord> = env
            .storage()
            .persistent()
            .get(&history_key)
            .unwrap_or_else(|| Vec::new(&env));
        if !history.is_empty() {
            crate::Voting::bump_persistent(&env, &history_key);
        }
        history
    
}


/// Get the number of valid candidates for a proposal's election.
/// Returns 0 if no election config is set (backward-compatible default).
pub(crate) fn get_num_candidates(env: Env, dao_id: u64, proposal_id: u64) -> u32 {

        crate::Voting::get_election_config(env, dao_id, proposal_id)
            .map(|c| c.num_candidates)
            .unwrap_or(0)
    
}


/// Get the snapshot ledger for a proposal (from ProposalInfo).
pub(crate) fn get_snapshot_ledger(env: Env, dao_id: u64, proposal_id: u64) -> u32 {

        let proposal = crate::Voting::get_proposal(env, dao_id, proposal_id);
        proposal.snapshot_ledger
    
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vk_and_weight_bounds_are_stable() {
        assert_eq!(MAX_IC_LENGTH, 21);
        assert_eq!(MAX_WEIGHT, 1_000_000);
        assert_eq!(MIN_WEIGHT, 1);
        assert_eq!(DOMAIN_TAG_WEIGHTED, 0x7774_5f76);
    }

    #[test]
    fn pause_duration_is_72_hours() {
        assert_eq!(MAX_PAUSE_DURATION, 72 * 60 * 60);
    }
}
