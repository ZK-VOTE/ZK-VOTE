//! Multisig treasury (ZV-039 / #888).
//!
//! Treasury spends and signer-set changes go through one workflow:
//!
//! 1. A signer **proposes** an action with an expiry. The proposal gets a
//!    nonce (its id) and a digest: `sha256(xdr(TreasuryDigest))`, which
//!    binds the contract, the nonce, the current signer-set version, the
//!    action and the expiry.
//! 2. Signers **approve** by authorizing a call that names that digest. An
//!    approval for another proposal, another signer set or another expiry
//!    does not match and is rejected.
//! 3. Anyone in the signer set **executes** once enough approvals exist.
//!    Spends above `large_amount` need `large_threshold` approvals (dual
//!    control); everything else needs `threshold`. Execution consumes the
//!    nonce, so a proposal can run at most once, and is refused after expiry.
//!
//! Rotating the signer set is itself a proposal and needs the *current*
//! threshold. It bumps the set's version, which makes every approval collected
//! under the old set stale, and emits an audit event.

use crate::{ThresholdCrypto, ThresholdCryptoArgs, ThresholdCryptoClient, ThresholdError};
use soroban_sdk::{
    contractevent, contractimpl, contracttype, panic_with_error, token, xdr::ToXdr, Address,
    BytesN, Env, Vec,
};

/// At most this many signers, so approval checks stay bounded.
pub const MAX_TREASURY_SIGNERS: u32 = 20;
/// A proposal may live at most this long (seconds).
pub const MAX_PROPOSAL_LIFETIME: u64 = 30 * 24 * 60 * 60;

const TTL_THRESHOLD: u32 = 120_960;
const TTL_EXTEND: u32 = 535_680;

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct TreasuryConfig {
    pub signers: Vec<Address>,
    /// Approvals needed for a spend up to `large_amount`, and for a rotation.
    pub threshold: u32,
    /// Spends strictly above this amount need `large_threshold` approvals.
    pub large_amount: i128,
    /// Dual control: at least 2 and at least `threshold`.
    pub large_threshold: u32,
    /// Bumped on every rotation; approvals from an older version are stale.
    pub version: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum TreasuryAction {
    /// Pay `amount` of `token` from the treasury to `to`.
    Spend(Address, Address, i128),
    /// Replace the signer set: (signers, threshold, large_amount, large_threshold).
    Rotate(Vec<Address>, u32, i128, u32),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct TreasuryProposal {
    pub id: u64,
    pub proposer: Address,
    pub action: TreasuryAction,
    pub expires_at: u64,
    pub config_version: u32,
    pub digest: BytesN<32>,
    pub approvals: Vec<Address>,
    pub executed: bool,
}

/// What a signer's approval commits to.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct TreasuryDigest {
    pub contract: Address,
    pub nonce: u64,
    pub config_version: u32,
    pub action: TreasuryAction,
    pub expires_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum TreasuryKey {
    Config,
    NextId,
    Proposal(u64),
}

#[contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct TreasuryProposedEvent {
    #[topic]
    pub id: u64,
    pub proposer: Address,
    pub digest: BytesN<32>,
    pub expires_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct TreasuryApprovedEvent {
    #[topic]
    pub id: u64,
    pub signer: Address,
    pub approvals: u32,
}

#[contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct TreasurySpendExecutedEvent {
    #[topic]
    pub id: u64,
    pub token: Address,
    pub to: Address,
    pub amount: i128,
    pub approvals: u32,
}

/// Audit event for a signer-set rotation.
#[contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct SignerSetRotatedEvent {
    #[topic]
    pub id: u64,
    pub old_version: u32,
    pub new_version: u32,
    pub signers: Vec<Address>,
    pub threshold: u32,
    pub large_threshold: u32,
    pub approvals: u32,
}

