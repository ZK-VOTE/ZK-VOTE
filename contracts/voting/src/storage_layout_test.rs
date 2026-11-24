//! Storage-layout regression tests.
//!
//! These pin the byte-level identity of every storage key and of the
//! `#[contracttype]` enum discriminants. A change to any assertion here means
//! a storage migration is required — not a refactor.

use crate::*;
use soroban_sdk::{symbol_short, Env, IntoVal, Symbol, Val, Vec};
use soroban_sdk::xdr::{FromXdr, ToXdr};

#[test]
fn instance_key_symbols_are_byte_stable() {
    // These are `symbol_short!` values: the literal is the exact on-chain key.
    assert_eq!(TREE_CONTRACT, symbol_short!("tree"));
    assert_eq!(REGISTRY, symbol_short!("registry"));
    assert_eq!(CIRCUIT_REGISTRY, symbol_short!("circ_reg"));
    assert_eq!(CIRCUIT_REGISTRY_ADMIN, symbol_short!("cr_admin"));
    assert_eq!(TRANSCRIPT_REGISTRY, symbol_short!("tr_reg"));
    assert_eq!(VERSION_KEY, symbol_short!("ver"));
    assert_eq!(STORAGE_VERSION_KEY, symbol_short!("stor_ver"));
}

#[test]
fn version_constants_are_stable() {
    assert_eq!(VERSION, 2);
    assert_eq!(STORAGE_VERSION, 1);
    assert_eq!(MAX_UPGRADE_PAYLOAD_LEN, 4096);
}

/// Assert that a `DataKey` encodes to the exact XDR shape its variant name and
/// fields imply. This pins both the variant name (first XDR element) and the
/// argument order — i.e. the actual bytes used as the storage key.
fn assert_key_xdr(env: &Env, key: DataKey, expected: Vec<Val>) {
    let encoded = key.clone().to_xdr(env);
    assert_eq!(encoded, expected.to_xdr(env));
    let rt = DataKey::from_xdr(env, &encoded).unwrap();
    assert_eq!(rt.to_xdr(env), encoded);
}

#[test]
fn data_key_variant_names_and_layouts_are_stable() {
    let env = Env::default();

    assert_key_xdr(
        &env,
        DataKey::Proposal(1, 2),
        soroban_sdk::vec![
            &env,
            symbol_short!("Proposal").into_val(&env),
            1u64.into_val(&env),
            2u64.into_val(&env),
        ],
    );
    assert_key_xdr(
        &env,
        DataKey::VotingKey(7),
        soroban_sdk::vec![
            &env,
            symbol_short!("VotingKey").into_val(&env),
            7u64.into_val(&env),
        ],
    );
    assert_key_xdr(
        &env,
        DataKey::Nullifier(1, 2, U256::from_u32(&env, 3)),
        soroban_sdk::vec![
            &env,
            symbol_short!("Nullifier").into_val(&env),
            1u64.into_val(&env),
            2u64.into_val(&env),
            U256::from_u32(&env, 3).into_val(&env),
        ],
    );
    assert_key_xdr(
        &env,
        DataKey::Guardian,
        soroban_sdk::vec![&env, symbol_short!("Guardian").into_val(&env)],
    );
    assert_key_xdr(
        &env,
        DataKey::TallyVk(9),
        soroban_sdk::vec![
            &env,
            symbol_short!("TallyVk").into_val(&env),
            9u64.into_val(&env),
        ],
    );
    assert_key_xdr(
        &env,
        DataKey::UpgradeMigration(3),
        soroban_sdk::vec![
            &env,
            Symbol::new(&env, "UpgradeMigration").into_val(&env),
            3u32.into_val(&env),
        ],
    );
    assert_key_xdr(
        &env,
        DataKey::ReentrancyLock,
        soroban_sdk::vec![&env, Symbol::new(&env, "ReentrancyLock").into_val(&env)],
    );
}
