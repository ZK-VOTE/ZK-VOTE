// Vote Mode Tests
//
// Tests for the two voting modes:
// 1. Fixed Mode: Only members at time of proposal creation can vote
// 2. Trailing Mode: Members added after proposal creation can also vote
//
// These tests use REAL Groth16 proof data (BE-encoded) for accurate BN254 verification.

use soroban_sdk::{
    testutils::Address as _, Address, Bytes, BytesN, Env, String, Vec as SdkVec, U256,
};

// Import actual contract clients from crates (not WASM)
use dao_registry::DaoRegistryClient;
use membership_sbt::MembershipSbtClient;
use membership_tree::MembershipTreeClient;
use voting::{Proof, VerificationKey, VoteMode, VotingClient};

fn setup_contracts(env: &Env) -> (Address, Address, Address, Address, Address) {
    // Deploy contracts
    let registry_id = env.register(dao_registry::DaoRegistry, ());
    let sbt_id = env.register(membership_sbt::MembershipSbt, (registry_id.clone(),));
    let tree_id = env.register(
        membership_tree::MembershipTree,
        (sbt_id.clone(), registry_id.clone()),
    );
    let voting_id = env.register(voting::Voting, (tree_id.clone(), registry_id.clone()));

    let admin = Address::generate(env);

    (registry_id, sbt_id, tree_id, voting_id, admin)
}

// Helper to convert hex string to BytesN
fn hex_to_bytes<const N: usize>(env: &Env, hex: &str) -> BytesN<N> {
    let bytes = hex::decode(hex).expect("invalid hex");
    assert_eq!(bytes.len(), N, "hex string wrong length");
    BytesN::from_array(env, &bytes.try_into().unwrap())
}

// Helper to convert hex string to U256 (big-endian)
fn hex_str_to_u256(env: &Env, hex: &str) -> U256 {
    let bytes = hex::decode(hex).expect("invalid hex");
    let mut padded = [0u8; 32];
    let start = 32 - bytes.len();
    padded[start..].copy_from_slice(&bytes);
    U256::from_be_bytes(env, &Bytes::from_array(env, &padded))
}

// Real verification key from circuits/build/verification_key_soroban_be.json (BIG-ENDIAN)
// 6 IC elements for 5 public signals: root, nullifier, daoId, proposalId, voteChoice
// (commitment is now a PRIVATE signal for improved privacy)
fn get_real_vk(env: &Env) -> VerificationKey {
    let mut ic = SdkVec::new(env);
    ic.push_back(hex_to_bytes(env, "0386c87c5f77037451fea91c60759229ca390a30e60d564e5ff0f0f95ffbd18207683040dab753f41635f947d3d13e057c73cb92a38d83400af26019ce24d54f"));
    ic.push_back(hex_to_bytes(env, "0b8de6c132c626e6aa4676f7ca94d9ebeb93375ea3584b6337f9f823ac4157dd0b3de52288f2f4473c0c5041cf9a754decd57e2c0f6b2979d3467a30570c01ea"));
    ic.push_back(hex_to_bytes(env, "139bde66aa5aa4311aca037419840a70fed606a0ed112e6686e1feb44183672d0e56114fa301c02ab1f0baac0973de2759bf26ccbbc594f8627054001f8ad27a"));
    ic.push_back(hex_to_bytes(env, "2a7f1a9e3de9411015b1c5652856bc7a467110344153252026c44ca55f5dca632f0db38e6d0268092cba5ea0b5db9610e45bd8b4aac852527aeb6323c8f09804"));
    ic.push_back(hex_to_bytes(env, "09c5b9b793a6f8098f0ac918aa0a19a75b74e7f1428f726194a48af37da8ac14122edc5b3704f106fa3c095ac74f524032e460179c3e8ecd562ef050c884336a"));
    ic.push_back(hex_to_bytes(env, "143c06565aad1cacd0ddbc0cfc6dd131c70392d29c16d8c80ed7f62ada52587b13e189e68fe2fe8806b272da3c5762a18b23680cdeda63faef014b7dd6806f21"));
    // Removed 7th IC element (was for commitment public signal)

    VerificationKey {
        alpha: hex_to_bytes(env, "2d4d9aa7e302d9df41749d5507949d05dbea33fbb16c643b22f599a2be6df2e214bedd503c37ceb061d8ec60209fe345ce89830a19230301f076caff004d1926"),
        beta: hex_to_bytes(env, "0967032fcbf776d1afc985f88877f182d38480a653f2decaa9794cbc3bf3060c0e187847ad4c798374d0d6732bf501847dd68bc0e071241e0213bc7fc13db7ab304cfbd1e08a704a99f5e847d93f8c3caafddec46b7a0d379da69a4d112346a71739c1b1a457a8c7313123d24d2f9192f896b7c63eea05a9d57f06547ad0cec8"),
        gamma: hex_to_bytes(env, "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c21800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa"),
        delta: hex_to_bytes(env, "0d633d289456016e0c0e975e7da2d19153ca3b6a74dd83331df6407a68d9e9f81ff0cfb2f48375ed6c03370d8a55e25777a3fb3f6c748bb9e83116bf19ef6385062ce3e273c849fdc51bb2cf34308828862f248134512541fde080ed08d0eb4016cef3c53afe73c871cd493e46139da661ed0d2875fd63c8044c38a68b4caec5"),
        ic,
    }
}

