use super::*;
use soroban_sdk::{testutils::Address as _, Bytes, BytesN, Env, String};

#[test]
fn test_create_dao() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let name = String::from_str(&env, "Test DAO");

    let dao_id = client.create_dao(&name, &admin, &false, &true, &None);
    assert_eq!(dao_id, 1);

    let info = client.get_dao(&dao_id);
    assert_eq!(info.id, 1);
    assert_eq!(info.admin, admin);
    assert_eq!(info.name, name);
    assert!(!info.membership_open);
    assert!(info.members_can_propose);
}

#[test]
fn test_create_multiple_daos() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);

    let dao1 = client.create_dao(
        &String::from_str(&env, "DAO 1"),
        &admin1,
        &false,
        &true,
        &None,
    );
    let dao2 = client.create_dao(
        &String::from_str(&env, "DAO 2"),
        &admin2,
        &true,
        &true,
        &None,
    );
    let dao3 = client.create_dao(
        &String::from_str(&env, "DAO 3"),
        &admin1,
        &false,
        &false,
        &None,
    );

    assert_eq!(dao1, 1);
    assert_eq!(dao2, 2);
    assert_eq!(dao3, 3);

    assert_eq!(client.get_admin(&dao1), admin1);
    assert_eq!(client.get_admin(&dao2), admin2);
    assert_eq!(client.get_admin(&dao3), admin1);

    assert_eq!(client.dao_count(), 3);
}

#[test]
fn test_dao_exists() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let dao_id = client.create_dao(
        &String::from_str(&env, "Test"),
        &admin,
        &false,
        &true,
        &None,
    );

    assert!(client.dao_exists(&dao_id));
    assert!(!client.dao_exists(&999));
}

#[test]
fn test_transfer_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);

    let dao_id = client.create_dao(
        &String::from_str(&env, "Test"),
        &admin1,
        &false,
        &true,
        &None,
    );
    assert_eq!(client.get_admin(&dao_id), admin1);

    client.transfer_admin(&dao_id, &admin2);
    assert_eq!(client.get_admin(&dao_id), admin2);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_get_nonexistent_dao_fails() {
    let env = Env::default();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    client.get_dao(&999);
}

#[test]
fn test_create_dao_requires_admin_auth() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.create_dao(
        &String::from_str(&env, "Test"),
        &admin,
        &false,
        &true,
        &None,
    );

    // Verify admin auth was required
    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, admin);
}

#[test]
fn test_transfer_admin_requires_current_admin_auth() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);

    let dao_id = client.create_dao(
        &String::from_str(&env, "Test"),
        &admin1,
        &false,
        &true,
        &None,
    );
    client.transfer_admin(&dao_id, &admin2);

    // Verify old admin auth was required for transfer
    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, admin1);
}

#[test]
fn test_dao_count_consistency() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    assert_eq!(client.dao_count(), 0);

    let admin = Address::generate(&env);
    client.create_dao(
        &String::from_str(&env, "DAO 1"),
        &admin,
        &false,
        &true,
        &None,
    );
    assert_eq!(client.dao_count(), 1);

    client.create_dao(
        &String::from_str(&env, "DAO 2"),
        &admin,
        &true,
        &true,
        &None,
    );
    assert_eq!(client.dao_count(), 2);

    client.create_dao(
        &String::from_str(&env, "DAO 3"),
        &admin,
        &false,
        &false,
        &None,
    );
    assert_eq!(client.dao_count(), 3);
}

#[test]
fn test_create_dao_max_name_length_succeeds() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    // Create name exactly 24 chars (MAX_DAO_NAME_LEN)
    let max_name = "a".repeat(24);

    let dao_id = client.create_dao(
        &String::from_str(&env, &max_name),
        &admin,
        &false,
        &true,
        &None,
    );
    assert_eq!(dao_id, 1);

    let info = client.get_dao(&dao_id);
    assert_eq!(info.name.len(), 24);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_create_dao_name_too_long_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    // Create name > 24 chars (MAX_DAO_NAME_LEN)
    let long_name = "a".repeat(25);

    client.create_dao(
        &String::from_str(&env, &long_name),
        &admin,
        &false,
        &true,
        &None,
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_create_dao_name_extremely_long_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    // Create name much larger than limit (5KB)
    let extreme_name = "a".repeat(5000);

    client.create_dao(
        &String::from_str(&env, &extreme_name),
        &admin,
        &false,
        &true,
        &None,
    );
}

