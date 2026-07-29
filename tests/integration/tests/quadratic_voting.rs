// ZK Quadratic Voting integration tests (issue #50)
//
// Exercises the full quadratic-voting lifecycle across the real DAO registry,
// membership SBT, membership tree and voting contracts:
//
//   1. A quadratic proposal ("round") is created and snapshots the tree root.
//   2. Five members each cast a quadratic ballot allocating voice credits across
//      three proposals in a single proof. Individual allocations stay private
//      on-chain (only the quadratic cost + a commitment are stored).
//   3. The per-proposal tally is aggregated OFF-CHAIN and committed ON-CHAIN via
//      `record_qv_tally`, guarded by a Groth16 tally proof.
//   4. Fuzz/guard tests confirm overspending and double-voting are rejected.
//
// Proof verification uses the voting crate's `testutils` bypass (the whole test
// suite relies on it): a Groth16 verification succeeds when the public-signal
// count matches the VK's IC length, so ballots use dummy proofs with correctly
// shaped VKs. The circuit-level cryptographic guarantees (range/budget) are
// covered by the Circom tests in `circuits/quadratic.test.js`.

use soroban_sdk::{
    testutils::Address as _, Address, BytesN, Env, String, Symbol, Vec as SdkVec, U256,
};

use dao_registry::DaoRegistryClient;
use membership_sbt::MembershipSbtClient;
use membership_tree::MembershipTreeClient;
use voting::{Proof, VerificationKey, VotingClient};

struct Sys {
    env: Env,
    registry: Address,
    sbt: Address,
    tree: Address,
    voting: Address,
}

impl Sys {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        let registry = env.register(dao_registry::DaoRegistry, ());
        let sbt = env.register(membership_sbt::MembershipSbt, (registry.clone(),));
        let tree = env.register(
            membership_tree::MembershipTree,
            (sbt.clone(), registry.clone()),
        );
        let guardian = Address::generate(&env);
        let voting = env.register(voting::Voting, (tree.clone(), registry.clone(), guardian));
        Sys {
            env,
            registry,
            sbt,
            tree,
            voting,
        }
    }
    fn registry_client(&self) -> DaoRegistryClient<'_> {
        DaoRegistryClient::new(&self.env, &self.registry)
    }
    fn sbt_client(&self) -> MembershipSbtClient<'_> {
        MembershipSbtClient::new(&self.env, &self.sbt)
    }
    fn tree_client(&self) -> MembershipTreeClient<'_> {
        MembershipTreeClient::new(&self.env, &self.tree)
    }
    fn voting_client(&self) -> VotingClient<'_> {
        VotingClient::new(&self.env, &self.voting)
    }
}

fn g1(env: &Env) -> BytesN<64> {
    let mut bytes = [0u8; 64];
    bytes[31] = 1; // x = 1
    bytes[63] = 2; // y = 2
    BytesN::from_array(env, &bytes)
}

fn g2(env: &Env) -> BytesN<128> {
    let bytes: [u8; 128] = [
        0x18, 0x00, 0x50, 0x6a, 0x06, 0x12, 0x86, 0xeb, 0x6a, 0x84, 0xa5, 0x73, 0x0b, 0x8f, 0x10,
        0x29, 0x3e, 0x29, 0x81, 0x6c, 0xd1, 0x91, 0x3d, 0x53, 0x38, 0xf7, 0x15, 0xde, 0x3e, 0x98,
        0xf9, 0xad, 0x19, 0x83, 0x90, 0x42, 0x11, 0xa5, 0x3f, 0x6e, 0x0b, 0x08, 0x53, 0xa9, 0x0a,
        0x00, 0xef, 0xbf, 0xf1, 0x70, 0x0c, 0x7b, 0x1d, 0xc0, 0x06, 0x32, 0x4d, 0x85, 0x9d, 0x75,
        0xe3, 0xca, 0xa5, 0xa2, 0x12, 0xc8, 0x5e, 0xa5, 0xdb, 0x8c, 0x6d, 0xeb, 0x4a, 0xab, 0x71,
        0x8e, 0x80, 0x6a, 0x51, 0xa5, 0x66, 0x08, 0x21, 0x4c, 0x3f, 0x62, 0x8b, 0x96, 0x2c, 0xf1,
        0x91, 0xea, 0xcd, 0xc8, 0x0e, 0x7a, 0x09, 0x0d, 0x97, 0xc0, 0x9c, 0xe1, 0x48, 0x60, 0x63,
        0xb3, 0x59, 0xf3, 0xdd, 0x89, 0xb7, 0xc4, 0x3c, 0x5f, 0x18, 0x95, 0x8f, 0xb3, 0xe6, 0xb9,
        0x6d, 0xb5, 0x5e, 0x19, 0xa3, 0xb7, 0xc0, 0xfb,
    ];
    BytesN::from_array(env, &bytes)
}