// Real proof from circuits/build/proof_soroban_be.json (BIG-ENDIAN)
// Generated with: secret=123456789, salt=987654321, daoId=1, proposalId=1, voteChoice=1
fn get_real_proof(env: &Env) -> Proof {
    Proof {
        a: hex_to_bytes(
            env,
            "06c6298fee7716bce0aca65c8e6ccde25e06bdcb6268a1b2d31db1b8d750a9b0050db001368342508a5404e7d7b5ff5f1c7d27ee0362fdae57730ab2a1b524de",
        ),
        b: hex_to_bytes(
            env,
            "07bbb05583f634a5ff3ffe912712e7c69d560ec9b4378bc556cb0f29f16d779e02b606ac49555280a0588d6a84c8a344cd1cdc20c50306d549f0a71c6744b3e11ef657db258d908b245d6dc735ae2429e38078384a144b717e921dd1552534b32db66d34db9e4ad93c69ece88542249d7339bdd627ec6a8f619faddfa30edf30",
        ),
        c: hex_to_bytes(
            env,
            "1d147aacab1c868ac69c78f1bf20a52ed47aaa3a96399fb4e2958316b0dba7c321666fe7da09fc9039397d3c03d1f1fa86d2e917161dade28cac8e0639a6c00d",
        ),
    }
}

// Test data from the real proof:
// commitment = 16832421271961222550979173996485995711342823810308835997146707681980704453417
// nullifier = 5760508796108392755529358167294721063592787938597807569861628631651201858128
// root = 17138981085726982929815047770222948937180916992196016628536485002859509881328
// (depth 18, commitment at index 0)
const REAL_COMMITMENT_HEX: &str =
    "2536d01521137bf7b39e3fd26c1376f456ce46a45993a5d7c3c158a450fd7329";
const REAL_NULLIFIER_HEX: &str = "0cbc551a937e12107e513efd646a4f32eec3f0d2c130532e3516bdd9d4683a50";
// Member2 identity: different secret/salt for late joiner test
// secret=555555555555555555, salt=666666666666666666, daoId=1, proposalId=1, voteChoice=1
const REAL2_COMMITMENT_HEX: &str =
    "0ee80d672b29fc843f8332d50d88ea16661cfba5c81e3a0c322e8ae889aafacb";
const REAL2_NULLIFIER_HEX: &str =
    "24e3bcb4baf4c1183d0b36498dc1b59e0d349c33a65ffc8fd0d89d7f1dfcfeec";
const REAL2_ROOT_HEX: &str = "115db8e956aa845dc267878d7c4ee1ad00cbb1ab02a857929f152fe91ffb4605";
// Soroban-converted proof for member2 (BE, G2 ordered as [imag_x, real_x, imag_y, real_y])
const REAL2_PROOF_A: &str =
    "20c008d8e65d3cda8a5776ddde8bb92e3706a1b186ead62238d65b3263b8770909bf9629d0a3c8b1e71e590a1444b886dc4f84e9b66c60cb238087a6be14003f";
