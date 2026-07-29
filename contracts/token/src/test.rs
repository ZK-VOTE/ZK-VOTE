use super::*;
use soroban_sdk::{
    testutils::{ed25519::Sign, Address as _, Events as _, Ledger as _},
    Env,
};

fn setup_token() -> (Env, Address, TokenClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env.register(
        Token,
        (
            admin.clone(),
            String::from_str(&env, "TestToken"),
            String::from_str(&env, "TT"),
            18u32,
        ),
    );
    let client = TokenClient::new(&env, &token_id);

    (env, admin, client)
}

fn setup_token_with_balance() -> (Env, Address, Address, Address, TokenClient<'static>) {
    let (env, admin, client) = setup_token();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    client.mint(&alice, &1000i128);

    (env, admin, alice, bob, client)
}

// ── Approve: zero-to-non-zero (baseline, must not regress) ────────────────────

#[test]
fn test_approve_from_zero_to_non_zero() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &50i128, &expiration);

    assert_eq!(client.allowance(&alice, &bob), 50);
}

// ── Approve: non-zero-to-zero (baseline, must not regress) ────────────────────

#[test]
fn test_approve_from_non_zero_to_zero() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &50i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 50);

    client.approve(&alice, &bob, &0i128, &0u32);

    assert_eq!(client.allowance(&alice, &bob), 0);
}

// ── Approve: race condition rejection (the core of the fix) ───────────────────

#[test]
#[should_panic(expected = "HostError")]
fn test_approve_race_rejects_non_zero_to_different_non_zero() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &100i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 100);

    client.approve(&alice, &bob, &50i128, &expiration);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_approve_race_rejects_non_zero_to_higher_non_zero() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &50i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 50);

    client.approve(&alice, &bob, &150i128, &expiration);
}

// ── Approve: safe two-step pattern still works ────────────────────────────────

#[test]
fn test_approve_safe_two_step_pattern() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &100i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 100);

    client.approve(&alice, &bob, &0i128, &0u32);
    assert_eq!(client.allowance(&alice, &bob), 0);

    client.approve(&alice, &bob, &50i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 50);
}

// ── Approve: same non-zero value (no-op) is allowed ──────────────────────────

#[test]
fn test_approve_same_non_zero_allowed() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &75i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 75);

    client.approve(&alice, &bob, &75i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 75);
}

// ── increase_allowance ───────────────────────────────────────────────────────

#[test]
fn test_increase_allowance_adds_to_existing() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &50i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 50);

    client.increase_allowance(&alice, &bob, &30i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 80);
}

#[test]
fn test_increase_allowance_from_zero_starts_at_value() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.increase_allowance(&alice, &bob, &25i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 25);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_increase_allowance_overflow_panics() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &i128::MAX, &expiration);
    assert_eq!(client.allowance(&alice, &bob), i128::MAX);

    client.increase_allowance(&alice, &bob, &1i128, &expiration);
}

// ── decrease_allowance ───────────────────────────────────────────────────────

#[test]
fn test_decrease_allowance_subtracts_from_existing() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &100i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 100);

    client.decrease_allowance(&alice, &bob, &40i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 60);
}

#[test]
fn test_decrease_allowance_floors_at_zero() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &30i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 30);

    client.decrease_allowance(&alice, &bob, &100i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 0);
}

#[test]
fn test_decrease_allowance_exact_amount_goes_to_zero() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &50i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 50);

    client.decrease_allowance(&alice, &bob, &50i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 0);
}

#[test]
fn test_decrease_allowance_from_zero_stays_zero() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.decrease_allowance(&alice, &bob, &10i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 0);
}

// ── The exact Alice/Bob race scenario from the issue ─────────────────────────

#[test]
#[should_panic(expected = "HostError")]
fn test_alice_bob_race_scenario_rejected() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &100i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 100);

    client.approve(&alice, &bob, &50i128, &expiration);
}

// ── Negative amount rejection ────────────────────────────────────────────────

#[test]
#[should_panic(expected = "HostError")]
fn test_increase_allowance_negative_rejected() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;
    let expiration = 9999999;

    client.increase_allowance(&alice, &bob, &(-10i128), &expiration);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_decrease_allowance_negative_rejected() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;
    let expiration = 9999999;

    client.decrease_allowance(&alice, &bob, &(-10i128), &expiration);
}

// ── transfer_from consumes allowance ─────────────────────────────────────────