#[test]
fn test_membership_open_field() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);

    // Create closed membership DAO
    let closed_dao_id = client.create_dao(
        &String::from_str(&env, "Closed DAO"),
        &admin,
        &false,
        &true,
        &None,
    );
    assert!(!client.is_membership_open(&closed_dao_id));

    // Create open membership DAO
    let open_dao_id = client.create_dao(
        &String::from_str(&env, "Open DAO"),
        &admin,
        &true,
        &true,
        &None,
    );
    assert!(client.is_membership_open(&open_dao_id));

    // Verify info struct contains correct value
    let closed_info = client.get_dao(&closed_dao_id);
    assert!(!closed_info.membership_open);

    let open_info = client.get_dao(&open_dao_id);
    assert!(open_info.membership_open);
}

#[test]
fn test_members_can_propose_field() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);

    // Create DAO where members can propose
    let members_propose_dao = client.create_dao(
        &String::from_str(&env, "Members Propose"),
        &admin,
        &false,
        &true,
        &None,
    );
    assert!(client.members_can_propose(&members_propose_dao));

    // Create DAO where only admin can propose
    let admin_only_dao = client.create_dao(
        &String::from_str(&env, "Admin Only"),
        &admin,
        &false,
        &false,
        &None,
    );
    assert!(!client.members_can_propose(&admin_only_dao));

    // Verify info struct contains correct value
    let members_info = client.get_dao(&members_propose_dao);
    assert!(members_info.members_can_propose);

    let admin_info = client.get_dao(&admin_only_dao);
    assert!(!admin_info.members_can_propose);
}

#[test]
fn test_set_proposal_mode() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);

    // Create DAO where members can propose
    let dao_id = client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );
    assert!(client.members_can_propose(&dao_id));

    // Change to admin-only mode
    client.set_proposal_mode(&dao_id, &false, &admin);
    assert!(!client.members_can_propose(&dao_id));

    // Change back to members-can-propose mode
    client.set_proposal_mode(&dao_id, &true, &admin);
    assert!(client.members_can_propose(&dao_id));
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_set_proposal_mode_non_admin_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let non_admin = Address::generate(&env);

    // Create DAO
    let dao_id = client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    // Non-admin tries to change proposal mode - should fail with NotAdmin error (code #3)
    client.set_proposal_mode(&dao_id, &false, &non_admin);
}

#[test]
fn test_propose_contract_upgrade_records_timelock_metadata() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let dao_id = client.create_dao(
        &String::from_str(&env, "Upgrade DAO"),
        &admin,
        &false,
        &false,
        &None,
    );
    let target_contract = Address::generate(&env);
    let wasm_hash = BytesN::from_array(&env, &[7u8; 32]);
    let rollback_wasm_hash = BytesN::from_array(&env, &[3u8; 32]);
    let eta = env.ledger().timestamp() + 86_400;
    let expires_at = eta + 86_400;
    let migration_payload = Bytes::from_array(&env, b"migrate:v2");

    let proposal_id = client.propose_contract_upgrade(
        &dao_id,
        &target_contract,
        &wasm_hash,
        &rollback_wasm_hash,
        &1u32,
        &2u32,
        &2u32,
        &migration_payload,
        &eta,
        &expires_at,
        &admin,
    );

    let proposal = client.get_contract_upgrade_proposal(&dao_id, &proposal_id);
    assert_eq!(proposal.dao_id, dao_id);
    assert_eq!(proposal.target_contract, target_contract);
    assert_eq!(proposal.wasm_hash, wasm_hash);
    assert_eq!(proposal.rollback_wasm_hash, rollback_wasm_hash);
    assert_eq!(proposal.from_version, 1);
    assert_eq!(proposal.to_version, 2);
    assert_eq!(proposal.storage_version, 2);
    assert_eq!(proposal.migration_payload, migration_payload);
    assert_eq!(proposal.eta, eta);
    assert_eq!(proposal.expires_at, expires_at);
    assert!(!proposal.executed);
    assert!(!proposal.rolled_back);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn test_propose_contract_upgrade_requires_min_timelock() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let dao_id = client.create_dao(
        &String::from_str(&env, "Upgrade DAO"),
        &admin,
        &false,
        &false,
        &None,
    );
    let target_contract = Address::generate(&env);
    let wasm_hash = BytesN::from_array(&env, &[7u8; 32]);
    let rollback_wasm_hash = BytesN::from_array(&env, &[3u8; 32]);
    let eta = env.ledger().timestamp() + 60;
    let expires_at = eta + 86_400;
    let migration_payload = Bytes::new(&env);

    client.propose_contract_upgrade(
        &dao_id,
        &target_contract,
        &wasm_hash,
        &rollback_wasm_hash,
        &1u32,
        &2u32,
        &2u32,
        &migration_payload,
        &eta,
        &expires_at,
        &admin,
    );
}