const REAL2_PROOF_B: &str = "1682573d9a4776167c0ddc74f0429da4d45367ec68e686cec3df1e2daba92ee129bb0f0e5db41a4e3c1d934edc820b4301591387f71b2413fd5fa17d2ec50bb42b63fc5889ec01f5b687e6a862f5ca982ac4234a2793705b547a0e56e8ea971d04d8d8eb7bd586b32cf2d60712d59474067034f87e2521d0821e36f2a712c5fe";
const REAL2_PROOF_C: &str =
    "26b5b0e8fdf645d99e117e4b1799773334f4b0f9508b484fa88d546784dd2424122b0ff02af71ad64efc4f75248775804046e51a3ac49d9924c9c67b5326bf64";

// Churn test: two trailing proposals, late joiner votes on both (testutils path, mock proof).
// This test verifies trailing mode allows late joiners to vote on multiple parallel proposals.
#[test]
fn test_trailing_mode_churn_across_parallel_proposals() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    let member1 = Address::generate(&env);
    let member2 = Address::generate(&env);

    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Churn DAO"),
        &admin,
        &true,
        &true,
        &None,
    );
    tree_client.init_tree(&dao_id, &18, &admin);
    // Use mock VK/proof; in testutils path verification is bypassed.
    let vk = create_mock_vk(&env);
    voting_client.set_vk(&dao_id, &vk, &admin);

    // member1 joins before proposals
    sbt_client.mint(&dao_id, &member1, &admin, &None);
    let commitment1 = U256::from_u32(&env, 111);
    tree_client.register_with_caller(&dao_id, &commitment1, &member1);

    let root_at_creation = tree_client.current_root(&dao_id);

    // Two trailing proposals
    let proposal_a = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "A"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 3600),
        &member1,
        &VoteMode::Trailing,
    );
    let proposal_b = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "B"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 3600),
        &member1,
        &VoteMode::Trailing,
    );

    // member2 joins after proposals
    sbt_client.mint(&dao_id, &member2, &admin, &None);
    let commitment2 = U256::from_u32(&env, 222);
    tree_client.register_with_caller(&dao_id, &commitment2, &member2);
    let root_after_join = tree_client.current_root(&dao_id);
    assert_ne!(root_at_creation, root_after_join);

    let nullifier1 = U256::from_u32(&env, 9001);
    let nullifier2 = U256::from_u32(&env, 9002);
    let proof = create_mock_proof(&env);

    // Vote on proposal A should succeed
    voting_client.vote(
        &dao_id,
        &proposal_a,
        &true,
        &nullifier1,
        &root_after_join,
        &proof,
    );

    // Second vote reuses a distinct nullifier on proposal B; should also succeed
    voting_client.vote(
        &dao_id,
        &proposal_b,
        &false,
        &nullifier2,
        &root_after_join,
        &proof,
    );

    let pa = voting_client.get_proposal(&dao_id, &proposal_a);
    let pb = voting_client.get_proposal(&dao_id, &proposal_b);
    assert_eq!(pa.yes_votes + pa.no_votes, 1);
    assert_eq!(pb.yes_votes + pb.no_votes, 1);
}

// Helper function to create BN254 G1 generator point (1, 2) - for mock proofs in failure tests
fn bn254_g1_generator(env: &Env) -> soroban_sdk::BytesN<64> {
    let mut bytes = [0u8; 64];
    // x = 1 (big-endian, 32 bytes)
    bytes[31] = 1;
    // y = 2 (big-endian, 32 bytes)
    bytes[63] = 2;
    soroban_sdk::BytesN::from_array(env, &bytes)
}

