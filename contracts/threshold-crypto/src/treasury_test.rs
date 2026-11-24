//! Multisig treasury tests (#888): thresholds, dual control, digest and expiry
//! binding, replay, rotation and the end-to-end propose → collect → execute →
//! audit flow.

use super::treasury::{SignerSetRotatedEvent, TreasurySpendExecutedEvent};
use super::*;
use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::{token, vec, BytesN, Event};

struct Setup<'a> {
    env: Env,
    client: ThresholdCryptoClient<'a>,
    contract: Address,
    token: Address,
    signers: [Address; 3],
}

/// 2-of-3 for ordinary spends, 3-of-3 above 1_000, treasury funded with 10_000.
fn setup<'a>() -> Setup<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = 1_000_000);
    let contract = env.register(ThresholdCrypto, ());
    let client = ThresholdCryptoClient::new(&env, &contract);
    let admin = Address::generate(&env);
    client.initialize(&admin, &2, &3);
    let signers = [
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];
    client.treasury_init(
        &vec![
            &env,
            signers[0].clone(),
            signers[1].clone(),
            signers[2].clone(),
        ],
        &2,
        &1_000,
        &3,
    );

    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    token::StellarAssetClient::new(&env, &sac.address()).mint(&contract, &10_000);
    Setup {
        env: env.clone(),
        client,
        contract,
        token: sac.address(),
        signers,
    }
}

fn spend(s: &Setup, to: &Address, amount: i128) -> TreasuryAction {
    TreasuryAction::Spend(s.token.clone(), to.clone(), amount)
}

fn balance(s: &Setup, who: &Address) -> i128 {
    token::TokenClient::new(&s.env, &s.token).balance(who)
}

fn digest(s: &Setup, id: u64) -> BytesN<32> {
    s.client.treasury_proposal(&id).digest
}

const EXPIRY: u64 = 1_000_000 + 3_600;

#[test]
fn end_to_end_propose_collect_execute_audit() {
    let s = setup();
    let payee = Address::generate(&s.env);
    let id = s
        .client
        .treasury_propose(&s.signers[0], &spend(&s, &payee, 500), &EXPIRY);
    assert_eq!(
        s.client
            .treasury_approve(&s.signers[0], &id, &digest(&s, id)),
        1
    );
    assert_eq!(
        s.client
            .treasury_approve(&s.signers[1], &id, &digest(&s, id)),
        2
    );
    s.client.treasury_execute(&s.signers[2], &id);
    // Audit trail (events of the last invocation): the execution names the proposal, payee, amount and approvals.
    let expected = TreasurySpendExecutedEvent {
        id,
        token: s.token.clone(),
        to: payee.clone(),
        amount: 500,
        approvals: 2,
    };
    assert!(s
        .env
        .events()
        .all()
        .events()
        .contains(&expected.to_xdr(&s.env, &s.contract)));

    assert_eq!(balance(&s, &payee), 500);
    assert_eq!(balance(&s, &s.contract), 9_500);
    assert!(s.client.treasury_proposal(&id).executed);
}

#[test]
#[should_panic(expected = "Error(Contract, #26)")]
fn a_spend_cannot_run_with_fewer_approvals_than_the_threshold() {
    let s = setup();
    let payee = Address::generate(&s.env);
    let id = s
        .client
        .treasury_propose(&s.signers[0], &spend(&s, &payee, 500), &EXPIRY);
    s.client
        .treasury_approve(&s.signers[0], &id, &digest(&s, id));
    s.client.treasury_execute(&s.signers[0], &id);
}

