//! # DAO-aware cross-chain messages (EPIC-002 Phase 1 and the Phase 2 doctrine)
//!
//! Soroban is canonical for governance; an EVM chain is a satellite that only
//! mirrors it. This module is the Soroban side of that contract:
//!
//! * **Typed, versioned messages**: mirror root, tally, lock, release, cancel.
//!   Each carries [`MESSAGE_VERSION`], the target chain id and mirror contract,
//!   and a per-DAO sequence number, so a message can be applied once, on one
//!   chain, by one mirror.
//! * **Finality gating**: a message is `Pending` when sent and only becomes
//!   `Finalized` once `finality_ledgers` ledgers have closed on top of it. Only a
//!   finalized message may be relayed; the EVM mirror re-checks this
//!   (`DaoMirror.sol`) and refuses to apply anything else.
//! * **Acknowledgement receipts**: the relayer acknowledges each message with the
//!   hash the EVM mirror computed. A mismatching hash is not acknowledged; it is
//!   recorded as a divergence.
//! * **Divergence detection, Soroban wins**: [`is_consistent`] is the single rule
//!   deciding what the mirror is allowed to hold for a sequence number. Any other
//!   observation is a divergence, resolved by making the mirror match Soroban.
//! * **Reorg invalidation**: an invalidated message is terminal. If it had
//!   already been mirrored, the event tells the relayer to roll the EVM state
//!   back (`DaoMirror.invalidateMessage`).
//!
//! ## Hash encoding
//!
//! The message hash is `keccak256` over the Solidity ABI encoding (32-byte
//! words) used by `DaoMirror.hashMessage`, so both chains derive the same hash:
//!
//! ```text
//! keccak256(abi.encode(
//!     keccak256("ZKVOTE_DAO_MESSAGE_V1"), version, targetChainId, targetMirror,
//!     daoId, seq, sourceLedger, kind, keccak256(body)))
//! ```
//!
//! where `body` is the ABI encoding of the variant's fields, in declaration order.

use soroban_sdk::{
    contracterror, contracttype, panic_with_error, symbol_short, Address, Bytes, BytesN, Env,
    Symbol,
};

/// Version stamped into every message; the EVM mirror rejects any other value.
pub const MESSAGE_VERSION: u32 = 1;
/// Ledgers that must close on top of a message before it is final (~1 minute).
pub const DEFAULT_FINALITY_LEDGERS: u32 = 12;
/// Upper bound for the finality depth (~1 day of ledgers).
pub const MAX_FINALITY_LEDGERS: u32 = 17_280;
/// Satellite lock timeout ceiling (EPIC-002 Phase 5: refund after 24h).
pub const MAX_LOCK_TIMEOUT_SECS: u64 = 86_400;
/// Domain tag hashed into every message.
pub const DOMAIN_TAG: &[u8] = b"ZKVOTE_DAO_MESSAGE_V1";

const FINALITY_KEY: Symbol = symbol_short!("fin_lg");

const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 535_680;

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum DaoMessageError {
    /// No EVM target (chain id + mirror) is configured for this DAO.
    TargetNotConfigured = 100,
    /// The caller is not an allowlisted message sender.
    UnauthorizedSender = 101,
    /// No message exists at this (dao_id, seq).
    MessageNotFound = 102,
    /// The message has not reached its finality ledger yet.
    NotYetFinal = 103,
    /// The requested status change is not allowed from the current status.
    InvalidTransition = 104,
    /// The message body fails validation.
    InvalidPayload = 105,
    /// Finality depth must be between 1 and `MAX_FINALITY_LEDGERS`.
    InvalidFinalityDepth = 106,
}

// ── message types ─────────────────────────────────────────────────────────────

/// Where a DAO's messages are delivered.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DaoTarget {
    pub chain_id: u64,
    /// `DaoMirror` contract address on the target chain.
    pub mirror: BytesN<20>,
}

/// Membership root to mirror on the satellite.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MirrorRootBody {
    pub root: BytesN<32>,
    pub member_count: u64,
}

/// Final tally of a proposal decided on Soroban.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TallyBody {
    pub proposal_id: u64,
    pub yes: u128,
    pub no: u128,
    pub tally_root: BytesN<32>,
}

/// Lock satellite treasury funds for a passed proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LockBody {
    pub proposal_id: u64,
    pub recipient: BytesN<20>,
    pub token: BytesN<20>,
    pub amount: u128,
    pub timeout_secs: u64,
}