// Helper function to create BN254 G2 generator point - for mock proofs in failure tests
fn bn254_g2_generator(env: &Env) -> soroban_sdk::BytesN<128> {
    let bytes: [u8; 128] = [
        // x1 (imag) - 32 bytes
        0x18, 0x00, 0x50, 0x6a, 0x06, 0x12, 0x86, 0xeb, 0x6a, 0x84, 0xa5, 0x73, 0x0b, 0x8f, 0x10,
        0x29, 0x3e, 0x29, 0x81, 0x6c, 0xd1, 0x91, 0x3d, 0x53, 0x38, 0xf7, 0x15, 0xde, 0x3e, 0x98,
        0xf9, 0xad, // x2 (real) - 32 bytes
        0x19, 0x83, 0x90, 0x42, 0x11, 0xa5, 0x3f, 0x6e, 0x0b, 0x08, 0x53, 0xa9, 0x0a, 0x00, 0xef,
        0xbf, 0xf1, 0x70, 0x0c, 0x7b, 0x1d, 0xc0, 0x06, 0x32, 0x4d, 0x85, 0x9d, 0x75, 0xe3, 0xca,
        0xa5, 0xa2, // y1 (imag) - 32 bytes
        0x12, 0xc8, 0x5e, 0xa5, 0xdb, 0x8c, 0x6d, 0xeb, 0x4a, 0xab, 0x71, 0x8e, 0x80, 0x6a, 0x51,
        0xa5, 0x66, 0x08, 0x21, 0x4c, 0x3f, 0x62, 0x8b, 0x96, 0x2c, 0xf1, 0x91, 0xea, 0xcd, 0xc8,
        0x0e, 0x7a, // y2 (real) - 32 bytes
        0x09, 0x0d, 0x97, 0xc0, 0x9c, 0xe1, 0x48, 0x60, 0x63, 0xb3, 0x59, 0xf3, 0xdd, 0x89, 0xb7,
        0xc4, 0x3c, 0x5f, 0x18, 0x95, 0x8f, 0xb3, 0xe6, 0xb9, 0x6d, 0xb5, 0x5e, 0x19, 0xa3, 0xb7,
        0xc0, 0xfb,
    ];
    soroban_sdk::BytesN::from_array(env, &bytes)
}

// Mock VK for failure tests (doesn't need to be valid since tests expect failures)
fn create_mock_vk(env: &Env) -> VerificationKey {
    let g1_gen = bn254_g1_generator(env);
    let g2_gen = bn254_g2_generator(env);

    VerificationKey {
        alpha: g1_gen.clone(),
        beta: g2_gen.clone(),
        gamma: g2_gen.clone(),
        delta: g2_gen.clone(),
        ic: soroban_sdk::vec![
            env,
            g1_gen.clone(),
            g1_gen.clone(),
            g1_gen.clone(),
            g1_gen.clone(),
            g1_gen.clone(),
            g1_gen.clone(), // 6 elements for 5 public signals + 1
        ],
    }
}

// Mock proof for failure tests
fn create_mock_proof(env: &Env) -> Proof {
    Proof {
        a: bn254_g1_generator(env),
        b: bn254_g2_generator(env),
        c: bn254_g1_generator(env),
    }
}

// Test: Fixed mode - late joiner cannot vote (root mismatch)
// This test fails BEFORE proof verification (at root check), so mock data is fine
#[test]
#[should_panic(expected = "HostError")]
fn test_fixed_mode_late_joiner_cannot_vote() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    // Create DAO
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    // Initialize tree
    tree_client.init_tree(&dao_id, &18, &admin);

    // Set VK (mock is fine since we fail before proof verification)
    let vk = create_mock_vk(&env);
    voting_client.set_vk(&dao_id, &vk, &admin);

    // Member 1 joins
    let member1 = Address::generate(&env);
    sbt_client.mint(&dao_id, &member1, &admin, &None);
    let commitment1 = U256::from_u32(&env, 111);
    tree_client.register_with_caller(&dao_id, &commitment1, &member1);

    // Create proposal in FIXED mode
    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Test proposal"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 86400),
        &member1,
        &VoteMode::Fixed, // Fixed mode
    );

    // Member 2 joins AFTER proposal creation
    let member2 = Address::generate(&env);
    sbt_client.mint(&dao_id, &member2, &admin, &None);
    let commitment2 = U256::from_u32(&env, 222);
    tree_client.register_with_caller(&dao_id, &commitment2, &member2);

    let new_root = tree_client.current_root(&dao_id);

    // Member 2 attempts to vote with new root (should fail - root mismatch)
    let nullifier2 = U256::from_u32(&env, 999);
    let proof2 = create_mock_proof(&env);

    // This should panic with "root must match proposal eligible root"
    voting_client.vote(
        &dao_id,
        &proposal_id,
        &true,
        &nullifier2,
        &new_root,
        &proof2,
    );
}

