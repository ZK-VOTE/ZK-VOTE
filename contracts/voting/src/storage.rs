//! Nullifier storage helpers with election domain separation.
//!
//! ## Issue #64 — Nullifier Domain Separation Across Elections
//!
//! Nullifiers must never live in a flat global map such as
//! `NullifierUsed(nullifier_hash)`. A global namespace allows:
//! - Cross-election denial-of-service (submit election A's nullifier into B)
//! - Incorrectly blocking a voter when two elections collide on a hash
//!
//! In ZKVote, an **election** is identified by `(dao_id, proposal_id)`.
//! Storage is therefore:
//!
//! ```text
//! DataKey::Nullifier(dao_id, proposal_id, nullifier)  // scoped = NullifierUsed(election, n)
//! ```
//!
//! The circuit binds the same identifiers:
//! `nullifier = Poseidon(secret, daoId, proposalId)`, and `vote` verifies
//! those values as public inputs on-chain.
//!
//! `DataKey::LegacyNullifierUsed(nullifier)` exists only so admins can migrate
//! any pre-scoping global entries into the election-scoped format via
//! `VotingContract::migrate_nullifier`.
//!
//! ## Issue #672 — one key, one storage class
//!
//! This module builds the key but deliberately does not touch it: which storage
//! class a nullifier record lives in is decided in exactly two places,
//! `VotingContract::nullifier_is_used` and `VotingContract::consume_nullifier`,
//! and nothing else in the crate may read or write a `DataKey::Nullifier`
//! directly.
//!
//! That restriction is the fix. The seven vote-casting entrypoints each used to
//! open-code their own `has`/`set` against whichever class they happened to
//! write to, the classes disagreed, and the readers disagreed with each other,
//! so the same nullifier could be spent once through `vote` (Temporary) and
//! again through `vote_sybil_weighted` or `commit_vote` (Persistent) — two
//! head-count votes, and on the sybil path two weighted tallies, from one
//! identity. Routing every entrypoint through one pair of helpers makes a
//! storage-class disagreement unrepresentable rather than something a reviewer
//! has to notice in eight places.

use crate::DataKey;
use soroban_sdk::U256;

/// Election-scoped nullifier key: `NullifierUsed(election_id, nullifier)` where
/// `election_id = (dao_id, proposal_id)`.
///
/// Build the key with this, then read and write it with
/// `VotingContract::nullifier_is_used` / `VotingContract::consume_nullifier`.
#[inline(always)]
pub fn nullifier_used_key(dao_id: u64, proposal_id: u64, nullifier: U256) -> DataKey {
    DataKey::Nullifier(dao_id, proposal_id, nullifier)
}

/// Legacy flat nullifier key (global namespace). Used only during migration.
#[inline(always)]
pub fn legacy_nullifier_used_key(nullifier: U256) -> DataKey {
    DataKey::LegacyNullifierUsed(nullifier)
}