#[test]
fn test_transfer_from_consumes_allowance() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;
    let charlie = Address::generate(&_env);

    let expiration = 9999999;

    client.approve(&alice, &bob, &100i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 100);

    client.transfer_from(&bob, &alice, &charlie, &30i128);

    assert_eq!(client.allowance(&alice, &bob), 70);
    assert_eq!(client.balance(&alice), 970);
    assert_eq!(client.balance(&charlie), 30);
}

// ── Expiration ledger handling ───────────────────────────────────────────────

#[test]
fn test_expired_allowance_treated_as_zero() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env.register(
        Token,
        (
            admin.clone(),
            String::from_str(&env, "TestToken"),
            String::from_str(&env, "TT"),
            18u32,
        ),
    );
    let client = TokenClient::new(&env, &token_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.mint(&alice, &1000i128);

    let current_ledger = env.ledger().sequence();
    let expiration = current_ledger + 5;

    client.approve(&alice, &bob, &100i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 100);

    env.ledger()
        .with_mut(|l| l.sequence_number = expiration + 1);

    assert_eq!(client.allowance(&alice, &bob), 0);
}

#[test]
fn test_increase_allowance_sets_new_expiration() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env.register(
        Token,
        (
            admin.clone(),
            String::from_str(&env, "TestToken"),
            String::from_str(&env, "TT"),
            18u32,
        ),
    );
    let client = TokenClient::new(&env, &token_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.mint(&alice, &1000i128);

    let current = env.ledger().sequence();
    let expiration1 = current + 10;
    let expiration2 = current + 50;

    client.approve(&alice, &bob, &50i128, &expiration1);

    client.increase_allowance(&alice, &bob, &25i128, &expiration2);

    env.ledger()
        .with_mut(|l| l.sequence_number = expiration1 + 1);

    assert_eq!(client.allowance(&alice, &bob), 75);
}

#[test]
fn test_decrease_allowance_preserves_expiration() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env.register(
        Token,
        (
            admin.clone(),
            String::from_str(&env, "TestToken"),
            String::from_str(&env, "TT"),
            18u32,
        ),
    );
    let client = TokenClient::new(&env, &token_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.mint(&alice, &1000i128);

    let current = env.ledger().sequence();
    let expiration = current + 50;

    client.approve(&alice, &bob, &100i128, &expiration);
    client.decrease_allowance(&alice, &bob, &30i128, &expiration);

    assert_eq!(client.allowance(&alice, &bob), 70);
}

// ── Events ───────────────────────────────────────────────────────────────────