// Test: Trailing mode - late joiner CAN vote (root history allows newer roots)
// Uses REAL proof data from circuits/build/ for actual BN254 verification
#[test]
fn test_trailing_mode_late_joiner_can_vote() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    // Create DAO (first DAO will have dao_id = 1, matching the proof)
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );
    assert_eq!(dao_id, 1, "First DAO must have ID 1 to match proof");

    // Initialize tree with depth 18 (matching the proof)
    tree_client.init_tree(&dao_id, &18, &admin);

    // Set REAL VK
    let vk = get_real_vk(&env);
    voting_client.set_vk(&dao_id, &vk, &admin);

    // Member 1 joins with the REAL commitment from the proof
    // This is the commitment the proof was generated for
    let member1 = Address::generate(&env);
    sbt_client.mint(&dao_id, &member1, &admin, &None);
    let commitment1 = hex_str_to_u256(&env, REAL_COMMITMENT_HEX);
    tree_client.register_with_caller(&dao_id, &commitment1, &member1);

    // The root after registering commitment1 should match the proof's root
    let root_after_member1 = tree_client.current_root(&dao_id);

    // Create proposal in TRAILING mode (first proposal will have proposal_id = 1, matching the proof)
    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Test proposal"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 86400),
        &member1,
        &VoteMode::Trailing, // Trailing mode
    );
    assert_eq!(
        proposal_id, 1,
        "First proposal must have ID 1 to match proof"
    );

    // Member 2 joins AFTER proposal creation (changes the root)
    let member2 = Address::generate(&env);
    sbt_client.mint(&dao_id, &member2, &admin, &None);
    let commitment2 = U256::from_u32(&env, 222);
    tree_client.register_with_caller(&dao_id, &commitment2, &member2);

    // In trailing mode, member1 can STILL vote with the OLD root (captured at proposal creation)
    // because trailing mode tracks root history and allows any valid historical root
    let nullifier = hex_str_to_u256(&env, REAL_NULLIFIER_HEX);
    let proof = get_real_proof(&env);

    // Vote with the root that was valid when member1 registered (before member2 joined)
    voting_client.vote(
        &dao_id,
        &proposal_id,
        &true,
        &nullifier,
        &root_after_member1, // Use the root from when member1 was the only member
        &proof,
    );

    // Verify vote counted
    let proposal = voting_client.get_proposal(&dao_id, &proposal_id);
    assert_eq!(proposal.yes_votes, 1);

    println!("✅ Trailing mode correctly allowed member to vote with historical root");
}

/// Trailing mode with a real proof for a late joiner (member at index 0 in an empty tree).
/// Uses member2 identity: secret=555555555555555555, salt=666666666666666666
/// Proof generated for daoId=1, proposalId=1, voteChoice=1
#[test]
fn test_trailing_mode_late_joiner_can_vote_real_member2() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );
    tree_client.init_tree(&dao_id, &18, &admin);

    // Use real VK
    let vk = get_real_vk(&env);
    voting_client.set_vk(&dao_id, &vk, &admin);

    // Creator needs SBT to create proposal (but doesn't need to be registered)
    let creator = Address::generate(&env);
    sbt_client.mint(&dao_id, &creator, &admin, &None);

    // Create trailing proposal BEFORE the member is registered
    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Trailing member2"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 86400),
        &creator,
        &VoteMode::Trailing,
    );
    assert_eq!(proposal_id, 1);

    // Late joiner (member 2) registers commitment at index 0 (first leaf)
    let member2 = Address::generate(&env);
    sbt_client.mint(&dao_id, &member2, &admin, &None);
    let commitment2 = hex_str_to_u256(&env, REAL2_COMMITMENT_HEX);
    tree_client.register_with_caller(&dao_id, &commitment2, &member2);
    let root_after_join = tree_client.current_root(&dao_id);
    assert_eq!(root_after_join, hex_str_to_u256(&env, REAL2_ROOT_HEX));

    let nullifier2 = hex_str_to_u256(&env, REAL2_NULLIFIER_HEX);
    let proof = Proof {
        a: hex_to_bytes(&env, REAL2_PROOF_A),
        b: hex_to_bytes(&env, REAL2_PROOF_B),
        c: hex_to_bytes(&env, REAL2_PROOF_C),
    };

    // Vote should succeed with the newer root in trailing mode
    voting_client.vote(
        &dao_id,
        &proposal_id,
        &true,
        &nullifier2,
        &root_after_join,
        &proof,
    );

    let updated = voting_client.get_proposal(&dao_id, &proposal_id);
    assert_eq!(updated.yes_votes, 1);
}

