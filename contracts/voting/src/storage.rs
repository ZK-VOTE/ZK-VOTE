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

use crate::DataKey;
use soroban_sdk::U256;

/// Election-scoped nullifier key: `NullifierUsed(election_id, nullifier)` where
/// `election_id = (dao_id, proposal_id)`.
#[inline(always)]
pub fn nullifier_used_key(dao_id: u64, proposal_id: u64, nullifier: U256) -> DataKey {
    DataKey::Nullifier(dao_id, proposal_id, nullifier)
}

/// Legacy flat nullifier key (global namespace). Used only during migration.
#[inline(always)]
pub fn legacy_nullifier_used_key(nullifier: U256) -> DataKey {
    DataKey::LegacyNullifierUsed(nullifier)
}
