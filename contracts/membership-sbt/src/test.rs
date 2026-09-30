use super::*;
use soroban_sdk::{testutils::Address as _, testutils::Events as _, testutils::Ledger as _, Env};

// Mock registry contract for testing
mod mock_registry {
    use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol};

    #[contract]
    pub struct MockRegistry;

    #[contractimpl]
    impl MockRegistry {
        pub fn set_admin(env: Env, dao_id: u64, admin: Address) {
            let admin_key = (symbol_short!("admin"), dao_id);
            env.storage().persistent().set(&admin_key, &admin);
        }

        pub fn get_admin(env: Env, dao_id: u64) -> Address {
            let admin_key = (symbol_short!("admin"), dao_id);
            env.storage().persistent().get(&admin_key).unwrap()
        }

        pub fn set_membership_open(env: Env, dao_id: u64, is_open: bool) {
            let open_key = (Symbol::new(&env, "is_open"), dao_id);
            env.storage().persistent().set(&open_key, &is_open);
        }

        pub fn is_membership_open(env: Env, dao_id: u64) -> bool {
            let open_key = (Symbol::new(&env, "is_open"), dao_id);
            env.storage().persistent().get(&open_key).unwrap_or(false)
        }
    }
}

fn setup_env() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let registry_id = env.register(mock_registry::MockRegistry, ());
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    // Register SBT with constructor
    let sbt_id = env.register(MembershipSbt, (registry_id.clone(),));
    let _sbt_client = MembershipSbtClient::new(&env, &sbt_id);

    let admin = Address::generate(&env);
    let member = Address::generate(&env);

    // Set up mock registry with admin for DAO 1
    registry_client.set_admin(&1u64, &admin);

    (env, sbt_id, registry_id, admin, member)
}

#[test]
fn test_constructor() {
    let env = Env::default();
    env.mock_all_auths();

    let registry_id = env.register(mock_registry::MockRegistry, ());
    let sbt_id = env.register(MembershipSbt, (registry_id.clone(),));
    let client = MembershipSbtClient::new(&env, &sbt_id);

    assert_eq!(client.registry(), registry_id);
}

#[test]
fn test_mint() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    assert!(!client.has(&1u64, &member));
    client.mint(&1u64, &member, &admin, &None);
    assert!(client.has(&1u64, &member));
}

#[test]
#[should_panic(expected = "HostError")]
fn test_mint_twice_fails() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    client.mint(&1u64, &member, &admin, &None);
    client.mint(&1u64, &member, &admin, &None); // Should panic
}

#[test]
fn test_has_returns_false_for_non_member() {
    let (env, sbt_id, _, _, _) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    let non_member = Address::generate(&env);
    assert!(!client.has(&1u64, &non_member));
}

#[test]
fn test_mint_multiple_members_same_dao() {
    let (env, sbt_id, _, admin, member1) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    let member2 = Address::generate(&env);
    let member3 = Address::generate(&env);

    client.mint(&1u64, &member1, &admin, &None);
    client.mint(&1u64, &member2, &admin, &None);
    client.mint(&1u64, &member3, &admin, &None);

    assert!(client.has(&1u64, &member1));
    assert!(client.has(&1u64, &member2));
    assert!(client.has(&1u64, &member3));
}

#[test]
fn test_same_member_different_daos() {
    let (env, sbt_id, registry_id, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    // Set up admin for DAO 2
    registry_client.set_admin(&2u64, &admin);

    // Member joins both DAOs
    client.mint(&1u64, &member, &admin, &None);
    client.mint(&2u64, &member, &admin, &None);

    assert!(client.has(&1u64, &member));
    assert!(client.has(&2u64, &member));
}

#[test]
fn test_different_daos_isolated() {
    let (env, sbt_id, registry_id, admin1, member1) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    let admin2 = Address::generate(&env);
    let member2 = Address::generate(&env);

    // Set up admin for DAO 2
    registry_client.set_admin(&2u64, &admin2);

    // Mint to different DAOs
    client.mint(&1u64, &member1, &admin1, &None);
    client.mint(&2u64, &member2, &admin2, &None);

    // Members are isolated per DAO
    assert!(client.has(&1u64, &member1));
    assert!(!client.has(&1u64, &member2));
    assert!(!client.has(&2u64, &member1));
    assert!(client.has(&2u64, &member2));
}

#[test]
#[should_panic(expected = "HostError")]
fn test_wrong_admin_cannot_mint() {
    let (env, sbt_id, _, _, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    let wrong_admin = Address::generate(&env);
    client.mint(&1u64, &member, &wrong_admin, &None); // Should panic
}

#[test]
fn test_events_emitted_on_mint() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    client.mint(&1u64, &member, &admin, &None);

    let events = env.events().all().filter_by_contract(&sbt_id);
    assert!(!events.events().is_empty());
}

#[test]
#[should_panic(expected = "HostError")]
fn test_mint_to_nonexistent_dao_fails() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    // DAO 999 doesn't exist in registry
    client.mint(&999u64, &member, &admin, &None);
}