fn validate(
    env: &Env,
    signers: &Vec<Address>,
    threshold: u32,
    large_amount: i128,
    large_threshold: u32,
) {
    let n = signers.len();
    if n == 0 || n > MAX_TREASURY_SIGNERS {
        panic_with_error!(env, ThresholdError::InvalidSignerSet);
    }
    for i in 0..n {
        for j in (i + 1)..n {
            if signers.get_unchecked(i) == signers.get_unchecked(j) {
                panic_with_error!(env, ThresholdError::InvalidSignerSet);
            }
        }
    }
    if threshold == 0 || threshold > n {
        panic_with_error!(env, ThresholdError::InvalidThreshold);
    }
    // Dual control: a large transfer never rests on one key.
    if large_threshold < threshold || large_threshold < 2 || large_threshold > n || large_amount < 0
    {
        panic_with_error!(env, ThresholdError::InvalidThreshold);
    }
}

fn config(env: &Env) -> TreasuryConfig {
    env.storage()
        .instance()
        .get(&TreasuryKey::Config)
        .unwrap_or_else(|| panic_with_error!(env, ThresholdError::TreasuryNotInitialized))
}

fn require_signer(env: &Env, cfg: &TreasuryConfig, who: &Address) {
    if !cfg.signers.contains(who) {
        panic_with_error!(env, ThresholdError::NotTreasurySigner);
    }
}

fn load(env: &Env, id: u64) -> TreasuryProposal {
    env.storage()
        .persistent()
        .get(&TreasuryKey::Proposal(id))
        .unwrap_or_else(|| panic_with_error!(env, ThresholdError::ProposalNotFound))
}

fn store(env: &Env, proposal: &TreasuryProposal) {
    let key = TreasuryKey::Proposal(proposal.id);
    env.storage().persistent().set(&key, proposal);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
}

/// Refuses an executed, expired or stale (pre-rotation) proposal.
fn require_live(env: &Env, cfg: &TreasuryConfig, proposal: &TreasuryProposal) {
    if proposal.executed {
        panic_with_error!(env, ThresholdError::ProposalAlreadyExecuted);
    }
    if env.ledger().timestamp() >= proposal.expires_at {
        panic_with_error!(env, ThresholdError::ProposalExpired);
    }
    if proposal.config_version != cfg.version {
        panic_with_error!(env, ThresholdError::StaleSignerSet);
    }
}

fn required_approvals(cfg: &TreasuryConfig, action: &TreasuryAction) -> u32 {
    match action {
        TreasuryAction::Spend(_, _, amount) if *amount > cfg.large_amount => cfg.large_threshold,
        _ => cfg.threshold,
    }
}

#[contractimpl]
impl ThresholdCrypto {
    /// Sets up the treasury signer set once. The DKG admin authorizes it.
    pub fn treasury_init(
        env: Env,
        signers: Vec<Address>,
        threshold: u32,
        large_amount: i128,
        large_threshold: u32,
    ) {
        let admin = Self::get_config(env.clone()).admin;
        admin.require_auth();
        if env.storage().instance().has(&TreasuryKey::Config) {
            panic_with_error!(&env, ThresholdError::AlreadyInitialized);
        }
        validate(&env, &signers, threshold, large_amount, large_threshold);
        let cfg = TreasuryConfig {
            signers,
            threshold,
            large_amount,
            large_threshold,
            version: 1,
        };
        env.storage().instance().set(&TreasuryKey::Config, &cfg);
        env.storage().instance().set(&TreasuryKey::NextId, &1u64);
    }

    pub fn treasury_config(env: Env) -> TreasuryConfig {
        config(&env)
    }

