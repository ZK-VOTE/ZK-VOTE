#![no_std]
extern crate std;

use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, String, Symbol, Vec, U256};

use circuit_registry::CircuitRegistryClient;
use dao_registry::DaoRegistryClient;
use membership_sbt::MembershipSbtClient;
use membership_tree::MembershipTreeClient;
use voting::{Proof, VerificationKey, VoteMode, VotingClient};

// `set_vk` needs an MPC attestation source; without one it panics before
// the test asserts anything. See zkvote_integration_tests::test_support.
use zkvote_integration_tests::test_support::attach_transcript_registry;
fn create_test_vk(env: &Env) -> VerificationKey {
    let g1_gen = {
        let mut bytes = [0u8; 64];
        bytes[31] = 1;
        bytes[63] = 2;
        BytesN::from_array(env, &bytes)
    };
    let g2_gen = {
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
    VerificationKey {
        alpha: g1_gen.clone(),
        beta: g2_gen.clone(),
        gamma: g2_gen.clone(),
        delta: g2_gen.clone(),
        ic: Vec::from_array(
            env,
            [
                g1_gen.clone(),
                g1_gen.clone(),
                g1_gen.clone(),
                g1_gen.clone(),
                g1_gen.clone(),
                g1_gen.clone(),
                g1_gen, // 7 elements for 6 public signals + 1
            ],
        ),
    }
}

fn create_test_proof(env: &Env) -> Proof {
    let g1_gen = {
        let mut bytes = [0u8; 64];
        bytes[31] = 1;
        bytes[63] = 2;
        BytesN::from_array(env, &bytes)
    };
    let g2_gen = {
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
        a: g1_gen.clone(),
        b: g2_gen,
        c: g1_gen,
    }
}

#[test]
fn test_register_circuit_v2_and_get_vk() {
    let env = Env::default();
    env.mock_all_auths();

    let governance = Address::generate(&env);
    let registry = env.register(circuit_registry::CircuitRegistry, (governance,));
    let client = CircuitRegistryClient::new(&env, &registry);

    let vk = create_test_vk(&env);
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);

    let v2_id = String::from_str(&env, "vote_v2");
    client.register_circuit(
        &v2_id,
        &circuit_registry::CircuitType::Vote,
        &vk,
        &wasm_hash,
        &0,
        &6,
    );

    let circuit = client.get_circuit(&v2_id, &circuit_registry::CircuitType::Vote);
    assert_eq!(circuit.circuit_id, v2_id);
    assert_eq!(circuit.num_public_signals, 6);

    let vk_map = client.get_vk(&v2_id, &circuit_registry::CircuitType::Vote);
    assert_eq!(vk_map.num_public_signals, 6);
}

#[test]
fn test_migrate_dao_and_vote_in_overlap() {
    let env = Env::default();
    env.mock_all_auths();

    let governance = Address::generate(&env);

    let registry_id = env.register(dao_registry::DaoRegistry, ());
    let sbt_id = env.register(membership_sbt::MembershipSbt, (registry_id.clone(),));
    let tree_id = env.register(
        membership_tree::MembershipTree,
        (sbt_id.clone(), registry_id.clone()),
    );
    let guardian = Address::generate(&env);
    let voting_id = env.register(
        voting::Voting,
        (tree_id.clone(), registry_id.clone(), guardian),
    );

    // Attestation source for `set_vk` (see test_support module docs).
    attach_transcript_registry(env.clone(), &voting_id);
    let circuit_reg_id = env.register(circuit_registry::CircuitRegistry, (governance,));

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);
    let circuit_client = CircuitRegistryClient::new(&env, &circuit_reg_id);

    let admin = Address::generate(&env);
    let member = Address::generate(&env);

    let vk = create_test_vk(&env);
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);

    let v1_id = String::from_str(&env, "vote_v1");
    let v2_id = String::from_str(&env, "vote_v2");

    circuit_client.register_circuit(
        &v1_id,
        &circuit_registry::CircuitType::Vote,
        &vk,
        &wasm_hash,
        &0,
        &5,
    );
    circuit_client.register_circuit(
        &v2_id,
        &circuit_registry::CircuitType::Vote,
        &vk,
        &wasm_hash,
        &0,
        &6,
    );

    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Upgrade DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    tree_client.init_tree(&dao_id, &5, &Symbol::new(&env, "BN254"), &admin);
    sbt_client.mint(&dao_id, &member, &admin, &None);

    let commitment = U256::from_u32(&env, 12345);
    tree_client.register_with_caller(&dao_id, &commitment, &member);

    let root = tree_client.current_root(&dao_id);
    voting_client.set_vk(&dao_id, &vk, &admin);

    let now = env.ledger().timestamp();
    let end_time = now + 86400;
    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Circuit Upgrade Test"),
        &String::from_str(&env, ""),
        &end_time,
        &member,
        &VoteMode::Fixed,
    );

    voting_client.set_circuit_registry(&circuit_reg_id);

    let deadline = now + 7200;
    voting_client.set_migration(&dao_id, &v1_id, &v2_id, &deadline);

    let proof = create_test_proof(&env);

    let nullifier = U256::from_u32(&env, 77777);
    voting_client.vote_with_circuit(
        &dao_id,
        &proposal_id,
        &true,
        &nullifier,
        &root,
        &proof,
        &v1_id,
    );

    let proposal = voting_client.get_proposal(&dao_id, &proposal_id);
    assert_eq!(proposal.yes_votes, 1);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_wrong_circuit_id_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let governance = Address::generate(&env);

    let registry_id = env.register(dao_registry::DaoRegistry, ());
    let sbt_id = env.register(membership_sbt::MembershipSbt, (registry_id.clone(),));
    let tree_id = env.register(
        membership_tree::MembershipTree,
        (sbt_id.clone(), registry_id.clone()),
    );
    let guardian = Address::generate(&env);
    let voting_id = env.register(
        voting::Voting,
        (tree_id.clone(), registry_id.clone(), guardian),
    );

    // Attestation source for `set_vk` (see test_support module docs).
    attach_transcript_registry(env.clone(), &voting_id);
    let circuit_reg_id = env.register(circuit_registry::CircuitRegistry, (governance,));

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);
    let circuit_client = CircuitRegistryClient::new(&env, &circuit_reg_id);

    let admin = Address::generate(&env);
    let member = Address::generate(&env);

    let vk = create_test_vk(&env);
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);
    let v1_id = String::from_str(&env, "vote_v1");

    circuit_client.register_circuit(
        &v1_id,
        &circuit_registry::CircuitType::Vote,
        &vk,
        &wasm_hash,
        &0,
        &5,
    );

    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    tree_client.init_tree(&dao_id, &5, &Symbol::new(&env, "BN254"), &admin);
    sbt_client.mint(&dao_id, &member, &admin, &None);

    let commitment = U256::from_u32(&env, 12345);
    tree_client.register_with_caller(&dao_id, &commitment, &member);

    let root = tree_client.current_root(&dao_id);
    voting_client.set_vk(&dao_id, &vk, &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, ""),
        &(now + 86400),
        &member,
        &VoteMode::Fixed,
    );

    voting_client.set_circuit_registry(&circuit_reg_id);

    let proof = create_test_proof(&env);
    let nullifier = U256::from_u32(&env, 99999);

    voting_client.vote_with_circuit(
        &dao_id,
        &proposal_id,
        &true,
        &nullifier,
        &root,
        &proof,
        &String::from_str(&env, "nonexistent_circuit"),
    );
}