/// Release a lock to its recipient.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleaseBody {
    pub proposal_id: u64,
}

/// Cancel a lock before its timeout.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CancelBody {
    pub proposal_id: u64,
    pub reason_code: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DaoMessageBody {
    MirrorRoot(MirrorRootBody),
    Tally(TallyBody),
    Lock(LockBody),
    Release(ReleaseBody),
    Cancel(CancelBody),
}

pub const KIND_MIRROR_ROOT: u32 = 1;
pub const KIND_TALLY: u32 = 2;
pub const KIND_LOCK: u32 = 3;
pub const KIND_RELEASE: u32 = 4;
pub const KIND_CANCEL: u32 = 5;

impl DaoMessageBody {
    pub fn kind(&self) -> u32 {
        match self {
            DaoMessageBody::MirrorRoot(_) => KIND_MIRROR_ROOT,
            DaoMessageBody::Tally(_) => KIND_TALLY,
            DaoMessageBody::Lock(_) => KIND_LOCK,
            DaoMessageBody::Release(_) => KIND_RELEASE,
            DaoMessageBody::Cancel(_) => KIND_CANCEL,
        }
    }

    /// ABI encoding of the body's fields (`abi.encode(...)` in Solidity).
    pub fn encode(&self, env: &Env) -> Bytes {
        let mut out = Bytes::new(env);
        match self {
            DaoMessageBody::MirrorRoot(body) => {
                push_b32(&mut out, &body.root);
                push_u64(&mut out, body.member_count);
            }
            DaoMessageBody::Tally(body) => {
                push_u64(&mut out, body.proposal_id);
                push_u128(&mut out, body.yes);
                push_u128(&mut out, body.no);
                push_b32(&mut out, &body.tally_root);
            }
            DaoMessageBody::Lock(body) => {
                push_u64(&mut out, body.proposal_id);
                push_address(&mut out, &body.recipient);
                push_address(&mut out, &body.token);
                push_u128(&mut out, body.amount);
                push_u64(&mut out, body.timeout_secs);
            }
            DaoMessageBody::Release(body) => push_u64(&mut out, body.proposal_id),
            DaoMessageBody::Cancel(body) => {
                push_u64(&mut out, body.proposal_id);
                push_u64(&mut out, body.reason_code as u64);
            }
        }
        out
    }

    fn validate(&self, env: &Env) {
        let valid = match self {
            DaoMessageBody::MirrorRoot(body) => !is_zero(&body.root.to_array()),
            DaoMessageBody::Tally(_) => true,
            DaoMessageBody::Lock(body) => {
                body.amount > 0
                    && body.timeout_secs > 0
                    && body.timeout_secs <= MAX_LOCK_TIMEOUT_SECS
                    && !is_zero(&body.recipient.to_array())
            }
            DaoMessageBody::Release(_) | DaoMessageBody::Cancel(_) => true,
        };
        if !valid {
            panic_with_error!(env, DaoMessageError::InvalidPayload);
        }
    }
}

/// A message as it is relayed to the satellite. Its hash is its identity.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DaoMessage {
    pub version: u32,
    pub dao_id: u64,
    pub seq: u64,
    pub target_chain_id: u64,
    pub target_mirror: BytesN<20>,
    pub source_ledger: u32,
    pub body: DaoMessageBody,
}

impl DaoMessage {
    pub fn hash(&self, env: &Env) -> BytesN<32> {
        let domain = env
            .crypto()
            .keccak256(&Bytes::from_slice(env, DOMAIN_TAG))
            .to_bytes();
        let body_hash = env.crypto().keccak256(&self.body.encode(env)).to_bytes();

        let mut out = Bytes::new(env);
        push_b32(&mut out, &domain);
        push_u64(&mut out, self.version as u64);
        push_u64(&mut out, self.target_chain_id);
        push_address(&mut out, &self.target_mirror);
        push_u64(&mut out, self.dao_id);
        push_u64(&mut out, self.seq);
        push_u64(&mut out, self.source_ledger as u64);
        push_u64(&mut out, self.body.kind() as u64);
        push_b32(&mut out, &body_hash);
        env.crypto().keccak256(&out).to_bytes()
    }
}

/// Lifecycle of a message on Soroban.
///
/// ```text
/// Pending ──finalize (after finality ledgers)──► Finalized ──acknowledge──► Acknowledged
///    └──────────────── invalidate (reorg) ───────────┴──────────────────────────┴──► Invalidated
/// ```
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum MessageStatus {
    Pending,
    Finalized,
    Acknowledged,
    Invalidated,
}

