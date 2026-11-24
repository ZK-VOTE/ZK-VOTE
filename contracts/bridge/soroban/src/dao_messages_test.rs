//! EPIC-002 DAO message tests: finality gating, Soroban-wins divergence
//! handling, reorg invalidation, versioning and replay safety.

use core::fmt::Debug;

use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env, InvokeError, U256,
};

use crate::dao_messages::{
    AckResult, DaoMessage, DaoMessageBody, DaoMessageError, LockBody, MessageStatus,
    MirrorRootBody, ReleaseBody, TallyBody, MESSAGE_VERSION,
};
use crate::{Bridge, BridgeClient, BridgeError};

#[contract]
pub struct NoopVoting;

#[contractimpl]
impl NoopVoting {
    pub fn is_nullifier_used(_env: Env, _dao_id: u64, _proposal_id: u64, _nullifier: U256) -> bool {
        false
    }
}

const DAO: u64 = 7;
const CHAIN: u64 = 31_337;
const START_LEDGER: u32 = 1_000;

struct Setup<'a> {
    env: &'a Env,
    client: BridgeClient<'a>,
    admin: Address,
    relayer: Address,
    sender: Address,
}

fn setup(env: &Env) -> Setup<'_> {
    env.mock_all_auths();
    env.ledger().set_sequence_number(START_LEDGER);
    let admin = Address::generate(env);
    let relayer = Address::generate(env);
    let sender = Address::generate(env);
    let voting = env.register(NoopVoting, ());
    let id = env.register(Bridge, (voting, admin.clone(), relayer.clone()));
    let client = BridgeClient::new(env, &id);
    client.set_dao_target(&admin, &DAO, &CHAIN, &mirror(env));
    client.set_message_sender(&admin, &sender, &true);
    Setup {
        env,
        client,
        admin,
        relayer,
        sender,
    }
}

fn mirror(env: &Env) -> BytesN<20> {
    BytesN::from_array(env, &hex20("5fbdb2315678afecb367f032d93f642f64180aa3"))
}

fn root_body(env: &Env, fill: u8) -> DaoMessageBody {
    DaoMessageBody::MirrorRoot(MirrorRootBody {
        root: BytesN::from_array(env, &[fill; 32]),
        member_count: 42,
    })
}

fn b32(env: &Env, fill: u8) -> BytesN<32> {
    BytesN::from_array(env, &[fill; 32])
}

fn zero(env: &Env) -> BytesN<32> {
    b32(env, 0)
}