#[test]
fn test_has_on_nonexistent_dao_returns_false() {
    let (env, sbt_id, _, _, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    // DAO 999 doesn't exist, but has() should just return false
    assert!(!client.has(&999u64, &member));
}

#[test]
fn test_mint_from_registry() {
    let (env, sbt_id, _, _, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    assert!(!client.has(&1u64, &member));
    client.mint_from_registry(&1u64, &member);
    assert!(client.has(&1u64, &member));
}

#[test]
#[should_panic(expected = "HostError")]
fn test_mint_from_registry_twice_fails() {
    let (env, sbt_id, _, _, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    client.mint_from_registry(&1u64, &member);
    client.mint_from_registry(&1u64, &member); // Should panic
}

#[test]
fn test_mint_from_registry_multiple_members() {
    let (env, sbt_id, _, _, member1) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    let member2 = Address::generate(&env);
    let member3 = Address::generate(&env);

    client.mint_from_registry(&1u64, &member1);
    client.mint_from_registry(&1u64, &member2);
    client.mint_from_registry(&1u64, &member3);

    assert!(client.has(&1u64, &member1));
    assert!(client.has(&1u64, &member2));
    assert!(client.has(&1u64, &member3));
}

#[test]
fn test_events_emitted_on_mint_from_registry() {
    let (env, sbt_id, _, _, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    client.mint_from_registry(&1u64, &member);

    let events = env.events().all().filter_by_contract(&sbt_id);
    assert!(!events.events().is_empty());
}

#[test]
fn test_self_join_open_dao() {
    let (env, sbt_id, registry_id, _, _) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    // Set DAO 2 to have open membership
    registry_client.set_membership_open(&2u64, &true);

    let new_member = Address::generate(&env);

    assert!(!client.has(&2u64, &new_member));
    client.self_join(&2u64, &new_member, &None);
    assert!(client.has(&2u64, &new_member));
}

#[test]
#[should_panic(expected = "HostError")]
fn test_self_join_closed_dao_fails() {
    let (env, sbt_id, registry_id, _, _) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    // Set DAO 2 to have closed membership (default is false)
    registry_client.set_membership_open(&2u64, &false);

    let new_member = Address::generate(&env);
    client.self_join(&2u64, &new_member, &None);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_self_join_twice_fails() {
    let (env, sbt_id, registry_id, _, _) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    // Set DAO 2 to have open membership
    registry_client.set_membership_open(&2u64, &true);

    let new_member = Address::generate(&env);
    client.self_join(&2u64, &new_member, &None);
    client.self_join(&2u64, &new_member, &None); // Should panic
}

// ── Soulbound guarantee: transfer/approval attempts always reject (#357) ──

#[test]
fn test_transfer_is_rejected() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);
    client.mint(&1u64, &member, &admin, &None);

    let recipient = Address::generate(&env);
    let result = client.try_transfer(&1u64, &member, &recipient, &1i128);

    assert!(result.is_err());
    // The soulbound invariant holds: nothing moved.
    assert!(client.has(&1u64, &member));
    assert!(!client.has(&1u64, &recipient));
}

#[test]
fn test_transfer_from_is_rejected() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);
    client.mint(&1u64, &member, &admin, &None);

    let spender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let result = client.try_transfer_from(&1u64, &spender, &member, &recipient, &1i128);

    assert!(result.is_err());
    assert!(client.has(&1u64, &member));
}

#[test]
fn test_approve_is_rejected() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);
    client.mint(&1u64, &member, &admin, &None);

    let spender = Address::generate(&env);
    let result = client.try_approve(&1u64, &member, &spender, &1i128, &1000u32);

    assert!(result.is_err());
}