    /// Opens a proposal; returns its id (the nonce its approvals bind to).
    pub fn treasury_propose(
        env: Env,
        proposer: Address,
        action: TreasuryAction,
        expires_at: u64,
    ) -> u64 {
        proposer.require_auth();
        let cfg = config(&env);
        require_signer(&env, &cfg, &proposer);
        let now = env.ledger().timestamp();
        if expires_at <= now || expires_at - now > MAX_PROPOSAL_LIFETIME {
            panic_with_error!(&env, ThresholdError::ProposalExpired);
        }
        match &action {
            TreasuryAction::Spend(_, _, amount) if *amount <= 0 => {
                panic_with_error!(&env, ThresholdError::InvalidAmount)
            }
            TreasuryAction::Rotate(signers, threshold, large_amount, large_threshold) => {
                validate(&env, signers, *threshold, *large_amount, *large_threshold)
            }
            _ => {}
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&TreasuryKey::NextId)
            .unwrap_or(1);
        env.storage()
            .instance()
            .set(&TreasuryKey::NextId, &(id + 1));
        let digest_input = TreasuryDigest {
            contract: env.current_contract_address(),
            nonce: id,
            config_version: cfg.version,
            action: action.clone(),
            expires_at,
        };
        let digest: BytesN<32> = env.crypto().sha256(&digest_input.to_xdr(&env)).into();
        store(
            &env,
            &TreasuryProposal {
                id,
                proposer: proposer.clone(),
                action,
                expires_at,
                config_version: cfg.version,
                digest: digest.clone(),
                approvals: Vec::new(&env),
                executed: false,
            },
        );
        TreasuryProposedEvent {
            id,
            proposer,
            digest,
            expires_at,
        }
        .publish(&env);
        id
    }

    pub fn treasury_proposal(env: Env, id: u64) -> TreasuryProposal {
        load(&env, id)
    }

    /// Records `signer`'s approval of proposal `id`. `digest` must be the
    /// proposal's digest, so the signature is bound to that exact action,
    /// nonce, signer set and expiry.
    pub fn treasury_approve(env: Env, signer: Address, id: u64, digest: BytesN<32>) -> u32 {
        signer.require_auth();
        let cfg = config(&env);
        require_signer(&env, &cfg, &signer);
        let mut proposal = load(&env, id);
        require_live(&env, &cfg, &proposal);
        if proposal.digest != digest {
            panic_with_error!(&env, ThresholdError::DigestMismatch);
        }
        if proposal.approvals.contains(&signer) {
            panic_with_error!(&env, ThresholdError::AlreadyApproved);
        }
        proposal.approvals.push_back(signer.clone());
        let approvals = proposal.approvals.len();
        store(&env, &proposal);
        TreasuryApprovedEvent {
            id,
            signer,
            approvals,
        }
        .publish(&env);
        approvals
    }

    /// Executes proposal `id` once it has the approvals its action needs.
    pub fn treasury_execute(env: Env, executor: Address, id: u64) {
        executor.require_auth();
        let cfg = config(&env);
        require_signer(&env, &cfg, &executor);
        let mut proposal = load(&env, id);
        require_live(&env, &cfg, &proposal);
        let approvals = proposal.approvals.len();
        if approvals < required_approvals(&cfg, &proposal.action) {
            panic_with_error!(&env, ThresholdError::InsufficientApprovals);
        }

        // Consume the nonce before any external call.
        proposal.executed = true;
        store(&env, &proposal);

        match proposal.action.clone() {
            TreasuryAction::Spend(token_id, to, amount) => {
                token::TokenClient::new(&env, &token_id).transfer(
                    &env.current_contract_address(),
                    &to,
                    &amount,
                );
                TreasurySpendExecutedEvent {
                    id,
                    token: token_id,
                    to,
                    amount,
                    approvals,
                }
                .publish(&env);
            }
            TreasuryAction::Rotate(signers, threshold, large_amount, large_threshold) => {
                let new_cfg = TreasuryConfig {
                    signers: signers.clone(),
                    threshold,
                    large_amount,
                    large_threshold,
                    version: cfg.version + 1,
                };
                env.storage().instance().set(&TreasuryKey::Config, &new_cfg);
                SignerSetRotatedEvent {
                    id,
                    old_version: cfg.version,
                    new_version: new_cfg.version,
                    signers,
                    threshold,
                    large_threshold,
                    approvals,
                }
                .publish(&env);
            }
        }
    }
}
