// Direct Poseidon Hash Test
//
// This test isolates the Poseidon hash function to determine if the KAT failure
// is caused by the hash itself or the Merkle tree construction logic.

use soroban_sdk::{Bytes, Env, U256};

#[test]
fn test_poseidon_direct_hash() {
    // Test the Poseidon hash function directly
    // Input: Poseidon(12345, 67890)
    // Expected from circomlib: 0x1914879b2a4e7f9555f3eb55837243cefb1366a692794a7e5b5b3181fb14b49b

    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();

    // Create input values as U256
    let _input1 = U256::from_u32(&env, 12345);
    let _input2 = U256::from_u32(&env, 67890);

    println!("Input 1: 12345");
    println!("Input 2: 67890");

    // Call Poseidon hash via crypto::poseidon
    // Note: The exact API depends on how P25 exposes Poseidon
    // We need to check the membership-tree contract to see how it's called

    // Expected output from circomlib
    let expected_bytes: [u8; 32] = [
        0x19, 0x14, 0x87, 0x9b, 0x2a, 0x4e, 0x7f, 0x95, 0x55, 0xf3, 0xeb, 0x55, 0x83, 0x72, 0x43,
        0xce, 0xfb, 0x13, 0x66, 0xa6, 0x92, 0x79, 0x4a, 0x7e, 0x5b, 0x5b, 0x31, 0x81, 0xfb, 0x14,
        0xb4, 0x9b,
    ];
    let _expected = U256::from_be_bytes(&env, &Bytes::from_array(&env, &expected_bytes));

    print!("Expected (circomlib): 0x");
    for byte in expected_bytes {
        print!("{:02x}", byte);
    }
    println!();

    println!("\n⚠️  This test is incomplete - need to determine P25 Poseidon API");
    println!("Check membership-tree contract to see how Poseidon is called");
}

#[test]
fn test_empty_tree_root() {
    // Test what the empty tree root is with P25
    // This helps understand zero leaf handling

    use soroban_sdk::{testutils::Address as _, Address, Env, String};

    // Import actual contract clients from crates (not WASM)
    use dao_registry::DaoRegistryClient;

    use membership_tree::MembershipTreeClient;

    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    // Deploy contracts
    let registry_id = env.register(dao_registry::DaoRegistry, ());
    let sbt_id = env.register(membership_sbt::MembershipSbt, (registry_id.clone(),));
    let tree_id = env.register(
        membership_tree::MembershipTree,
        (sbt_id.clone(), registry_id.clone()),
    );

    let admin = Address::generate(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);

    // Create DAO
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Empty Tree Test"),
        &admin,
        &false,
        &true,
        &None,
    );

    // Initialize empty tree with depth 20
    tree_client.init_tree(&dao_id, &18, &admin);

    // Get the empty root
    let empty_root = tree_client.current_root(&dao_id);

    let root_bytes = empty_root.to_be_bytes();
    print!("\nEmpty tree root (depth 20) from P25: 0x");
    for i in 0..32 {
        print!("{:02x}", root_bytes.get(i).unwrap());
    }
    println!();

    // For comparison, circomlib empty tree root for depth 20 is computed as:
    // Level 0 (leaves): zero = 0
    // Level 1: zero = Poseidon(0, 0)
    // Level 2: zero = Poseidon(zero_1, zero_1)
    // ... up to level 20

    println!("\nℹ️  To compare with circomlib, compute empty tree root in JS:");
    println!("   const poseidon = require('circomlibjs').poseidon;");
    println!("   let zero = 0n;");
    println!("   for (let i = 0; i < 20; i++) {{");
    println!("     zero = poseidon([zero, zero]);");
    println!("   }}");
    println!("   console.log('0x' + zero.toString(16).padStart(64, '0'));");
}