// VK with `ic_len` IC points (ic_len = num_public_signals + 1).
fn vk_with_ic(env: &Env, ic_len: u32) -> VerificationKey {
    let mut ic = SdkVec::new(env);
    for _ in 0..ic_len {
        ic.push_back(g1(env));
    }
    VerificationKey {
        alpha: g1(env),
        beta: g2(env),
        gamma: g2(env),
        delta: g2(env),
        ic,
    }
}

fn dummy_proof(env: &Env) -> Proof {
    Proof {
        a: g1(env),
        b: g2(env),
        c: g1(env),
    }
}

// Create a DAO, init the tree, mint an SBT + register a commitment for `creator`,
// and set the QV verification key. Returns (dao_id, admin, creator).
fn bootstrap_qv_dao(sys: &Sys) -> (u64, Address, Address) {
    let admin = Address::generate(&sys.env);
    let creator = Address::generate(&sys.env);

    let dao_id = sys.registry_client().create_dao(
        &String::from_str(&sys.env, "QV DAO"),
        &admin,
        &false,
        &true,
        &None,
    );
    sys.tree_client()
        .init_tree(&dao_id, &10, &Symbol::new(&sys.env, "BN254"), &admin);
    sys.sbt_client().mint(&dao_id, &creator, &admin, &None);
    sys.tree_client()
        .register_with_caller(&dao_id, &U256::from_u32(&sys.env, 987654), &creator);

    // QV circuit has 6 public signals -> IC length 7.
    sys.voting_client()
        .set_qv_vk(&dao_id, &vk_with_ic(&sys.env, 7), &admin);

    (dao_id, admin, creator)
}

