//! Typed contract events emitted by the voting contract.
//!
//! Invariants:
//! - Each struct name is part of the public contract spec and is used as the
//!   event's first topic by `#[contractevent]`. Names are never renamed.
//! - Fields marked `#[topic]` form the indexed topic list in declaration
//!   order; their order and types are ABI-stable.
//! - Moving these definitions to this module does not change emitted XDR:
//!   `#[contractevent]` derives the spec name from the Rust identifier.

#[allow(unused_imports)]
use soroban_sdk::{Address, BytesN, String, Symbol, U256};

// Typed Events
#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VKSetEvent {
    #[topic]
    pub dao_id: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ProposalEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub title: String,
    pub content_cid: String,
    pub creator: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ProposalClosedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub closed_by: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ProposalArchivedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub archived_by: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VoteEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub choice: bool,
    pub nullifier: U256,
}

/// Emitted once per successful batch, alongside the per-vote `VoteEvent`s.
/// Indexers can use it to tell a batched submission from a run of single votes.
#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VoteBatchEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub votes: u32,
    pub yes_votes: u32,
    pub no_votes: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct AtRiskVoterAlert {
    #[topic]
    pub dao_id: u64,
    pub at_risk_root: U256,
    pub proposal_id: u64,
    pub deadline: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractUpgraded {
    pub from: u32,
    pub to: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct StorageMigratedEvent {
    pub from_version: u32,
    pub to_version: u32,
    pub storage_version: u32,
    pub payload_hash: BytesN<32>,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractRollbackEvent {
    pub from: u32,
    pub to: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractPausedEvent {
    pub guardian: Address,
    pub paused_at: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct RandomnessCommittedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub participant: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractUnpausedEvent {
    pub guardian: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct RandomnessRevealedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub participant: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct CandidateSeedFinalizedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub seed: BytesN<32>,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct QvVoteEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub nullifier: U256,
    pub total_credits_spent: u64,
}

// ── Sybil-resistance layer (#301) ──────────────────────────────────────────

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct WeightedVoteEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub choice: bool,
    pub weight: u32,
    pub nullifier: U256,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct SybilWeightCapSetEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub cap: u32,
}

// ── VDF-gated commit–reveal (#302) ─────────────────────────────────────────

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VoteCommittedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub nullifier: U256,
    pub commit_index: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VoteRevealedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub nullifier: U256,
    pub choice: bool,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct CommitRevealConfiguredEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub commit_deadline: u64,
    pub reveal_opens_at: u64,
}

// ── Anonymous delegation (#304) ────────────────────────────────────────────

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct DelegationRegisteredEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub delegation_commitment: U256,
    pub delegate_tag: U256,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct DelegatedVoteEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub choice: bool,
    pub delegation_nullifier: U256,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct DelegationRevokedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub delegation_commitment: U256,
    pub reclaim_nullifier: U256,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VdfSubmittedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub output: BytesN<32>,
    pub delay: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct RecursiveTallySubmittedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub num_votes: u64,
    pub yes_votes: u64,
    pub no_votes: u64,
    pub final_nullifier_acc: U256,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct QvTallyEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub round_id: u64,
    pub ballots: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VdfVerifiedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub verified: bool,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ElectionStatusChangedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub old_state: Symbol,
    pub new_state: Symbol,
    pub old_root: U256,
    pub new_root: U256,
    pub updated_at: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::Env;

    #[test]
    fn event_field_shapes_are_stable() {
        let e = VKSetEvent { dao_id: 7 };
        assert_eq!(e.dao_id, 7);
        let env = Env::default();
        let v = VoteEvent {
            dao_id: 1,
            proposal_id: 2,
            choice: true,
            nullifier: U256::from_u32(&env, 3),
        };
        assert!(v.choice);
        assert_eq!(v.proposal_id, 2);
    }
}