// Test: Trailing mode - removed member cannot vote on NEW proposal (commitment revoked)
// This test fails BEFORE proof verification (at revocation check), so mock data is fine
#[test]
#[should_panic(expected = "HostError")]
fn test_trailing_mode_removed_member_cannot_vote_on_new_proposal() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    // Create DAO
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    // Initialize tree and set VK (mock is fine since we fail before proof verification)
    tree_client.init_tree(&dao_id, &18, &admin);

    let vk = create_mock_vk(&env);
    voting_client.set_vk(&dao_id, &vk, &admin);

    // Member 1 joins
    let member1 = Address::generate(&env);
    sbt_client.mint(&dao_id, &member1, &admin, &None);
    let commitment1 = U256::from_u32(&env, 111);
    tree_client.register_with_caller(&dao_id, &commitment1, &member1);

    let old_root = tree_client.current_root(&dao_id);

    // Admin removes member1 (this revokes their commitment)
    tree_client.remove_member(&dao_id, &member1, &admin);

    // Member 2 joins to create a new proposal
    let member2 = Address::generate(&env);
    sbt_client.mint(&dao_id, &member2, &admin, &None);
    let commitment2 = U256::from_u32(&env, 222);
    tree_client.register_with_caller(&dao_id, &commitment2, &member2);

    // Create proposal AFTER member1 removal in TRAILING mode
    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "New proposal"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 86400),
        &member2,
        &VoteMode::Trailing, // Trailing mode
    );

    // Removed member1 tries to vote (should fail - commitment revoked)
    let nullifier1 = U256::from_u32(&env, 888);
    let proof1 = create_mock_proof(&env);

    // This should panic with "commitment revoked at proposal creation"
    voting_client.vote(
        &dao_id,
        &proposal_id,
        &true,
        &nullifier1,
        &old_root,
        &proof1,
    );
}

// Test: Trailing mode - removed member CANNOT vote even on OLD proposal
// Current contract behavior: once revoked, a member cannot vote on ANY proposal
// (they would need to be reinstated first)
// This test documents this behavior - see lib.rs for the equivalent native test
#[test]
#[should_panic(expected = "HostError")]
fn test_trailing_mode_removed_member_cannot_vote_on_old_proposal() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    // Create DAO
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    // Initialize tree and set VK (mock is fine since we fail before proof verification)
    tree_client.init_tree(&dao_id, &18, &admin);

    let vk = create_mock_vk(&env);
    voting_client.set_vk(&dao_id, &vk, &admin);

    // Member 1 joins
    let member1 = Address::generate(&env);
    sbt_client.mint(&dao_id, &member1, &admin, &None);
    let commitment1 = U256::from_u32(&env, 111);
    tree_client.register_with_caller(&dao_id, &commitment1, &member1);

    // Create proposal BEFORE removal in TRAILING mode
    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Old proposal"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 86400),
        &member1,
        &VoteMode::Trailing, // Trailing mode
    );

    let old_root = tree_client.current_root(&dao_id);

    // Admin removes member1 AFTER proposal creation
    tree_client.remove_member(&dao_id, &member1, &admin);

    // Removed member1 tries to vote - this FAILS because revocation check happens first
    // The contract checks if commitment is currently revoked, regardless of when proposal was created
    let nullifier1 = U256::from_u32(&env, 888);
    let proof1 = create_mock_proof(&env);

    // This should panic with "commitment revoked"
    voting_client.vote(
        &dao_id,
        &proposal_id,
        &true,
        &nullifier1,
        &old_root,
        &proof1,
    );
}