#[test]
fn a_large_spend_needs_dual_control() {
    let s = setup();
    let payee = Address::generate(&s.env);
    let id = s
        .client
        .treasury_propose(&s.signers[0], &spend(&s, &payee, 5_000), &EXPIRY);
    s.client
        .treasury_approve(&s.signers[0], &id, &digest(&s, id));
    s.client
        .treasury_approve(&s.signers[1], &id, &digest(&s, id));
    assert!(
        s.client.try_treasury_execute(&s.signers[0], &id).is_err(),
        "2 of 3 is not enough above large_amount"
    );
    assert_eq!(balance(&s, &payee), 0);

    s.client
        .treasury_approve(&s.signers[2], &id, &digest(&s, id));
    s.client.treasury_execute(&s.signers[0], &id);
    assert_eq!(balance(&s, &payee), 5_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #24)")]
fn an_approval_is_bound_to_the_proposal_digest() {
    let s = setup();
    let payee = Address::generate(&s.env);
    let a = s
        .client
        .treasury_propose(&s.signers[0], &spend(&s, &payee, 100), &EXPIRY);
    let b = s
        .client
        .treasury_propose(&s.signers[0], &spend(&s, &payee, 900), &EXPIRY);
    // Replaying the signature over proposal a's digest against proposal b fails.
    s.client.treasury_approve(&s.signers[1], &b, &digest(&s, a));
}

#[test]
fn digests_differ_by_nonce_and_expiry() {
    let s = setup();
    let payee = Address::generate(&s.env);
    let a = s
        .client
        .treasury_propose(&s.signers[0], &spend(&s, &payee, 100), &EXPIRY);
    let b = s
        .client
        .treasury_propose(&s.signers[0], &spend(&s, &payee, 100), &EXPIRY);
    let c = s
        .client
        .treasury_propose(&s.signers[0], &spend(&s, &payee, 100), &(EXPIRY + 1));
    assert_ne!(digest(&s, a), digest(&s, b), "same action, different nonce");
    assert_ne!(
        digest(&s, b),
        digest(&s, c),
        "same action, different expiry"
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")]
fn an_executed_proposal_cannot_be_replayed() {
    let s = setup();
    let payee = Address::generate(&s.env);
    let id = s
        .client
        .treasury_propose(&s.signers[0], &spend(&s, &payee, 100), &EXPIRY);
    s.client
        .treasury_approve(&s.signers[0], &id, &digest(&s, id));
    s.client
        .treasury_approve(&s.signers[1], &id, &digest(&s, id));
    s.client.treasury_execute(&s.signers[0], &id);
    s.client.treasury_execute(&s.signers[0], &id);
}

#[test]
fn an_expired_proposal_can_neither_be_approved_nor_executed() {
    let s = setup();
    let payee = Address::generate(&s.env);
    let id = s
        .client
        .treasury_propose(&s.signers[0], &spend(&s, &payee, 100), &EXPIRY);
    s.client
        .treasury_approve(&s.signers[0], &id, &digest(&s, id));
    s.client
        .treasury_approve(&s.signers[1], &id, &digest(&s, id));
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY);
    assert!(s
        .client
        .try_treasury_approve(&s.signers[2], &id, &digest(&s, id))
        .is_err());
    assert!(s.client.try_treasury_execute(&s.signers[0], &id).is_err());
    assert_eq!(balance(&s, &payee), 0);
}

#[test]
fn only_signers_propose_approve_and_execute_and_each_approves_once() {
    let s = setup();
    let outsider = Address::generate(&s.env);
    let payee = Address::generate(&s.env);
    assert!(s
        .client
        .try_treasury_propose(&outsider, &spend(&s, &payee, 100), &EXPIRY)
        .is_err());
    let id = s
        .client
        .treasury_propose(&s.signers[0], &spend(&s, &payee, 100), &EXPIRY);
    assert!(s
        .client
        .try_treasury_approve(&outsider, &id, &digest(&s, id))
        .is_err());
    s.client
        .treasury_approve(&s.signers[0], &id, &digest(&s, id));
    assert!(
        s.client
            .try_treasury_approve(&s.signers[0], &id, &digest(&s, id))
            .is_err(),
        "no double approval"
    );
    s.client
        .treasury_approve(&s.signers[1], &id, &digest(&s, id));
    assert!(s.client.try_treasury_execute(&outsider, &id).is_err());
}

#[test]
fn rotation_needs_the_current_threshold_emits_an_audit_event_and_invalidates_old_approvals() {
    let s = setup();
    let payee = Address::generate(&s.env);
    let pending = s
        .client
        .treasury_propose(&s.signers[0], &spend(&s, &payee, 100), &EXPIRY);
    s.client
        .treasury_approve(&s.signers[0], &pending, &digest(&s, pending));
    s.client
        .treasury_approve(&s.signers[1], &pending, &digest(&s, pending));

    let newcomer = Address::generate(&s.env);
    let new_set = vec![
        &s.env,
        s.signers[1].clone(),
        s.signers[2].clone(),
        newcomer.clone(),
    ];
    let rotate = TreasuryAction::Rotate(new_set.clone(), 2, 2_000, 3);
    let id = s.client.treasury_propose(&s.signers[0], &rotate, &EXPIRY);
    s.client
        .treasury_approve(&s.signers[0], &id, &digest(&s, id));
    assert!(
        s.client.try_treasury_execute(&s.signers[0], &id).is_err(),
        "one approval is below the current threshold"
    );
    s.client
        .treasury_approve(&s.signers[2], &id, &digest(&s, id));
    s.client.treasury_execute(&s.signers[0], &id);
    let audit = SignerSetRotatedEvent {
        id,
        old_version: 1,
        new_version: 2,
        signers: new_set.clone(),
        threshold: 2,
        large_threshold: 3,
        approvals: 2,
    };
    assert!(s
        .env
        .events()
        .all()
        .events()
        .contains(&audit.to_xdr(&s.env, &s.contract)));

    let cfg = s.client.treasury_config();
    assert_eq!(cfg.signers, new_set);
    assert_eq!(cfg.version, 2);

    // Approvals collected under the old set no longer count, and the removed signer is out.
    assert!(s
        .client
        .try_treasury_execute(&s.signers[1], &pending)
        .is_err());
    assert_eq!(balance(&s, &payee), 0);
    assert!(s
        .client
        .try_treasury_propose(&s.signers[0], &spend(&s, &payee, 1), &EXPIRY)
        .is_err());
    let fresh = s
        .client
        .treasury_propose(&newcomer, &spend(&s, &payee, 100), &EXPIRY);
    s.client
        .treasury_approve(&newcomer, &fresh, &digest(&s, fresh));
    s.client
        .treasury_approve(&s.signers[1], &fresh, &digest(&s, fresh));
    s.client.treasury_execute(&s.signers[2], &fresh);
    assert_eq!(balance(&s, &payee), 100);
}

#[test]
fn invalid_signer_sets_and_thresholds_are_refused() {
    let s = setup();
    let a = Address::generate(&s.env);
    let dup = vec![&s.env, a.clone(), a.clone()];
    assert!(s
        .client
        .try_treasury_propose(
            &s.signers[0],
            &TreasuryAction::Rotate(dup, 1, 0, 2),
            &EXPIRY
        )
        .is_err());
    let two = vec![&s.env, a.clone(), Address::generate(&s.env)];
    // Dual control: large_threshold must be at least 2.
    assert!(s
        .client
        .try_treasury_propose(
            &s.signers[0],
            &TreasuryAction::Rotate(two.clone(), 1, 0, 1),
            &EXPIRY
        )
        .is_err());
    assert!(s
        .client
        .try_treasury_propose(
            &s.signers[0],
            &TreasuryAction::Rotate(two, 3, 0, 3),
            &EXPIRY
        )
        .is_err());
    let payee = Address::generate(&s.env);
    assert!(s
        .client
        .try_treasury_propose(&s.signers[0], &spend(&s, &payee, 0), &EXPIRY)
        .is_err());
    assert!(s
        .client
        .try_treasury_propose(
            &s.signers[0],
            &spend(&s, &payee, 1),
            &(1_000_000 + 31 * 24 * 3600)
        )
        .is_err());
}
