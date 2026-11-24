#![allow(unused_imports)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    Address, BytesN, Env, String, Vec,
};

fn setup_env() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let governance = Address::generate(&env);
    let registry = env.register(CircuitRegistry, (governance.clone(),));
    (env, registry, governance)
}

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
            ],
        ),
    }
}

#[test]
fn test_register_circuit() {
    let (env, registry, _governance) = setup_env();
    let client = CircuitRegistryClient::new(&env, &registry);
    let vk = create_test_vk(&env);
    let circuit_id = String::from_str(&env, "vote_v1");
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);

    client.register_circuit(&circuit_id, &CircuitType::Vote, &vk, &wasm_hash, &0, &5, &Some(BytesN::from_array(&env, &[1u8; 32])));

    let circuit = client.get_circuit(&circuit_id, &CircuitType::Vote);
    assert_eq!(circuit.circuit_id, circuit_id);
    assert_eq!(circuit.circuit_type, CircuitType::Vote);
    assert_eq!(circuit.num_public_signals, 5);
}

#[test]
fn test_get_vk() {
    let (env, registry, _governance) = setup_env();
    let client = CircuitRegistryClient::new(&env, &registry);
    let vk = create_test_vk(&env);
    let circuit_id = String::from_str(&env, "vote_v1");
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);

    client.register_circuit(&circuit_id, &CircuitType::Vote, &vk, &wasm_hash, &0, &5, &Some(BytesN::from_array(&env, &[1u8; 32])));

    let vk_map = client.get_vk(&circuit_id, &CircuitType::Vote);
    assert_eq!(vk_map.num_public_signals, 5);
}

#[test]
fn test_dao_migration() {
    let (env, registry, _governance) = setup_env();
    let client = CircuitRegistryClient::new(&env, &registry);
    let vk = create_test_vk(&env);
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);

    let v1_id = String::from_str(&env, "vote_v1");
    let v2_id = String::from_str(&env, "vote_v2");

    client.register_circuit(&v1_id, &CircuitType::Vote, &vk, &wasm_hash, &0, &5, &Some(BytesN::from_array(&env, &[1u8; 32])));
    client.register_circuit(&v2_id, &CircuitType::Vote, &vk, &wasm_hash, &0, &6, &Some(BytesN::from_array(&env, &[1u8; 32])));

    let now = env.ledger().timestamp();
    let deadline = now + 86400;

    client.migrate_dao(&1, &v1_id, &v2_id, &CircuitType::Vote, &deadline);

    let migration = client.get_migration(&1);
    assert_eq!(migration.dao_id, 1);
    assert_eq!(migration.from_circuit_id, v1_id);
    assert_eq!(migration.to_circuit_id, v2_id);
    assert!(migration.active);
}

#[test]
fn test_overlap_window() {
    let (env, registry, _governance) = setup_env();
    let client = CircuitRegistryClient::new(&env, &registry);
    let vk = create_test_vk(&env);
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);

    let v1_id = String::from_str(&env, "vote_v1");
    let v2_id = String::from_str(&env, "vote_v2");

    client.register_circuit(&v1_id, &CircuitType::Vote, &vk, &wasm_hash, &0, &5, &Some(BytesN::from_array(&env, &[1u8; 32])));
    client.register_circuit(&v2_id, &CircuitType::Vote, &vk, &wasm_hash, &0, &6, &Some(BytesN::from_array(&env, &[1u8; 32])));

    let now = env.ledger().timestamp();
    let deadline = now + 86400;

    client.migrate_dao(&1, &v1_id, &v2_id, &CircuitType::Vote, &deadline);

    assert!(client.is_in_overlap_window(&1));

    env.ledger().with_mut(|l| l.timestamp = deadline + 1);
    assert!(!client.is_in_overlap_window(&1));
}

#[test]
fn test_finalize_migration() {
    let (env, registry, _governance) = setup_env();
    let client = CircuitRegistryClient::new(&env, &registry);
    let vk = create_test_vk(&env);
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);

    let v1_id = String::from_str(&env, "vote_v1");
    let v2_id = String::from_str(&env, "vote_v2");

    client.register_circuit(&v1_id, &CircuitType::Vote, &vk, &wasm_hash, &0, &5, &Some(BytesN::from_array(&env, &[1u8; 32])));
    client.register_circuit(&v2_id, &CircuitType::Vote, &vk, &wasm_hash, &0, &6, &Some(BytesN::from_array(&env, &[1u8; 32])));

    let now = env.ledger().timestamp();
    let deadline = now + 86400;

    client.migrate_dao(&1, &v1_id, &v2_id, &CircuitType::Vote, &deadline);

    env.ledger().with_mut(|l| l.timestamp = deadline + 1);
    client.finalize_migration(&1, &CircuitType::Vote);

    let current = client.get_dao_current_circuit(&1, &CircuitType::Vote);
    assert_eq!(current, v2_id);
}

#[test]
fn test_dao_current_circuit() {
    let (env, registry, _governance) = setup_env();
    let client = CircuitRegistryClient::new(&env, &registry);
    let vk = create_test_vk(&env);
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);

    let circuit_id = String::from_str(&env, "vote_v1");
    client.register_circuit(&circuit_id, &CircuitType::Vote, &vk, &wasm_hash, &0, &5, &Some(BytesN::from_array(&env, &[1u8; 32])));
    client.set_dao_current_circuit(&1, &CircuitType::Vote, &circuit_id);

    let current = client.get_dao_current_circuit(&1, &CircuitType::Vote);
    assert_eq!(current, circuit_id);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_cannot_register_duplicate_circuit() {
    let (env, registry, _governance) = setup_env();
    let client = CircuitRegistryClient::new(&env, &registry);
    let vk = create_test_vk(&env);
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);
    let circuit_id = String::from_str(&env, "vote_v1");

    client.register_circuit(&circuit_id, &CircuitType::Vote, &vk, &wasm_hash, &0, &5, &Some(BytesN::from_array(&env, &[1u8; 32])));
    client.register_circuit(&circuit_id, &CircuitType::Vote, &vk, &wasm_hash, &0, &5, &Some(BytesN::from_array(&env, &[1u8; 32])));
}