/// Receipt recorded when the relayer confirms the mirror applied a message.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AckReceipt {
    pub evm_tx_hash: BytesN<32>,
    pub evm_block: u64,
    pub relayer: Address,
    pub ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DaoMessageRecord {
    pub message: DaoMessage,
    pub hash: BytesN<32>,
    pub status: MessageStatus,
    /// First ledger at which `finalize` succeeds (fixed when the message is sent).
    pub final_after_ledger: u32,
    pub finalized_ledger: u32,
    pub invalidated_ledger: u32,
    pub receipt: Option<AckReceipt>,
}

/// A disagreement between what the mirror reported and what Soroban holds.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Divergence {
    /// Hash the mirror must hold: the message hash, or all zeros when the
    /// mirror must hold nothing for this sequence number.
    pub expected_hash: BytesN<32>,
    pub observed_hash: BytesN<32>,
    pub canonical_status: MessageStatus,
    pub detected_ledger: u32,
    /// Zero while unresolved.
    pub resolved_ledger: u32,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum AckResult {
    Acknowledged,
    Diverged,
}

#[contracttype]
#[derive(Clone)]
pub enum DaoMsgKey {
    Target(u64),
    NextSeq(u64),
    Message(u64, u64),
    Divergence(u64, u64),
    Sender(Address),
}

