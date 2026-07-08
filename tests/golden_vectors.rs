use serde::Deserialize;
use soroban_sdk::Env;

#[derive(Deserialize)]
struct PoseidonVector {
    label: String,
    inputs: Vec<u64>,
    expected: String,
}

#[derive(Deserialize)]
struct MerkleVectors {
    depth: u32,
    zeros: Vec<String>,
}

#[derive(Deserialize)]
struct GoldenVectors {
    poseidon: PoseidonSection,
    merkle_zeros: MerkleVectors,
}

#[derive(Deserialize)]
struct PoseidonSection {
    inputs: Vec<PoseidonVector>,
}

fn parse_u256(env: &Env, s: &str) -> soroban_sdk::U256 {
    let val = num_bigint::BigUint::parse_bytes(s.as_bytes(), 10).expect("invalid decimal");
    let mut bytes = [0u8; 32];
    let val_bytes = val.to_bytes_be();
    let start = 32 - val_bytes.len();
    bytes[start..].copy_from_slice(&val_bytes);
    soroban_sdk::U256::from_be_bytes(env, &bytes)
}

#[test]
fn poseidon_golden_vectors_match_host() {
    let env = Env::default();
    env.mock_all_auths();

    let data = include_str!("../circuits/utils/golden_vectors.json");
    let vectors: GoldenVectors = serde_json::from_str(data).expect("golden vectors json");

    for v in vectors.poseidon.inputs {
        let mut inputs = soroban_sdk::Vec::new(&env);
        for x in v.inputs {
            inputs.push_back(soroban_sdk::U256::from_u64(&env, x));
        }
        let result = env.crypto().poseidon_hash(&inputs);
        let expected = parse_u256(&env, &v.expected);
        assert_eq!(result, expected, "poseidon vector {}", v.label);
    }
}

#[test]
fn merkle_zero_chaining_matches_vectors() {
    let env = Env::default();
    env.mock_all_auths();
    let data = include_str!("../circuits/utils/golden_vectors.json");
    let vectors: GoldenVectors = serde_json::from_str(data).expect("golden vectors json");

    let mut current = parse_u256(&env, "0");
    let mut zeros = vec![current.clone()];
    for _ in 0..vectors.merkle_zeros.depth {
        let pair = soroban_sdk::vec![&env, current.clone(), current.clone()];
        current = env.crypto().poseidon_hash(&pair);
        zeros.push(current.clone());
    }

    assert_eq!(zeros.len(), vectors.merkle_zeros.zeros.len());
    for (i, expected) in vectors.merkle_zeros.zeros.iter().enumerate() {
        let expected_u = parse_u256(&env, expected);
        assert_eq!(zeros[i], expected_u, "zero index {}", i);
    }
}