#[test]
#[should_panic(expected = "HostError")]
fn test_cannot_get_expired_circuit() {
    let (env, registry, _governance) = setup_env();
    let client = CircuitRegistryClient::new(&env, &registry);
    let vk = create_test_vk(&env);
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);

    let now = env.ledger().timestamp();
    let circuit_id = String::from_str(&env, "vote_v1");
    client.register_circuit(
        &circuit_id,
        &CircuitType::Vote,
        &vk,
        &wasm_hash,
        &(now + 100),
        &5,
        &Some(BytesN::from_array(&env, &[1u8; 32])),
    );

    env.ledger().with_mut(|l| l.timestamp = now + 200);
    client.get_vk(&circuit_id, &CircuitType::Vote);
}

#[test]
fn test_ceremony_transcript_hash_binding() {
    let (env, registry, _governance) = setup_env();
    let client = CircuitRegistryClient::new(&env, &registry);
    let vk = create_test_vk(&env);
    let circuit_id = String::from_str(&env, "vote_v2");
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);
    let ceremony_hash = BytesN::from_array(&env, &[7u8; 32]);

    client.register_circuit(&circuit_id, &CircuitType::Vote, &vk, &wasm_hash, &0, &5, &Some(BytesN::from_array(&env, &[1u8; 32])));
    // The hash supplied at registration is persisted and returned on read.
    assert_eq!(
        client.get_circuit(&circuit_id, &CircuitType::Vote).ceremony_transcript_hash,
        Some(BytesN::from_array(&env, &[1u8; 32]))
    );

    let events_before = env.events().all().events().len();
    client.set_ceremony_transcript_hash(&circuit_id, &CircuitType::Vote, &ceremony_hash);
    assert_eq!(env.events().all().events().len(), events_before + 1);
    assert_eq!(
        client.get_circuit(&circuit_id, &CircuitType::Vote).ceremony_transcript_hash,
        Some(ceremony_hash.clone())
    );

    // A zero hash clears the binding (e.g. when revoking a bad ceremony).
    client.set_ceremony_transcript_hash(
        &circuit_id,
        &CircuitType::Vote,
        &BytesN::from_array(&env, &[0u8; 32]),
    );
    assert_eq!(
        client.get_circuit(&circuit_id, &CircuitType::Vote).ceremony_transcript_hash,
        None
    );
}

#[test]
fn test_legacy_circuit_record_still_decodes() {
    let (env, registry, _governance) = setup_env();
    let client = CircuitRegistryClient::new(&env, &registry);
    let vk = create_test_vk(&env);
    let circuit_id = String::from_str(&env, "vote_v1");
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);
    client.register_circuit(&circuit_id, &CircuitType::Vote, &vk, &wasm_hash, &0, &5, &Some(BytesN::from_array(&env, &[1u8; 32])));

    // Simulate a record written by the pre-ZV-033 registry (7 fields).
    env.as_contract(&registry, || {
        let key = DataKey::Circuit(circuit_id.clone(), CircuitType::Vote);
        let legacy = StoredCircuitInfo {
            circuit_id: circuit_id.clone(),
            circuit_type: CircuitType::Vote,
            vk,
            wasm_hash,
            registered_at: 0,
            expiration: 0,
            num_public_signals: 5,
        };
        env.storage().persistent().set(&key, &legacy);
        // A real pre-ZV-033 record has no separate ceremony-hash entry either.
        let ceremony_key =
            DataKey::CeremonyTranscriptHash(circuit_id.clone(), CircuitType::Vote);
        env.storage().persistent().remove(&ceremony_key);
    });

    let circuit = client.get_circuit(&circuit_id, &CircuitType::Vote);
    assert_eq!(circuit.num_public_signals, 5);
    assert_eq!(circuit.ceremony_transcript_hash, None);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_ceremony_transcript_hash_setter_is_governance_only() {
    let env = Env::default();
    let governance = Address::generate(&env);
    let registry = env.register(CircuitRegistry, (governance.clone(),));
    let client = CircuitRegistryClient::new(&env, &registry);
    let vk = create_test_vk(&env);
    let circuit_id = String::from_str(&env, "vote_v1");
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);

    // Seed a circuit directly: mock_all_auths is deliberately not enabled, so
    // even registration would fail governance auth. The setter must require it.
    env.as_contract(&registry, || {
        let key = DataKey::Circuit(circuit_id.clone(), CircuitType::Vote);
        let stored = StoredCircuitInfo {
            circuit_id: circuit_id.clone(),
            circuit_type: CircuitType::Vote,
            vk,
            wasm_hash,
            registered_at: 0,
            expiration: 0,
            num_public_signals: 5,
        };
        env.storage().persistent().set(&key, &stored);
    });
    client.set_ceremony_transcript_hash(
        &circuit_id,
        &CircuitType::Vote,
        &BytesN::from_array(&env, &[1u8; 32]),
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_cannot_migrate_nonexistent_circuit() {
    let (env, registry, _governance) = setup_env();
    let client = CircuitRegistryClient::new(&env, &registry);
    let now = env.ledger().timestamp();

    client.migrate_dao(
        &1,
        &String::from_str(&env, "nonexistent"),
        &String::from_str(&env, "vote_v2"),
        &CircuitType::Vote,
        &(now + 86400),
    );
}