#[test]
#[should_panic(expected = "HostError")]
fn test_transfer_panics_even_without_an_existing_membership() {
    // The reject-trap fires before any membership lookup: an address that
    // was never minted an SBT still can't "transfer" one.
    let (env, sbt_id, _, _, _) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    let stranger = Address::generate(&env);
    let recipient = Address::generate(&env);
    client.transfer(&1u64, &stranger, &recipient, &1i128);
}

// ========================================================================
// Anti-flash-loan cooldown access control
//
// These three setters gate `leave`, so leaving them unauthenticated let an
// arbitrary caller (a) permanently lock a member out with u64::MAX, and
// (b) drop the anti-flash-loan barrier so a member could vote -> leave -> rejoin
// within a single election.
// ========================================================================

#[test]
fn test_set_election_cooldown_by_admin() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    client.set_election_cooldown(&1u64, &member, &u64::MAX, &admin);
    assert!(client.is_in_cooldown(&1u64, &member));
}

#[test]
fn test_set_election_cooldown_by_self() {
    let (env, sbt_id, _, _, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    client.set_election_cooldown(&1u64, &member, &u64::MAX, &member);
    assert!(client.is_in_cooldown(&1u64, &member));
}

#[test]
#[should_panic(expected = "HostError")]
fn test_set_election_cooldown_rejects_stranger() {
    // Regression: an attacker locking a victim out of the DAO forever.
    let (env, sbt_id, _, _, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    let attacker = Address::generate(&env);
    client.set_election_cooldown(&1u64, &member, &u64::MAX, &attacker);
}

#[test]
fn test_stranger_cannot_permanently_lock_member_out() {
    // The full exploit: attacker pins the victim's cooldown to u64::MAX, after
    // which `leave` panics CooldownActive forever. With the caller check in
    // place the cooldown is never written, so the victim can still leave.
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);
    client.mint(&1u64, &member, &admin, &None);

    let attacker = Address::generate(&env);
    let _ = client.try_set_election_cooldown(&1u64, &member, &u64::MAX, &attacker);
    assert!(!client.is_in_cooldown(&1u64, &member));

    // Victim can still exit.
    client.leave(&1u64, &member);
    assert!(!client.has(&1u64, &member));
}

#[test]
fn test_clear_election_cooldown_by_admin() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    client.set_election_cooldown(&1u64, &member, &u64::MAX, &admin);
    client.clear_election_cooldown(&1u64, &member, &admin);
    assert!(!client.is_in_cooldown(&1u64, &member));
}

#[test]
#[should_panic(expected = "HostError")]
fn test_clear_election_cooldown_rejects_stranger() {
    // Regression: the vote -> leave -> rejoin bypass. Only the member
    // themselves or the DAO admin may drop the barrier.
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    client.set_election_cooldown(&1u64, &member, &u64::MAX, &admin);

    let attacker = Address::generate(&env);
    client.clear_election_cooldown(&1u64, &member, &attacker);
}

#[test]
fn test_set_in_active_election_by_self() {
    let (env, sbt_id, _, _, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    client.set_in_active_election(&1u64, &member, &true, &member);
    assert!(client.is_in_active_election(&1u64, &member));
}

#[test]
fn test_set_in_active_election_by_admin() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    client.set_in_active_election(&1u64, &member, &true, &admin);
    assert!(client.is_in_active_election(&1u64, &member));
}

#[test]
#[should_panic(expected = "HostError")]
fn test_set_in_active_election_rejects_stranger() {
    // Regression: anyone could make an arbitrary address look like a
    // flash-loan voter.
    let (env, sbt_id, _, _, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    let attacker = Address::generate(&env);
    client.set_in_active_election(&1u64, &member, &true, &attacker);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_cooldown_setters_require_auth() {
    // Auth is not merely implied by the address argument: with no auth
    // registered, even a self-call must fail.
    let env = Env::default();
    let registry_id = env.register(mock_registry::MockRegistry, ());
    let sbt_id = env.register(MembershipSbt, (registry_id.clone(),));
    let client = MembershipSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    let member = Address::generate(&env);
    registry_client.set_admin(&1u64, &member);

    client.set_election_cooldown(&1u64, &member, &u64::MAX, &member);
}