// ── events ────────────────────────────────────────────────────────────────────

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct DaoMessageSent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub seq: u64,
    pub kind: u32,
    pub hash: BytesN<32>,
    pub final_after_ledger: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct DaoMessageFinalized {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub seq: u64,
    pub hash: BytesN<32>,
    pub finalized_ledger: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct DaoMessageAcknowledged {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub seq: u64,
    pub hash: BytesN<32>,
    pub evm_tx_hash: BytesN<32>,
    pub evm_block: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct DaoMessageInvalidated {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub seq: u64,
    pub hash: BytesN<32>,
    /// True when the mirror had already applied it and must roll it back.
    pub was_mirrored: bool,
    pub reason_code: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct MirrorDivergenceDetected {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub seq: u64,
    pub expected_hash: BytesN<32>,
    pub observed_hash: BytesN<32>,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct MirrorDivergenceResolved {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub seq: u64,
    pub expected_hash: BytesN<32>,
}

// ── configuration ─────────────────────────────────────────────────────────────

pub fn finality_ledgers(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&FINALITY_KEY)
        .unwrap_or(DEFAULT_FINALITY_LEDGERS)
}

pub fn set_finality_ledgers(env: &Env, ledgers: u32) {
    if ledgers == 0 || ledgers > MAX_FINALITY_LEDGERS {
        panic_with_error!(env, DaoMessageError::InvalidFinalityDepth);
    }
    env.storage().instance().set(&FINALITY_KEY, &ledgers);
}

pub fn set_target(env: &Env, dao_id: u64, target: &DaoTarget) {
    if target.chain_id == 0 || is_zero(&target.mirror.to_array()) {
        panic_with_error!(env, DaoMessageError::InvalidPayload);
    }
    let key = DaoMsgKey::Target(dao_id);
    env.storage().persistent().set(&key, target);
    bump(env, &key);
}

pub fn target(env: &Env, dao_id: u64) -> Option<DaoTarget> {
    env.storage().persistent().get(&DaoMsgKey::Target(dao_id))
}

pub fn set_sender(env: &Env, sender: &Address, allowed: bool) {
    let key = DaoMsgKey::Sender(sender.clone());
    if allowed {
        env.storage().persistent().set(&key, &true);
        bump(env, &key);
    } else {
        env.storage().persistent().remove(&key);
    }
}

pub fn is_sender(env: &Env, sender: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&DaoMsgKey::Sender(sender.clone()))
        .unwrap_or(false)
}

/// The sequence number the next message for `dao_id` will get (starts at 1).
pub fn next_seq(env: &Env, dao_id: u64) -> u64 {
    env.storage()
        .persistent()
        .get(&DaoMsgKey::NextSeq(dao_id))
        .unwrap_or(1)
}

pub fn record(env: &Env, dao_id: u64, seq: u64) -> Option<DaoMessageRecord> {
    env.storage()
        .persistent()
        .get(&DaoMsgKey::Message(dao_id, seq))
}

pub fn divergence(env: &Env, dao_id: u64, seq: u64) -> Option<Divergence> {
    env.storage()
        .persistent()
        .get(&DaoMsgKey::Divergence(dao_id, seq))
}

// ── canonical-chain rule ──────────────────────────────────────────────────────

/// What the mirror must hold for this sequence number: the message hash once it
/// is final, otherwise nothing (all zeros).
pub fn expected_mirror_hash(env: &Env, record: &DaoMessageRecord) -> BytesN<32> {
    match record.status {
        MessageStatus::Finalized | MessageStatus::Acknowledged => record.hash.clone(),
        MessageStatus::Pending | MessageStatus::Invalidated => zero_hash(env),
    }
}

/// Whether the mirror holding `observed` for this sequence number agrees with
/// Soroban. A finalized message the mirror has not applied yet is lag, not
/// disagreement; everything else must match [`expected_mirror_hash`] exactly.
pub fn is_consistent(env: &Env, record: &DaoMessageRecord, observed: &BytesN<32>) -> bool {
    let nothing = zero_hash(env);
    match record.status {
        MessageStatus::Finalized => *observed == record.hash || *observed == nothing,
        MessageStatus::Acknowledged => *observed == record.hash,
        MessageStatus::Pending | MessageStatus::Invalidated => *observed == nothing,
    }
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

pub fn send(env: &Env, sender: &Address, dao_id: u64, body: DaoMessageBody) -> u64 {
    if !is_sender(env, sender) {
        panic_with_error!(env, DaoMessageError::UnauthorizedSender);
    }
    body.validate(env);
    let target = target(env, dao_id)
        .unwrap_or_else(|| panic_with_error!(env, DaoMessageError::TargetNotConfigured));

    let seq = next_seq(env, dao_id);
    let source_ledger = env.ledger().sequence();
    let message = DaoMessage {
        version: MESSAGE_VERSION,
        dao_id,
        seq,
        target_chain_id: target.chain_id,
        target_mirror: target.mirror,
        source_ledger,
        body,
    };
    let hash = message.hash(env);
    let kind = message.body.kind();
    let final_after_ledger = source_ledger.saturating_add(finality_ledgers(env));

    store(
        env,
        &DaoMessageRecord {
            message,
            hash: hash.clone(),
            status: MessageStatus::Pending,
            final_after_ledger,
            finalized_ledger: 0,
            invalidated_ledger: 0,
            receipt: None,
        },
    );
    let seq_key = DaoMsgKey::NextSeq(dao_id);
    env.storage().persistent().set(&seq_key, &(seq + 1));
    bump(env, &seq_key);

    DaoMessageSent {
        dao_id,
        seq,
        kind,
        hash,
        final_after_ledger,
    }
    .publish(env);
    seq
}

/// Pending → Finalized once the finality ledger is reached. Permissionless.
pub fn finalize(env: &Env, dao_id: u64, seq: u64) {
    let mut record = load(env, dao_id, seq);
    if record.status != MessageStatus::Pending {
        panic_with_error!(env, DaoMessageError::InvalidTransition);
    }
    let now = env.ledger().sequence();
    if now < record.final_after_ledger {
        panic_with_error!(env, DaoMessageError::NotYetFinal);
    }
    record.status = MessageStatus::Finalized;
    record.finalized_ledger = now;
    store(env, &record);

    DaoMessageFinalized {
        dao_id,
        seq,
        hash: record.hash,
        finalized_ledger: now,
    }
    .publish(env);
}

/// Finalized → Acknowledged when the mirror applied exactly this message.
/// A different hash is recorded as a divergence instead (and returns
/// `Diverged` without failing, so the record survives).
pub fn acknowledge(
    env: &Env,
    relayer: &Address,
    dao_id: u64,
    seq: u64,
    evm_message_hash: BytesN<32>,
    evm_tx_hash: BytesN<32>,
    evm_block: u64,
) -> AckResult {
    let mut record = load(env, dao_id, seq);
    match record.status {
        MessageStatus::Finalized => {}
        MessageStatus::Pending => panic_with_error!(env, DaoMessageError::NotYetFinal),
        MessageStatus::Acknowledged | MessageStatus::Invalidated => {
            panic_with_error!(env, DaoMessageError::InvalidTransition)
        }
    }
    if evm_message_hash != record.hash {
        flag_divergence(env, &record, evm_message_hash);
        return AckResult::Diverged;
    }

    let ledger = env.ledger().sequence();
    record.status = MessageStatus::Acknowledged;
    record.receipt = Some(AckReceipt {
        evm_tx_hash: evm_tx_hash.clone(),
        evm_block,
        relayer: relayer.clone(),
        ledger,
    });
    store(env, &record);
    clear_divergence(env, &record);

    DaoMessageAcknowledged {
        dao_id,
        seq,
        hash: record.hash,
        evm_tx_hash,
        evm_block,
    }
    .publish(env);
    AckResult::Acknowledged
}

/// Compare what the mirror holds for `seq` with Soroban. Returns `true` when
/// consistent (resolving any open divergence), `false` when a divergence was
/// recorded.
pub fn report_mirror_state(env: &Env, dao_id: u64, seq: u64, observed: BytesN<32>) -> bool {
    let record = load(env, dao_id, seq);
    if is_consistent(env, &record, &observed) {
        clear_divergence(env, &record);
        true
    } else {
        flag_divergence(env, &record, observed);
        false
    }
}

/// Any non-invalidated status → Invalidated (Soroban reorg). Terminal.
pub fn invalidate(env: &Env, dao_id: u64, seq: u64, reason_code: u32) {
    let mut record = load(env, dao_id, seq);
    if record.status == MessageStatus::Invalidated {
        panic_with_error!(env, DaoMessageError::InvalidTransition);
    }
    let was_mirrored = record.status == MessageStatus::Acknowledged;
    record.status = MessageStatus::Invalidated;
    record.invalidated_ledger = env.ledger().sequence();
    store(env, &record);

    DaoMessageInvalidated {
        dao_id,
        seq,
        hash: record.hash,
        was_mirrored,
        reason_code,
    }
    .publish(env);
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn load(env: &Env, dao_id: u64, seq: u64) -> DaoMessageRecord {
    record(env, dao_id, seq)
        .unwrap_or_else(|| panic_with_error!(env, DaoMessageError::MessageNotFound))
}

fn store(env: &Env, record: &DaoMessageRecord) {
    let key = DaoMsgKey::Message(record.message.dao_id, record.message.seq);
    env.storage().persistent().set(&key, record);
    bump(env, &key);
}

fn flag_divergence(env: &Env, record: &DaoMessageRecord, observed: BytesN<32>) {
    let dao_id = record.message.dao_id;
    let seq = record.message.seq;
    let expected_hash = expected_mirror_hash(env, record);
    let key = DaoMsgKey::Divergence(dao_id, seq);
    env.storage().persistent().set(
        &key,
        &Divergence {
            expected_hash: expected_hash.clone(),
            observed_hash: observed.clone(),
            canonical_status: record.status,
            detected_ledger: env.ledger().sequence(),
            resolved_ledger: 0,
        },
    );
    bump(env, &key);
    MirrorDivergenceDetected {
        dao_id,
        seq,
        expected_hash,
        observed_hash: observed,
    }
    .publish(env);
}

fn clear_divergence(env: &Env, record: &DaoMessageRecord) {
    let dao_id = record.message.dao_id;
    let seq = record.message.seq;
    let key = DaoMsgKey::Divergence(dao_id, seq);
    let Some(mut open) = divergence(env, dao_id, seq) else {
        return;
    };
    if open.resolved_ledger != 0 {
        return;
    }
    open.resolved_ledger = env.ledger().sequence();
    env.storage().persistent().set(&key, &open);
    bump(env, &key);
    MirrorDivergenceResolved {
        dao_id,
        seq,
        expected_hash: expected_mirror_hash(env, record),
    }
    .publish(env);
}

fn bump<K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &K) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
}

fn zero_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

fn is_zero(bytes: &[u8]) -> bool {
    bytes.iter().all(|b| *b == 0)
}

fn push_u64(out: &mut Bytes, value: u64) {
    let mut word = [0u8; 32];
    word[24..].copy_from_slice(&value.to_be_bytes());
    out.extend_from_array(&word);
}

fn push_u128(out: &mut Bytes, value: u128) {
    let mut word = [0u8; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    out.extend_from_array(&word);
}

fn push_address(out: &mut Bytes, value: &BytesN<20>) {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(&value.to_array());
    out.extend_from_array(&word);
}

fn push_b32(out: &mut Bytes, value: &BytesN<32>) {
    out.extend_from_array(&value.to_array());
}