// ============================================
// ROLE MANAGEMENT TESTS
// ============================================

#[test]
fn test_assign_role() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let member = Address::generate(&env);

    let dao_id = client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    // Assign member role
    client.assign_role(&dao_id, &member, &1u32, &admin);

    // Verify role was assigned
    let role = client.get_member_role(&dao_id, &member);
    assert_eq!(role, Some(1u32));
}

#[test]
fn test_revoke_role() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let member = Address::generate(&env);

    let dao_id = client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    // Assign and then revoke role
    client.assign_role(&dao_id, &member, &1u32, &admin);
    client.revoke_role(&dao_id, &member, &admin);

    // Verify role was revoked
    let role = client.get_member_role(&dao_id, &member);
    assert_eq!(role, None);
}

#[test]
fn test_assign_auditor_role() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let auditor = Address::generate(&env);

    let dao_id = client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    // Assign auditor role (2)
    client.assign_role(&dao_id, &auditor, &2u32, &admin);

    // Verify auditor role was assigned
    let role = client.get_member_role(&dao_id, &auditor);
    assert_eq!(role, Some(2u32));
}

// ============================================
// MULTISIG TESTS
// ============================================

#[test]
fn test_init_multisig() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);
    let signer3 = Address::generate(&env);

    let dao_id = client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    let signers = soroban_sdk::vec![&env, signer1.clone(), signer2.clone(), signer3.clone()];
    client.init_multisig(&dao_id, &signers, &2u32, &admin);

    // Verify multisig config
    let config = client.get_multisig(&dao_id);
    assert!(config.is_some());
    let config = config.unwrap();
    assert_eq!(config.threshold, 2u32);
    assert_eq!(config.signers.len(), 3);
}

#[test]
fn test_create_multisig_proposal() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);

    let dao_id = client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    let signers = soroban_sdk::vec![&env, signer1.clone(), signer2.clone()];
    client.init_multisig(&dao_id, &signers, &2u32, &admin);

    // Create proposal
    let action_data = Bytes::new(&env);
    let proposal_id = client.create_multisig_proposal(
        &dao_id,
        &String::from_str(&env, "Transfer Admin"),
        &String::from_str(&env, "Transfer admin rights"),
        &String::from_str(&env, "TransferAdmin"),
        &action_data,
        &signer1,
    );

    assert_eq!(proposal_id, 1u64);

    // Verify proposal
    let proposal = client.get_multisig_proposal(&dao_id, &proposal_id);
    assert!(proposal.is_some());
    assert_eq!(proposal.unwrap().signatures.len(), 1); // Proposer auto-signs
}

#[test]
fn test_sign_multisig_proposal() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);

    let dao_id = client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    let signers = soroban_sdk::vec![&env, signer1.clone(), signer2.clone()];
    client.init_multisig(&dao_id, &signers, &2u32, &admin);

    // Create and sign proposal
    let action_data = Bytes::new(&env);
    let proposal_id = client.create_multisig_proposal(
        &dao_id,
        &String::from_str(&env, "Transfer Admin"),
        &String::from_str(&env, "Transfer admin rights"),
        &String::from_str(&env, "TransferAdmin"),
        &action_data,
        &signer1,
    );

    // Second signer adds signature
    client.sign_multisig_proposal(&dao_id, &proposal_id, &signer2);

    // Verify signatures
    let proposal = client.get_multisig_proposal(&dao_id, &proposal_id);
    assert_eq!(proposal.unwrap().signatures.len(), 2);
}

#[test]
fn test_execute_multisig_proposal() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoRegistry, ());
    let client = DaoRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);

    let dao_id = client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    let signers = soroban_sdk::vec![&env, signer1.clone(), signer2.clone()];
    client.init_multisig(&dao_id, &signers, &2u32, &admin);

    // Create proposal with both signers
    let action_data = Bytes::new(&env);
    let proposal_id = client.create_multisig_proposal(
        &dao_id,
        &String::from_str(&env, "Transfer Admin"),
        &String::from_str(&env, "Transfer admin rights"),
        &String::from_str(&env, "TransferAdmin"),
        &action_data,
        &signer1,
    );

    client.sign_multisig_proposal(&dao_id, &proposal_id, &signer2);

    // Execute proposal
    client.execute_multisig_proposal(&dao_id, &proposal_id, &signer1);

    // Verify executed
    let proposal = client.get_multisig_proposal(&dao_id, &proposal_id);
    assert!(proposal.unwrap().executed);
}