fn hex<const N: usize>(text: &str) -> [u8; N] {
    let mut out = [0u8; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

fn hex20(text: &str) -> [u8; 20] {
    hex::<20>(text)
}

fn hex32(text: &str) -> [u8; 32] {
    hex::<32>(text)
}

/// The contract error a `try_` call failed with.
fn failed<T: Debug>(
    result: Result<T, Result<soroban_sdk::Error, InvokeError>>,
) -> soroban_sdk::Error {
    match result {
        Err(Ok(error)) => error,
        other => panic!("expected a contract error, got {other:?}"),
    }
}

fn err(code: DaoMessageError) -> soroban_sdk::Error {
    soroban_sdk::Error::from_contract_error(code as u32)
}

impl Setup<'_> {
    fn send(&self, body: &DaoMessageBody) -> u64 {
        self.client.send_dao_message(&self.sender, &DAO, body)
    }

    fn advance(&self, ledgers: u32) {
        let now = self.env.ledger().sequence();
        self.env.ledger().set_sequence_number(now + ledgers);
    }

    fn sent_and_final(&self, body: &DaoMessageBody) -> (u64, BytesN<32>) {
        let seq = self.send(body);
        self.advance(self.client.finality_ledgers());
        self.client.finalize_dao_message(&DAO, &seq);
        (seq, self.hash(seq))
    }

    fn hash(&self, seq: u64) -> BytesN<32> {
        self.client.get_dao_message(&DAO, &seq).unwrap().hash
    }

    fn status(&self, seq: u64) -> MessageStatus {
        self.client.get_dao_message(&DAO, &seq).unwrap().status
    }

    fn ack(&self, seq: u64, hash: &BytesN<32>) -> AckResult {
        self.client.acknowledge_dao_message(
            &self.relayer,
            &DAO,
            &seq,
            hash,
            &b32(self.env, 0xee),
            &123,
        )
    }
}

// ── encoding: both chains derive the same hash ────────────────────────────────

/// Golden vectors shared with `contracts/bridge/evm/test/DaoMirror.test.js`, which
/// asserts `DaoMirror.hashMessage` returns the same values for the same inputs.
#[test]
fn message_hash_matches_the_evm_abi_encoding() {
    let env = Env::default();
    let root = DaoMessage {
        version: 1,
        dao_id: 7,
        seq: 1,
        target_chain_id: 31_337,
        target_mirror: mirror(&env),
        source_ledger: 1_000,
        body: root_body(&env, 0x11),
    };
    assert_eq!(
        root.hash(&env).to_array(),
        hex32("fbc63c25ab4a59b623eba5b95ca53fbcdc9024ceecbbe413fdd2b9ee8fab2f37")
    );

    let lock = DaoMessage {
        version: 1,
        dao_id: 7,
        seq: 2,
        target_chain_id: 31_337,
        target_mirror: mirror(&env),
        source_ledger: 1_001,
        body: DaoMessageBody::Lock(LockBody {
            proposal_id: 3,
            recipient: BytesN::from_array(&env, &hex20("70997970c51812dc3a010c7d01b50e0d17dc79c8")),
            token: BytesN::from_array(&env, &[0x22; 20]),
            amount: 1_000_000_000_000_000_000,
            timeout_secs: 86_400,
        }),
    };
    assert_eq!(
        lock.hash(&env).to_array(),
        hex32("c00484df0a8ee44113c89a7ec223dc3a6027c9d5b7b31afae39e30f39e7007c9")
    );
}

#[test]
fn messages_are_versioned_sequenced_and_bound_to_their_target() {
    let env = Env::default();
    let s = setup(&env);

    assert_eq!(s.client.next_dao_sequence(&DAO), 1);
    let first = s.send(&root_body(&env, 1));
    let second = s.send(&root_body(&env, 1));
    assert_eq!((first, second), (1, 2));
    assert_eq!(s.client.next_dao_sequence(&DAO), 3);

    let record = s.client.get_dao_message(&DAO, &first).unwrap();
    assert_eq!(record.message.version, MESSAGE_VERSION);
    assert_eq!(record.message.target_chain_id, CHAIN);
    assert_eq!(record.message.target_mirror, mirror(&env));
    assert_eq!(record.message.source_ledger, START_LEDGER);
    assert_eq!(record.status, MessageStatus::Pending);
    // Same body, different sequence number: different identity, so neither can
    // be replayed as the other.
    assert_ne!(s.hash(first), s.hash(second));

    // Retargeting affects only later messages; the sent ones keep their hash.
    let old_hash = s.hash(first);
    s.client.set_dao_target(&s.admin, &DAO, &1, &mirror(&env));
    let third = s.send(&root_body(&env, 1));
    assert_eq!(s.hash(first), old_hash);
    assert_eq!(
        s.client
            .get_dao_message(&DAO, &third)
            .unwrap()
            .message
            .target_chain_id,
        1
    );

    // Sequence numbers are per DAO.
    s.client.set_dao_target(&s.admin, &8, &CHAIN, &mirror(&env));
    assert_eq!(
        s.client
            .send_dao_message(&s.sender, &8, &root_body(&env, 1)),
        1
    );
}

#[test]
fn only_allowlisted_senders_with_a_target_and_valid_body_can_send() {
    let env = Env::default();
    let s = setup(&env);

    let stranger = Address::generate(&env);
    assert_eq!(
        failed(
            s.client
                .try_send_dao_message(&stranger, &DAO, &root_body(&env, 1))
        ),
        err(DaoMessageError::UnauthorizedSender)
    );
    assert_eq!(
        failed(
            s.client
                .try_send_dao_message(&s.sender, &99, &root_body(&env, 1))
        ),
        err(DaoMessageError::TargetNotConfigured)
    );
    assert_eq!(
        failed(
            s.client
                .try_send_dao_message(&s.sender, &DAO, &root_body(&env, 0))
        ),
        err(DaoMessageError::InvalidPayload),
        "a zero membership root is rejected"
    );
    let lock = |amount: u128, timeout_secs: u64| {
        DaoMessageBody::Lock(LockBody {
            proposal_id: 1,
            recipient: BytesN::from_array(&env, &[0x33; 20]),
            token: BytesN::from_array(&env, &[0x22; 20]),
            amount,
            timeout_secs,
        })
    };
    for body in [lock(0, 60), lock(1, 0), lock(1, 86_401)] {
        assert_eq!(
            failed(s.client.try_send_dao_message(&s.sender, &DAO, &body)),
            err(DaoMessageError::InvalidPayload)
        );
    }
    assert_eq!(s.send(&lock(1, 86_400)), 1);

    s.client.set_message_sender(&s.admin, &s.sender, &false);
    assert_eq!(
        failed(
            s.client
                .try_send_dao_message(&s.sender, &DAO, &root_body(&env, 1))
        ),
        err(DaoMessageError::UnauthorizedSender)
    );
}

#[test]
fn configuration_is_admin_only_and_finality_is_bounded() {
    let env = Env::default();
    let s = setup(&env);
    let stranger = Address::generate(&env);
    let not_admin = soroban_sdk::Error::from_contract_error(BridgeError::NotAdmin as u32);

    assert_eq!(
        failed(
            s.client
                .try_set_dao_target(&stranger, &DAO, &1, &mirror(&env))
        ),
        not_admin
    );
    assert_eq!(
        failed(s.client.try_set_message_sender(&stranger, &stranger, &true)),
        not_admin
    );
    assert_eq!(
        failed(s.client.try_set_finality_ledgers(&stranger, &5)),
        not_admin
    );
    assert_eq!(
        failed(s.client.try_invalidate_dao_message(&stranger, &DAO, &1, &0)),
        not_admin
    );

    assert_eq!(
        failed(s.client.try_set_finality_ledgers(&s.admin, &0)),
        err(DaoMessageError::InvalidFinalityDepth)
    );
    assert_eq!(
        failed(s.client.try_set_finality_ledgers(&s.admin, &17_281)),
        err(DaoMessageError::InvalidFinalityDepth)
    );
    assert_eq!(
        failed(s.client.try_set_dao_target(
            &s.admin,
            &DAO,
            &CHAIN,
            &BytesN::from_array(&env, &[0; 20])
        )),
        err(DaoMessageError::InvalidPayload)
    );
    s.client.set_finality_ledgers(&s.admin, &5);
    assert_eq!(s.client.finality_ledgers(), 5);
}

// ── acceptance: nothing advances on an unfinalized message ────────────────────

#[test]
fn a_message_is_not_final_until_its_finality_ledger() {
    let env = Env::default();
    let s = setup(&env);
    s.client.set_finality_ledgers(&s.admin, &10);
    let seq = s.send(&root_body(&env, 1));
    let hash = s.hash(seq);

    s.advance(9);
    assert_eq!(
        failed(s.client.try_finalize_dao_message(&DAO, &seq)),
        err(DaoMessageError::NotYetFinal)
    );
    assert_eq!(
        failed(s.client.try_acknowledge_dao_message(
            &s.relayer,
            &DAO,
            &seq,
            &hash,
            &b32(&env, 1),
            &1
        )),
        err(DaoMessageError::NotYetFinal),
        "a pending message cannot be acknowledged as mirrored"
    );
    assert_eq!(s.client.expected_mirror_hash(&DAO, &seq), zero(&env));
    assert!(
        !s.client.report_mirror_state(&s.relayer, &DAO, &seq, &hash),
        "a mirror holding a pending message has diverged"
    );

    s.advance(1);
    s.client.finalize_dao_message(&DAO, &seq);
    let record = s.client.get_dao_message(&DAO, &seq).unwrap();
    assert_eq!(record.status, MessageStatus::Finalized);
    assert_eq!(record.finalized_ledger, START_LEDGER + 10);
    assert_eq!(s.client.expected_mirror_hash(&DAO, &seq), hash);
    assert_eq!(
        failed(s.client.try_finalize_dao_message(&DAO, &seq)),
        err(DaoMessageError::InvalidTransition)
    );
}

#[test]
fn changing_the_finality_depth_does_not_affect_messages_already_sent() {
    let env = Env::default();
    let s = setup(&env);
    s.client.set_finality_ledgers(&s.admin, &3);
    let seq = s.send(&root_body(&env, 1));
    s.client.set_finality_ledgers(&s.admin, &100);
    s.advance(3);
    s.client.finalize_dao_message(&DAO, &seq);
    assert_eq!(s.status(seq), MessageStatus::Finalized);
}

// ── acknowledgement receipts ──────────────────────────────────────────────────

#[test]
fn acknowledging_records_a_receipt_once() {
    let env = Env::default();
    let s = setup(&env);
    let (seq, hash) = s.sent_and_final(&root_body(&env, 1));

    assert_eq!(s.ack(seq, &hash), AckResult::Acknowledged);
    let record = s.client.get_dao_message(&DAO, &seq).unwrap();
    assert_eq!(record.status, MessageStatus::Acknowledged);
    let receipt = record.receipt.unwrap();
    assert_eq!(receipt.relayer, s.relayer);
    assert_eq!(receipt.evm_tx_hash, b32(&env, 0xee));
    assert_eq!(receipt.evm_block, 123);

    assert_eq!(
        failed(s.client.try_acknowledge_dao_message(
            &s.relayer,
            &DAO,
            &seq,
            &hash,
            &b32(&env, 1),
            &1
        )),
        err(DaoMessageError::InvalidTransition),
        "a receipt cannot be replayed"
    );
    let stranger = Address::generate(&env);
    let (other, other_hash) = s.sent_and_final(&root_body(&env, 2));
    assert_eq!(
        failed(s.client.try_acknowledge_dao_message(
            &stranger,
            &DAO,
            &other,
            &other_hash,
            &b32(&env, 1),
            &1
        )),
        soroban_sdk::Error::from_contract_error(BridgeError::UnauthorizedRelayer as u32)
    );
    assert_eq!(
        failed(s.client.try_acknowledge_dao_message(
            &s.relayer,
            &DAO,
            &99,
            &other_hash,
            &b32(&env, 1),
            &1
        )),
        err(DaoMessageError::MessageNotFound)
    );
}

// ── acceptance: disagreement resolves to Soroban ──────────────────────────────

#[test]
fn a_mismatching_acknowledgement_is_a_divergence_resolved_toward_soroban() {
    let env = Env::default();
    let s = setup(&env);
    let (seq, hash) = s.sent_and_final(&root_body(&env, 1));
    let wrong = b32(&env, 0xab);

    assert_eq!(s.ack(seq, &wrong), AckResult::Diverged);
    assert_eq!(
        s.status(seq),
        MessageStatus::Finalized,
        "nothing is acknowledged"
    );
    let open = s.client.get_divergence(&DAO, &seq).unwrap();
    assert_eq!(open.expected_hash, hash, "Soroban's hash is the resolution");
    assert_eq!(open.observed_hash, wrong);
    assert_eq!(open.canonical_status, MessageStatus::Finalized);
    assert_eq!(open.resolved_ledger, 0);

    // The relayer re-applies the canonical message on EVM, then acknowledges it.
    s.advance(1);
    assert_eq!(s.ack(seq, &hash), AckResult::Acknowledged);
    assert_eq!(
        s.client.get_divergence(&DAO, &seq).unwrap().resolved_ledger,
        s.env.ledger().sequence()
    );
}

#[test]
fn mirror_state_is_judged_only_against_soroban() {
    let env = Env::default();
    let s = setup(&env);
    let (seq, hash) = s.sent_and_final(&root_body(&env, 1));
    let other = b32(&env, 0xcd);

    // Finalized: holding nothing yet is lag; holding the message is fine.
    assert!(s
        .client
        .report_mirror_state(&s.relayer, &DAO, &seq, &zero(&env)));
    assert!(s.client.report_mirror_state(&s.relayer, &DAO, &seq, &hash));
    assert!(!s.client.report_mirror_state(&s.relayer, &DAO, &seq, &other));
    assert!(s.client.report_mirror_state(&s.relayer, &DAO, &seq, &hash));
    assert_ne!(
        s.client.get_divergence(&DAO, &seq).unwrap().resolved_ledger,
        0
    );

    // Acknowledged: the mirror must keep holding exactly this message.
    s.ack(seq, &hash);
    assert!(s.client.report_mirror_state(&s.relayer, &DAO, &seq, &hash));
    assert!(!s
        .client
        .report_mirror_state(&s.relayer, &DAO, &seq, &zero(&env)));
    assert_eq!(
        s.client.get_divergence(&DAO, &seq).unwrap().expected_hash,
        hash
    );
}

// ── acceptance: reorged messages invalidate mirrored state ────────────────────

#[test]
fn invalidating_a_mirrored_message_requires_the_mirror_to_drop_it() {
    let env = Env::default();
    let s = setup(&env);
    let (seq, hash) = s.sent_and_final(&root_body(&env, 1));
    s.ack(seq, &hash);

    s.client.invalidate_dao_message(&s.admin, &DAO, &seq, &1);

    let record = s.client.get_dao_message(&DAO, &seq).unwrap();
    assert_eq!(record.status, MessageStatus::Invalidated);
    assert_eq!(record.invalidated_ledger, s.env.ledger().sequence());
    assert_eq!(s.client.expected_mirror_hash(&DAO, &seq), zero(&env));
    assert!(
        !s.client.report_mirror_state(&s.relayer, &DAO, &seq, &hash),
        "a mirror still holding the reorged message has diverged"
    );
    let open = s.client.get_divergence(&DAO, &seq).unwrap();
    assert_eq!(open.expected_hash, zero(&env));
    assert_eq!(open.canonical_status, MessageStatus::Invalidated);
    assert!(s
        .client
        .report_mirror_state(&s.relayer, &DAO, &seq, &zero(&env)));

    assert_eq!(
        failed(
            s.client
                .try_invalidate_dao_message(&s.admin, &DAO, &seq, &1)
        ),
        err(DaoMessageError::InvalidTransition)
    );
}

#[test]
fn an_invalidated_message_can_never_be_finalized_or_acknowledged() {
    let env = Env::default();
    let s = setup(&env);
    let pending = s.send(&root_body(&env, 1));
    let pending_hash = s.hash(pending);
    let (finalized, finalized_hash) =
        s.sent_and_final(&DaoMessageBody::Release(ReleaseBody { proposal_id: 4 }));

    s.client
        .invalidate_dao_message(&s.admin, &DAO, &pending, &2);
    s.client
        .invalidate_dao_message(&s.admin, &DAO, &finalized, &2);

    assert_eq!(
        failed(s.client.try_finalize_dao_message(&DAO, &pending)),
        err(DaoMessageError::InvalidTransition)
    );
    assert_eq!(
        failed(s.client.try_acknowledge_dao_message(
            &s.relayer,
            &DAO,
            &pending,
            &pending_hash,
            &b32(&env, 1),
            &1
        )),
        err(DaoMessageError::InvalidTransition)
    );
    assert_eq!(
        failed(s.client.try_acknowledge_dao_message(
            &s.relayer,
            &DAO,
            &finalized,
            &finalized_hash,
            &b32(&env, 1),
            &1
        )),
        err(DaoMessageError::InvalidTransition)
    );
    // Invalidated messages keep their sequence numbers; the next one moves on.
    assert_eq!(
        s.send(&DaoMessageBody::Tally(TallyBody {
            proposal_id: 4,
            yes: 10,
            no: 3,
            tally_root: b32(&env, 9),
        })),
        3
    );
}