#[test]
fn test_dao_upgrade_proposal_and_approval() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    let registry_id = env.register(dao_registry::DaoRegistry, ());
    let registry_client = DaoRegistryClient::new(&env, &registry_id);

    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Upgrade DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    let now = env.ledger().timestamp();
    let deadline = now + 86400;

    let proposal_id = registry_client.propose_circuit_upgrade(
        &dao_id,
        &String::from_str(&env, "vote_v1"),
        &String::from_str(&env, "vote_v2"),
        &String::from_str(&env, "Vote"),
        &deadline,
        &admin,
    );

    assert!(proposal_id > 0);

    let proposal = registry_client.get_circuit_upgrade_proposal(&dao_id, &proposal_id);
    assert_eq!(proposal.from_circuit_id, String::from_str(&env, "vote_v1"));
    assert_eq!(proposal.to_circuit_id, String::from_str(&env, "vote_v2"));
    assert!(!proposal.approved);

    registry_client.approve_circuit_upgrade(&dao_id, &proposal_id, &admin);

    let approved = registry_client.get_circuit_upgrade_proposal(&dao_id, &proposal_id);
    assert!(approved.approved);
}

#[test]
fn test_vote_with_circuit_id() {
    let env = Env::default();
    env.mock_all_auths();

    let governance = Address::generate(&env);

    let registry_id = env.register(dao_registry::DaoRegistry, ());
    let sbt_id = env.register(membership_sbt::MembershipSbt, (registry_id.clone(),));
    let tree_id = env.register(
        membership_tree::MembershipTree,
        (sbt_id.clone(), registry_id.clone()),
    );
    let guardian = Address::generate(&env);
    let voting_id = env.register(
        voting::Voting,
        (tree_id.clone(), registry_id.clone(), guardian),
    );

    // Attestation source for `set_vk` (see test_support module docs).
    attach_transcript_registry(env.clone(), &voting_id);
    let circuit_reg_id = env.register(circuit_registry::CircuitRegistry, (governance,));

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);
    let circuit_client = CircuitRegistryClient::new(&env, &circuit_reg_id);

    let admin = Address::generate(&env);
    let member = Address::generate(&env);

    let vk = create_test_vk(&env);
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);

    let vote_v1 = String::from_str(&env, "vote_v1");
    circuit_client.register_circuit(
        &vote_v1,
        &circuit_registry::CircuitType::Vote,
        &vk,
        &wasm_hash,
        &0,
        &5,
    );

    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Circuit DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    tree_client.init_tree(&dao_id, &5, &Symbol::new(&env, "BN254"), &admin);
    sbt_client.mint(&dao_id, &member, &admin, &None);

    let commitment = U256::from_u32(&env, 42);
    tree_client.register_with_caller(&dao_id, &commitment, &member);

    let root = tree_client.current_root(&dao_id);
    voting_client.set_vk(&dao_id, &vk, &admin);
    voting_client.set_circuit_registry(&circuit_reg_id);

    let _now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Circuit Vote Test"),
        &String::from_str(&env, ""),
        &0,
        &member,
        &VoteMode::Fixed,
    );

    let proof = create_test_proof(&env);
    let nullifier = U256::from_u32(&env, 55555);

    voting_client.vote_with_circuit(
        &dao_id,
        &proposal_id,
        &true,
        &nullifier,
        &root,
        &proof,
        &vote_v1,
    );

    let proposal = voting_client.get_proposal(&dao_id, &proposal_id);
    assert_eq!(proposal.yes_votes, 1);
}
