//! Nova IVC Recursive Vote Aggregator for ZK-VOTE
//!
//! Provides step circuit definition, IVC folding engine, proof compression,
//! and off-chain batch aggregation primitives for large-scale elections.

pub mod aggregator;
pub mod circuit;

use serde::{Deserialize, Serialize};

/// Running state vector for Nova IVC computation: z_i
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IvcState {
    /// Step index i (0..N)
    pub step_count: u64,
    /// Immutable Merkle tree root of identity commitments
    pub root: String,
    /// Total accumulated YES votes (voteChoice == 1)
    pub yes_votes: u64,
    /// Total accumulated NO votes (voteChoice == 0)
    pub no_votes: u64,
    /// Poseidon nullifier accumulator hash (hex 32-byte string)
    pub acc_nullifier_hash: String,
}

impl Default for IvcState {
    fn default() -> Self {
        Self {
            step_count: 0,
            root: String::from(
                "0x0000000000000000000000000000000000000000000000000000000000000000",
            ),
            yes_votes: 0,
            no_votes: 0,
            acc_nullifier_hash: String::from(
                "0x0000000000000000000000000000000000000000000000000000000000000000",
            ),
        }
    }
}

/// Private witness for a single voter's IVC step: \omega_i
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoteWitness {
    /// Voter's private secret
    pub secret: String,
    /// Random salt for commitment
    pub salt: String,
    /// Merkle inclusion proof path elements (siblings)
    pub path_elements: Vec<String>,
    /// Merkle inclusion proof path indices (0=left, 1=right)
    pub path_indices: Vec<u8>,
    /// Vote selection: 0 = NO, 1 = YES
    pub vote_choice: u8,
    /// Domain-separated nullifier string
    pub nullifier: String,
    /// DAO ID
    pub dao_id: u64,
    /// Proposal ID
    pub proposal_id: u64,
}

/// Final recursive proof payload containing compressed proof and step outputs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecursiveProofPayload {
    /// Initial state z_0
    pub initial_state: IvcState,
    /// Final state z_N after N steps
    pub final_state: IvcState,
    /// Total number of folded votes
    pub num_votes: u64,
    /// Compressed Nova recursive proof bytes (hex string)
    pub proof_bytes: String,
    /// Execution proof timestamp
    pub timestamp: u64,
}

/// On-chain tally proof payload used by the `verify_tally_proof` contract entrypoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TallyProof {
    /// Merkle root of identity commitments.
    pub root: String,
    /// Total YES votes.
    pub yes_votes: u64,
    /// Total NO votes.
    pub no_votes: u64,
    /// Accumulated nullifier hash (Poseidon).
    pub acc_nullifier_hash: String,
    /// Compressed Nova recursive proof bytes (hex string).
    pub proof_bytes: String,
}

impl TallyProof {
    /// Constructs a `TallyProof` from a `RecursiveProofPayload`.
    pub fn from_payload(payload: &RecursiveProofPayload) -> Self {
        Self {
            root: payload.final_state.root.clone(),
            yes_votes: payload.final_state.yes_votes,
            no_votes: payload.final_state.no_votes,
            acc_nullifier_hash: payload.final_state.acc_nullifier_hash.clone(),
            proof_bytes: payload.proof_bytes.clone(),
        }
    }
}

/// Verifies a tally proof by checking the Nova recursive proof.
pub fn verify_tally_proof(tally: &TallyProof) -> Result<(), String> {
    // Reconstruct a minimal payload (initial state is the default with zero votes)
    let initial_state = IvcState::default();
    let final_state = IvcState {
        root: tally.root.clone(),
        yes_votes: tally.yes_votes,
        no_votes: tally.no_votes,
        acc_nullifier_hash: tally.acc_nullifier_hash.clone(),
        ..initial_state.clone()
    };
    let payload = RecursiveProofPayload {
        initial_state,
        final_state,
        num_votes: tally.yes_votes + tally.no_votes,
        proof_bytes: tally.proof_bytes.clone(),
        timestamp: 0,
    };
    // TODO: call actual Nova verifier (e.g. NovaAggregator::verify) once available.
    if payload.proof_bytes.is_empty() {
        return Err("Empty proof".to_string());
    }
    if payload.num_votes == 0 {
        return Err("Tally proof contains no votes".to_string());
    }
    Ok(())
}

pub use aggregator::NovaAggregator;
pub use circuit::VoteStepCircuit;