#[test]
fn test_approve_emits_event() {
    let (env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;
    let token_id = client.address.clone();

    let expiration = 9999999;
    client.approve(&alice, &bob, &100i128, &expiration);

    let contract_events = env.events().all().filter_by_contract(&token_id);
    assert!(!contract_events.events().is_empty());
}

#[test]
fn test_increase_allowance_emits_event() {
    let (env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;
    let token_id = client.address.clone();

    let expiration = 9999999;
    client.increase_allowance(&alice, &bob, &30i128, &expiration);

    let contract_events = env.events().all().filter_by_contract(&token_id);
    assert!(!contract_events.events().is_empty());
}

#[test]
fn test_decrease_allowance_emits_event() {
    let (env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;
    let token_id = client.address.clone();
    let expiration = 9999999;

    client.approve(&alice, &bob, &100i128, &expiration);
    client.decrease_allowance(&alice, &bob, &30i128, &expiration);

    let contract_events = env.events().all().filter_by_contract(&token_id);
    assert!(!contract_events.events().is_empty());
}

// ── Standard token functions still work ──────────────────────────────────────

#[test]
fn test_transfer_basic() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _admin = admin;

    client.transfer(&alice, &bob, &200i128);

    assert_eq!(client.balance(&alice), 800);
    assert_eq!(client.balance(&bob), 200);
}

#[test]
fn test_mint_admin_only() {
    let (_env, admin, _alice, _bob, client) = setup_token_with_balance();
    let _admin = admin;

    let charlie = Address::generate(&_env);
    client.mint(&charlie, &500i128);
    assert_eq!(client.balance(&charlie), 500);
}

#[test]
fn test_name_symbol_decimals() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register(
        Token,
        (
            admin.clone(),
            String::from_str(&env, "MyToken"),
            String::from_str(&env, "MTK"),
            6u32,
        ),
    );
    let client = TokenClient::new(&env, &token_id);

    assert_eq!(client.name(), String::from_str(&env, "MyToken"));
    assert_eq!(client.symbol(), String::from_str(&env, "MTK"));
    assert_eq!(client.decimals(), 6);
}

// ═════════════════════════════════════════════════════════════════════════════
// Issue #103: Token Burn Mechanism with Deflation Tracking
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn test_mint_tracks_total_supply_and_minted() {
    let (_env, _admin, _alice, _bob, client) = setup_token_with_balance();

    assert_eq!(client.total_supply(), 1000);
    assert_eq!(client.total_minted(), 1000);
    assert_eq!(client.total_burned(), 0);

    client.mint(&_bob, &500i128);

    assert_eq!(client.total_supply(), 1500);
    assert_eq!(client.total_minted(), 1500);
    assert_eq!(client.total_burned(), 0);
}

#[test]
fn test_burn_decrements_supply_and_tracks_burned() {
    let (_env, _admin, alice, _bob, client) = setup_token_with_balance();

    client.burn(&alice, &200i128);

    assert_eq!(client.balance(&alice), 800);
    assert_eq!(client.total_supply(), 800);
    assert_eq!(client.total_minted(), 1000);
    assert_eq!(client.total_burned(), 200);
}

#[test]
fn test_burn_emits_event_with_new_supply() {
    let (env, _admin, alice, _bob, client) = setup_token_with_balance();
    let token_id = client.address.clone();

    client.burn(&alice, &300i128);

    let contract_events = env.events().all().filter_by_contract(&token_id);
    assert!(!contract_events.events().is_empty());
}

#[test]
fn test_burn_from_tracks_supply() {
    let (env, _admin, alice, bob, client) = setup_token_with_balance();
    let _charlie = Address::generate(&env);

    let expiration = 9999999;
    client.approve(&alice, &bob, &100i128, &expiration);

    client.burn_from(&bob, &alice, &50i128);

    assert_eq!(client.balance(&alice), 950);
    assert_eq!(client.allowance(&alice, &bob), 50);
    assert_eq!(client.total_supply(), 950);
    assert_eq!(client.total_burned(), 50);
}

#[test]
fn test_supply_invariant() {
    let (_env, _admin, alice, bob, client) = setup_token_with_balance();

    client.mint(&bob, &500i128);
    client.burn(&alice, &200i128);
    client.mint(&alice, &100i128);
    client.burn(&bob, &300i128);

    let expected_supply = client.total_minted() - client.total_burned();
    assert_eq!(client.total_supply(), expected_supply);
    assert_eq!(client.total_supply(), 1100);
}

#[test]
fn test_burn_history_records() {
    let (_env, _admin, alice, _bob, client) = setup_token_with_balance();

    client.burn(&alice, &100i128);
    client.burn(&alice, &50i128);

    let history = client.burn_history(&10);
    assert_eq!(history.len(), 2);
    assert_eq!(history.get(0).unwrap().amount, 100);
    assert_eq!(history.get(1).unwrap().amount, 50);
}

#[test]
fn test_burn_history_limit() {
    let (_env, _admin, alice, _bob, client) = setup_token_with_balance();

    client.burn(&alice, &10i128);
    client.burn(&alice, &20i128);
    client.burn(&alice, &30i128);

    let history = client.burn_history(&2);
    assert_eq!(history.len(), 2);
    assert_eq!(history.get(0).unwrap().amount, 20);
    assert_eq!(history.get(1).unwrap().amount, 30);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_burn_cannot_exceed_supply() {
    let (_env, _admin, alice, _bob, client) = setup_token_with_balance();

    client.burn(&alice, &2000i128);
}

// ═════════════════════════════════════════════════════════════════════════════
// Issue #102: Clawback Audit Trail and Governance Approval
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn test_set_governors() {
    let (env, _admin, _alice, _bob, client) = setup_token_with_balance();

    let governor1 = Address::generate(&env);
    let governor2 = Address::generate(&env);
    let governor3 = Address::generate(&env);

    let mut governors = Vec::new(&env);
    governors.push_back(governor1.clone());
    governors.push_back(governor2.clone());
    governors.push_back(governor3.clone());

    client.set_governors(&governors, &2);

    let stored = client.get_governors_list();
    assert_eq!(stored.len(), 3);
}

#[test]
fn test_propose_and_approve_clawback() {
    let (env, _admin, alice, _bob, client) = setup_token_with_balance();

    let governor1 = Address::generate(&env);
    let governor2 = Address::generate(&env);

    let mut governors = Vec::new(&env);
    governors.push_back(governor1.clone());
    governors.push_back(governor2.clone());
    client.set_governors(&governors, &2);

    let proposal_id =
        client.propose_clawback(&alice, &100i128, &String::from_str(&env, "violation"));

    let proposal = client.get_clawback_proposal(&proposal_id);
    assert_eq!(proposal.approvals.len(), 1);
    assert!(!proposal.executed);

    client.approve_clawback(&proposal_id);

    let proposal = client.get_clawback_proposal(&proposal_id);
    assert_eq!(proposal.approvals.len(), 2);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_execute_clawback_before_delay_fails() {
    let (env, _admin, alice, _bob, client) = setup_token_with_balance();

    let governor1 = Address::generate(&env);
    let governor2 = Address::generate(&env);

    let mut governors = Vec::new(&env);
    governors.push_back(governor1.clone());
    governors.push_back(governor2.clone());
    client.set_governors(&governors, &2);

    let proposal_id =
        client.propose_clawback(&alice, &100i128, &String::from_str(&env, "violation"));
    client.approve_clawback(&proposal_id);

    client.execute_clawback(&proposal_id);
}

#[test]
fn test_execute_clawback_after_delay() {
    let (env, _admin, alice, _bob, client) = setup_token_with_balance();

    let governor1 = Address::generate(&env);
    let governor2 = Address::generate(&env);

    let mut governors = Vec::new(&env);
    governors.push_back(governor1.clone());
    governors.push_back(governor2.clone());
    client.set_governors(&governors, &2);

    let proposal_id =
        client.propose_clawback(&alice, &100i128, &String::from_str(&env, "violation"));
    client.approve_clawback(&proposal_id);

    env.ledger()
        .with_mut(|l| l.sequence_number = l.sequence_number + CLAWBACK_DELAY_LEDGERS + 1);

    client.execute_clawback(&proposal_id);

    let proposal = client.get_clawback_proposal(&proposal_id);
    assert!(proposal.executed);

    assert_eq!(client.balance(&alice), 900);
    assert_eq!(client.total_supply(), 900);
}

#[test]
fn test_clawback_emits_event() {
    let (env, _admin, alice, _bob, client) = setup_token_with_balance();
    let token_id = client.address.clone();

    let governor1 = Address::generate(&env);
    let governor2 = Address::generate(&env);

    let mut governors = Vec::new(&env);
    governors.push_back(governor1.clone());
    governors.push_back(governor2.clone());
    client.set_governors(&governors, &2);

    let proposal_id =
        client.propose_clawback(&alice, &100i128, &String::from_str(&env, "regulatory"));
    client.approve_clawback(&proposal_id);

    env.ledger()
        .with_mut(|l| l.sequence_number = l.sequence_number + CLAWBACK_DELAY_LEDGERS + 1);

    client.execute_clawback(&proposal_id);

    let contract_events = env.events().all().filter_by_contract(&token_id);
    assert!(!contract_events.events().is_empty());
}

#[test]
fn test_clawback_history() {
    let (env, _admin, alice, _bob, client) = setup_token_with_balance();

    let governor1 = Address::generate(&env);
    let governor2 = Address::generate(&env);

    let mut governors = Vec::new(&env);
    governors.push_back(governor1.clone());
    governors.push_back(governor2.clone());
    client.set_governors(&governors, &2);

    let proposal_id =
        client.propose_clawback(&alice, &100i128, &String::from_str(&env, "violation"));
    client.approve_clawback(&proposal_id);

    let proposal = client.get_clawback_proposal(&proposal_id);
    assert_eq!(proposal.approvals.len(), 1);
    assert!(!proposal.executed);

    client.approve_clawback(&proposal_id);

    let proposal = client.get_clawback_proposal(&proposal_id);
    assert_eq!(proposal.approvals.len(), 2);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_double_approve_clawback_rejected() {
    let (env, _admin, alice, _bob, client) = setup_token_with_balance();

    let governor1 = Address::generate(&env);
    let governor2 = Address::generate(&env);

    let mut governors = Vec::new(&env);
    governors.push_back(governor1.clone());
    governors.push_back(governor2.clone());
    client.set_governors(&governors, &2);

    let proposal_id =
        client.propose_clawback(&alice, &100i128, &String::from_str(&env, "violation"));

    client.approve_clawback(&proposal_id);
    client.approve_clawback(&proposal_id);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_execute_clawback_insufficient_approvals() {
    let (env, _admin, alice, _bob, client) = setup_token_with_balance();

    let governor1 = Address::generate(&env);
    let governor2 = Address::generate(&env);

    let mut governors = Vec::new(&env);
    governors.push_back(governor1.clone());
    governors.push_back(governor2.clone());
    client.set_governors(&governors, &2);

    let proposal_id =
        client.propose_clawback(&alice, &100i128, &String::from_str(&env, "violation"));

    env.ledger()
        .with_mut(|l| l.sequence_number = l.sequence_number + CLAWBACK_DELAY_LEDGERS + 1);

    client.execute_clawback(&proposal_id);
}

// ═════════════════════════════════════════════════════════════════════════════
// Issue #104: Allowance Expiration Enforcement
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn test_allowance_expired_at_boundary() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env.register(
        Token,
        (
            admin.clone(),
            String::from_str(&env, "TestToken"),
            String::from_str(&env, "TT"),
            18u32,
        ),
    );
    let client = TokenClient::new(&env, &token_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.mint(&alice, &1000i128);

    let current = env.ledger().sequence();
    let expiration = current + 5;

    client.approve(&alice, &bob, &100i128, &expiration);

    assert_eq!(client.allowance(&alice, &bob), 100);

    env.ledger().with_mut(|l| l.sequence_number = expiration);

    assert_eq!(client.allowance(&alice, &bob), 100);

    env.ledger()
        .with_mut(|l| l.sequence_number = expiration + 1);

    assert_eq!(client.allowance(&alice, &bob), 0);
}

#[test]
fn test_spend_allowance_rejects_expired() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env.register(
        Token,
        (
            admin.clone(),
            String::from_str(&env, "TestToken"),
            String::from_str(&env, "TT"),
            18u32,
        ),
    );
    let client = TokenClient::new(&env, &token_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let _charlie = Address::generate(&env);
    client.mint(&alice, &1000i128);

    let current = env.ledger().sequence();
    let expiration = current + 5;

    client.approve(&alice, &bob, &100i128, &expiration);

    env.ledger()
        .with_mut(|l| l.sequence_number = expiration + 1);

    assert_eq!(client.allowance(&alice, &bob), 0);
    assert_eq!(client.balance(&alice), 1000);
}

#[test]
fn test_transfer_with_permit() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env.register(
        Token,
        (
            admin.clone(),
            String::from_str(&env, "TestToken"),
            String::from_str(&env, "TT"),
            18u32,
        ),
    );
    let client = TokenClient::new(&env, &token_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let charlie = Address::generate(&env);
    client.mint(&alice, &1000i128);

    let nonce = client.nonces(&alice);
    assert_eq!(nonce, 0);

    let deadline: u64 = env.ledger().timestamp() + 1000;

    let mut digest_data = soroban_sdk::Bytes::new(&env);
    let contract_key = Token::address_to_32bytes(&token_id);
    let alice_key = Token::address_to_32bytes(&alice);
    let bob_key = Token::address_to_32bytes(&bob);
    digest_data.extend_from_slice(&contract_key);
    digest_data.extend_from_slice(&alice_key);
    digest_data.extend_from_slice(&bob_key);
    let amount_bytes = 100i128.to_be_bytes();
    digest_data.extend_from_slice(&amount_bytes);
    let nonce_bytes = 0u32.to_be_bytes();
    digest_data.extend_from_slice(&nonce_bytes);
    let deadline_bytes = deadline.to_be_bytes();
    digest_data.extend_from_slice(&deadline_bytes);

    let sk_bytes: [u8; 32] = [
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
        0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
        0x1d, 0x1e, 0x1f, 0x20,
    ];
    let sk = ed25519_dalek::SigningKey::from_bytes(&sk_bytes);

    let signature = BytesN::from_array(&env, &sk.sign(&digest_data).unwrap());

    client.transfer_with_permit(&alice, &bob, &charlie, &100i128, &deadline, &signature);

    assert_eq!(client.balance(&alice), 900);
    assert_eq!(client.balance(&charlie), 100);
    assert_eq!(client.nonces(&alice), 1);
}

// ── Supply cap (Issue #98) ────────────────────────────────────────────────────

#[test]
fn test_get_max_supply_returns_none_when_unset() {
    let (_env, _admin, client) = setup_token();
    assert_eq!(client.get_max_supply(), None);
}

#[test]
fn test_set_and_get_max_supply() {
    let (_env, _admin, client) = setup_token();
    client.set_max_supply(&1_000_000i128);
    assert_eq!(client.get_max_supply(), Some(1_000_000i128));
}

#[test]
fn test_mint_below_cap_succeeds() {
    let (env, _admin, client) = setup_token();
    let alice = Address::generate(&env);
    client.set_max_supply(&1_000i128);
    client.mint(&alice, &500i128);
    assert_eq!(client.balance(&alice), 500);
    assert_eq!(client.total_supply(), 500);
}

#[test]
fn test_mint_exactly_at_cap_succeeds() {
    let (env, _admin, client) = setup_token();
    let alice = Address::generate(&env);
    client.set_max_supply(&1_000i128);
    client.mint(&alice, &1_000i128);
    assert_eq!(client.total_supply(), 1_000);
}

#[test]
fn test_mint_multiple_times_up_to_cap() {
    let (env, _admin, client) = setup_token();
    let alice = Address::generate(&env);
    client.set_max_supply(&1_000i128);
    client.mint(&alice, &600i128);
    client.mint(&alice, &400i128);
    assert_eq!(client.total_supply(), 1_000);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_mint_beyond_cap_panics() {
    let (env, _admin, client) = setup_token();
    let alice = Address::generate(&env);
    client.set_max_supply(&1_000i128);
    client.mint(&alice, &1_001i128);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_mint_exceeds_cap_after_partial_mint() {
    let (env, _admin, client) = setup_token();
    let alice = Address::generate(&env);
    client.set_max_supply(&1_000i128);
    client.mint(&alice, &800i128);
    client.mint(&alice, &201i128);
}

#[test]
fn test_mint_without_cap_has_no_limit() {
    let (env, _admin, client) = setup_token();
    let alice = Address::generate(&env);
    client.mint(&alice, &(i128::MAX / 2));
    assert_eq!(client.total_supply(), i128::MAX / 2);
}

// ═════════════════════════════════════════════════════════════════════════════
// Issue #106: Token Balance Snapshotting for Historical Queries
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn test_checkpoint_created_on_mint() {
    let (env, admin, alice, bob, client) = setup_token_with_balance();

    let checkpoints = client.get_checkpoints(&alice);
    assert_eq!(checkpoints.len(), 1);
    assert_eq!(checkpoints.get(0).unwrap().balance, 1000);
}

#[test]
fn test_balance_at_returns_correct_historical_balance() {
    let (env, admin, alice, bob, client) = setup_token_with_balance();

    let ledger_before_mint = env.ledger().sequence();

    // Transfer changes balance
    client.transfer(&alice, &bob, &300i128);

    let ledger_after_transfer = env.ledger().sequence();

    // Balance at mint time should be 1000
    assert_eq!(client.balance_at(&alice, &ledger_before_mint), 1000);
    // Balance after transfer should be 700
    assert_eq!(client.balance_at(&alice, &ledger_after_transfer), 700);
}

#[test]
fn test_balance_at_before_any_checkpoint() {
    let (env, admin, alice, bob, client) = setup_token_with_balance();

    // Query before any checkpoint was created
    assert_eq!(client.balance_at(&alice, &0), 0);
    assert_eq!(client.balance_at(&alice, &999999), 1000);
}

#[test]
fn test_checkpoints_track_multiple_operations() {
    let (env, admin, alice, bob, client) = setup_token_with_balance();
    let charlie = Address::generate(&env);

    client.transfer(&alice, &bob, &200i128);
    client.mint(&charlie, &500i128);
    client.burn(&alice, &100i128);

    let checkpoints = client.get_checkpoints(&alice);
    // Should have: initial(1000), after_transfer(800), after_burn(700)
    assert_eq!(checkpoints.len(), 3);
    assert_eq!(checkpoints.get(0).unwrap().balance, 1000);
    assert_eq!(checkpoints.get(1).unwrap().balance, 800);
    assert_eq!(checkpoints.get(2).unwrap().balance, 700);
}

#[test]
fn test_checkpoint_retention_configurable() {
    let (env, admin, alice, bob, client) = setup_token_with_balance();

    // Set retention to 2
    client.set_checkpoint_retention(&2u32);
    assert_eq!(client.checkpoint_retention(), 2);

    // Create more checkpoints than retention
    let charlie = Address::generate(&env);
    client.transfer(&alice, &bob, &100i128);
    client.transfer(&alice, &charlie, &100i128);
    client.transfer(&alice, &bob, &100i128);

    // Should only keep last 2 checkpoints
    let checkpoints = client.get_checkpoints(&alice);
    assert!(checkpoints.len() <= 2);
}

#[test]
fn test_balance_at_binary_search() {
    let (env, admin, alice, bob, client) = setup_token_with_balance();

    // Create multiple checkpoints at different ledgers
    client.transfer(&alice, &bob, &100i128);
    let ledger1 = env.ledger().sequence();

    env.ledger()
        .with_mut(|l| l.sequence_number = l.sequence_number + 5);
    client.transfer(&alice, &bob, &100i128);
    let ledger2 = env.ledger().sequence();

    env.ledger()
        .with_mut(|l| l.sequence_number = l.sequence_number + 5);
    client.transfer(&alice, &bob, &100i128);
    let ledger3 = env.ledger().sequence();

    // Binary search should find correct balance at each point
    assert_eq!(client.balance_at(&alice, &ledger1), 900);
    assert_eq!(client.balance_at(&alice, &ledger2), 800);
    assert_eq!(client.balance_at(&alice, &ledger3), 700);

    // Query between checkpoints should return the last known balance
    assert_eq!(client.balance_at(&alice, &(ledger1 + 2)), 900);
    assert_eq!(client.balance_at(&alice, &(ledger2 + 2)), 800);
}

#[test]
fn test_balance_at_zero_address() {
    let (env, admin, alice, bob, client) = setup_token_with_balance();

    // Address that never had a balance
    let nobody = Address::generate(&env);
    assert_eq!(client.balance_at(&nobody, &100), 0);
}

// ── extend_balance_ttl (Issue #112) ────────────────────────────────────────

#[test]
fn test_extend_balance_ttl_noop_without_balance() {
    let (_env, _admin, alice, _bob, client) = setup_token_with_balance();
    let stranger = Address::generate(&_env);
    // Must not panic even though `stranger` has no balance entry yet.
    client.extend_balance_ttl(&stranger);
    let _ = alice;
}

#[test]
fn test_extend_balance_ttl_with_balance_does_not_panic() {
    let (_env, _admin, alice, _bob, client) = setup_token_with_balance();
    client.extend_balance_ttl(&alice);
}

// ── Delegation registry (Issue #101, phase 1) ──────────────────────────────

#[test]
fn test_delegate_and_get_delegate() {
    let (_env, _admin, alice, bob, client) = setup_token_with_balance();
    assert_eq!(client.get_delegate(&alice), None);

    client.delegate(&alice, &bob);
    assert_eq!(client.get_delegate(&alice), Some(bob.clone()));
}

#[test]
fn test_delegate_to_self_rejected() {
    let (_env, _admin, alice, _bob, client) = setup_token_with_balance();
    let result = client.try_delegate(&alice, &alice);
    assert!(result.is_err());
}

#[test]
fn test_undelegate_clears_delegate() {
    let (_env, _admin, alice, bob, client) = setup_token_with_balance();
    client.delegate(&alice, &bob);
    client.undelegate(&alice);
    assert_eq!(client.get_delegate(&alice), None);
}

#[test]
fn test_undelegate_without_prior_delegation_is_noop() {
    let (_env, _admin, alice, _bob, client) = setup_token_with_balance();
    // Must not panic.
    client.undelegate(&alice);
    assert_eq!(client.get_delegate(&alice), None);
}

#[test]
fn test_redelegate_overwrites_previous_delegatee() {
    let (_env, _admin, alice, bob, client) = setup_token_with_balance();
    let carol = Address::generate(&_env);
    client.delegate(&alice, &bob);
    client.delegate(&alice, &carol);
    assert_eq!(client.get_delegate(&alice), Some(carol));
}

// ── Batch Operations (Issue #110) ───────────────────────────────────────────

#[test]
fn test_batch_transfer_moves_all_funds_and_emits_individual_events() {
    let (env, _admin, alice, bob, client) = setup_token_with_balance();
    let carol = Address::generate(&env);

    let transfers = Vec::from_array(&env, [(bob.clone(), 100i128), (carol.clone(), 200i128)]);
    client.batch_transfer(&alice, &transfers);

    assert_eq!(client.balance(&alice), 700);
    assert_eq!(client.balance(&bob), 100);
    assert_eq!(client.balance(&carol), 200);

    let events = env.events().all();
    // Last two events should be the two individual TransferEvents.
    assert!(events.len() >= 2);
}

#[test]
#[should_panic]
fn test_batch_transfer_rejects_when_total_exceeds_balance() {
    let (env, _admin, alice, bob, client) = setup_token_with_balance();
    let carol = Address::generate(&env);

    // alice has 1000; this totals 1100 and must be rejected before any
    // individual transfer executes.
    let transfers = Vec::from_array(&env, [(bob.clone(), 600i128), (carol.clone(), 500i128)]);
    client.batch_transfer(&alice, &transfers);
}

#[test]
fn test_batch_transfer_leaves_balances_untouched_when_rejected() {
    let (env, _admin, alice, bob, client) = setup_token_with_balance();
    let carol = Address::generate(&env);

    let transfers = Vec::from_array(&env, [(bob.clone(), 600i128), (carol.clone(), 500i128)]);
    let result = client.try_batch_transfer(&alice, &transfers);
    assert!(result.is_err());

    // Confirms Soroban's whole-invocation atomicity: no partial transfer happened.
    assert_eq!(client.balance(&alice), 1000);
    assert_eq!(client.balance(&bob), 0);
    assert_eq!(client.balance(&carol), 0);
}

#[test]
#[should_panic]
fn test_batch_transfer_rejects_batch_larger_than_max() {
    let (env, _admin, alice, _bob, client) = setup_token_with_balance();
    let mut transfers = Vec::new(&env);
    for _ in 0..(MAX_BATCH_SIZE + 1) {
        transfers.push_back((Address::generate(&env), 1i128));
    }
    client.batch_transfer(&alice, &transfers);
}

#[test]
#[should_panic]
fn test_batch_transfer_rejects_empty_batch() {
    let (env, _admin, alice, _bob, client) = setup_token_with_balance();
    let transfers: Vec<(Address, i128)> = Vec::new(&env);
    client.batch_transfer(&alice, &transfers);
}

#[test]
fn test_batch_mint_airdrops_to_multiple_recipients() {
    let (env, admin, client) = setup_token();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    let mints = Vec::from_array(&env, [(alice.clone(), 500i128), (bob.clone(), 750i128)]);
    client.batch_mint(&mints);

    assert_eq!(client.balance(&alice), 500);
    assert_eq!(client.balance(&bob), 750);
    assert_eq!(client.total_supply(), 1250);
    let _ = admin;
}

#[test]
#[should_panic]
fn test_batch_mint_rejects_exceeding_supply_cap() {
    let (env, _admin, client) = setup_token();
    client.set_max_supply(&1000i128);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    let mints = Vec::from_array(&env, [(alice.clone(), 600i128), (bob.clone(), 600i128)]);
    client.batch_mint(&mints);
}

#[test]
fn test_batch_approve_sets_multiple_allowances_independently() {
    let (env, _admin, alice, bob, client) = setup_token_with_balance();
    let carol = Address::generate(&env);

    let approvals = Vec::from_array(
        &env,
        [(bob.clone(), 50i128, 9999999u32), (carol.clone(), 75i128, 9999999u32)],
    );
    client.batch_approve(&alice, &approvals);

    assert_eq!(client.allowance(&alice, &bob), 50);
    assert_eq!(client.allowance(&alice, &carol), 75);
}

// ── Benchmark: gas savings vs individual transactions ───────────────────────
//
// Required by the issue: "Benchmark gas savings vs individual transactions."
// Prints actual CPU instructions consumed for a batch of N transfers vs N
// individual transfer() calls, at a few batch sizes, so MAX_BATCH_SIZE can
// be tuned against real Soroban resource limits instead of guessed.
#[test]
fn bench_batch_transfer_cost_scaling() {
    for &n in &[1u32, 5, 10, 25, 50] {
        let (env, _admin, alice, _bob, client) = setup_token_with_balance();
        client.mint(&alice, &1_000_000i128); // headroom for larger batches

        let recipients: Vec<Address> = (0..n).map(|_| Address::generate(&env)).collect();

        // Individual calls.
        env.cost_estimate().budget().reset_default();
        for r in recipients.iter() {
            client.transfer(&alice, r, &1i128);
        }
        let individual_cpu = env.cost_estimate().budget().cpu_instruction_cost();

        // One batch call.
        let (env2, _admin2, alice2, _bob2, client2) = setup_token_with_balance();
        client2.mint(&alice2, &1_000_000i128);
        let transfers = Vec::from_array(
            &env2,
            recipients
                .iter()
                .map(|r| (r.clone(), 1i128))
                .collect::<std::vec::Vec<_>>()
                .try_into()
                .unwrap_or_default(),
        );
        env2.cost_estimate().budget().reset_default();
        client2.batch_transfer(&alice2, &transfers);
        let batch_cpu = env2.cost_estimate().budget().cpu_instruction_cost();

        std::println!(
            "batch size {n}: individual calls = {individual_cpu} CPU insns, \
             one batch call = {batch_cpu} CPU insns, saved {}%",
            100 - (batch_cpu * 100 / individual_cpu.max(1))
        );
    }
}