#[test]
fn test_quadratic_full_round_offchain_tally_verified_onchain() {
    let sys = Sys::new();
    let (dao_id, admin, creator) = bootstrap_qv_dao(&sys);
    let voting = sys.voting_client();

    let now = sys.env.ledger().timestamp();
    let round_id = voting.create_qv_proposal(
        &dao_id,
        &String::from_str(&sys.env, "Budget round"),
        &String::from_str(&sys.env, ""),
        &(now + 86400),
        &creator,
    );
    let eligible_root = voting.get_proposal(&dao_id, &round_id).eligible_root;

    // Three proposals in this round.
    let proposal_ids: [u64; 3] = [100, 200, 300];

    // Five voters' (private) allocations of voice credits. Quadratic cost per
    // ballot is sum of squares, all within the budget of 100.
    let allocations: [[u64; 3]; 5] = [
        [3, 1, 0], // cost 10
        [2, 2, 1], // cost 9
        [0, 3, 1], // cost 10
        [1, 0, 3], // cost 10
        [2, 1, 2], // cost 9
    ];

    // Off-chain tally accumulator (sum of voice credits per proposal).
    let mut offchain_tally = [0u64; 3];
    let mut expected_credits_total: u128 = 0;

    for (i, alloc) in allocations.iter().enumerate() {
        let cost: u64 = alloc.iter().map(|c| c * c).sum();
        expected_credits_total += cost as u128;
        for j in 0..3 {
            offchain_tally[j] += alloc[j];
        }

        let nullifier = U256::from_u32(&sys.env, 1000 + i as u32);
        let allocations_hash = U256::from_u32(&sys.env, 5000 + i as u32);
        voting.cast_qv_vote(
            &dao_id,
            &round_id,
            &nullifier,
            &eligible_root,
            &cost,
            &allocations_hash,
            &dummy_proof(&sys.env),
        );
    }

    // All five ballots recorded; credits accumulated.
    assert_eq!(voting.qv_ballot_count(&dao_id, &round_id), 5);
    assert_eq!(
        voting.qv_credits_total(&dao_id, &round_id),
        expected_credits_total
    );
    assert_eq!(expected_credits_total, 48);

    // Expected per-proposal tallies: p100=8, p200=7, p300=7.
    assert_eq!(offchain_tally, [8, 7, 7]);

    // Commit the off-chain tally on-chain, verified by a Groth16 tally proof.
    // Public signals = [round_id, 3 proposal ids, 3 tallies] = 7 -> IC length 8.
    voting.set_qv_tally_vk(&dao_id, &vk_with_ic(&sys.env, 8), &admin);

    let mut ids = SdkVec::new(&sys.env);
    let mut tallies = SdkVec::new(&sys.env);
    for j in 0..3 {
        ids.push_back(proposal_ids[j]);
        tallies.push_back(offchain_tally[j]);
    }
    voting.record_qv_tally(&dao_id, &round_id, &ids, &tallies, &dummy_proof(&sys.env));

    assert!(voting.is_qv_tally_finalized(&dao_id, &round_id));
    assert_eq!(voting.get_qv_tally(&dao_id, &round_id, &100), 8);
    assert_eq!(voting.get_qv_tally(&dao_id, &round_id, &200), 7);
    assert_eq!(voting.get_qv_tally(&dao_id, &round_id, &300), 7);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_quadratic_overspend_ballot_rejected() {
    let sys = Sys::new();
    let (dao_id, _admin, creator) = bootstrap_qv_dao(&sys);
    let voting = sys.voting_client();

    let now = sys.env.ledger().timestamp();
    let round_id = voting.create_qv_proposal(
        &dao_id,
        &String::from_str(&sys.env, "Round"),
        &String::from_str(&sys.env, ""),
        &(now + 86400),
        &creator,
    );
    let eligible_root = voting.get_proposal(&dao_id, &round_id).eligible_root;

    // 101 credits exceeds the fixed budget of 100.
    voting.cast_qv_vote(
        &dao_id,
        &round_id,
        &U256::from_u32(&sys.env, 42),
        &eligible_root,
        &101u64,
        &U256::from_u32(&sys.env, 7),
        &dummy_proof(&sys.env),
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_quadratic_double_ballot_rejected() {
    let sys = Sys::new();
    let (dao_id, _admin, creator) = bootstrap_qv_dao(&sys);
    let voting = sys.voting_client();

    let now = sys.env.ledger().timestamp();
    let round_id = voting.create_qv_proposal(
        &dao_id,
        &String::from_str(&sys.env, "Round"),
        &String::from_str(&sys.env, ""),
        &(now + 86400),
        &creator,
    );
    let eligible_root = voting.get_proposal(&dao_id, &round_id).eligible_root;
    let nullifier = U256::from_u32(&sys.env, 42);

    voting.cast_qv_vote(
        &dao_id,
        &round_id,
        &nullifier,
        &eligible_root,
        &10u64,
        &U256::from_u32(&sys.env, 7),
        &dummy_proof(&sys.env),
    );
    // Same nullifier -> rejected.
    voting.cast_qv_vote(
        &dao_id,
        &round_id,
        &nullifier,
        &eligible_root,
        &4u64,
        &U256::from_u32(&sys.env, 8),
        &dummy_proof(&sys.env),
    );
}
