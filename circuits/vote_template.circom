pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "merkle_tree.circom";

// DAO domain separation tag for commitment scheme
// SHA-256("ZK-VOTE-COMMITMENT") reduced mod BN254 scalar field
// Prevents cross-protocol attacks where commitments from other systems
// could be valid in ZK-VOTE

// DaoVote Anonymous Vote Circuit
//
// Proves:
// 1. Voter knows secret & salt that hash to a commitment (leaf) in the Merkle tree
// 2. Nullifier is correctly derived from secret, daoId, and proposalId (domain-separated)
// 3. Vote choice (candidate index) is within [0, numCandidates)
//
// Public signals: [root, nullifier, daoId, proposalId, voteChoice, numCandidates]
// Private signals: secret, salt, blindingFactor, pathElements, pathIndices
//
// PRIVACY: Commitment is NOT exposed publicly. Votes are fully unlinkable across proposals.
// Revocation is enforced via Merkle tree updates (zeroing leaves) rather than on-chain checks.
//
// SECURITY: numCandidates is a public input so the contract can verify the circuit enforced
// the same candidate bound that the election was configured with. Without this binding,
// a prover could supply a proof valid under one numCandidates value while the contract
// tallies using a different (potentially larger) count.
//
// #361 RELAYER BINDING — NOT IMPLEMENTED, DELIBERATELY
//
// A 7th public signal `relayerAddress` was added here at one point. It is
// removed, and the reason matters:
//
//   * A public signal binds nothing unless the verifier checks it. The relayer
//     cannot be checked: `Env::auths()` is `#[cfg(any(test,
//     feature = "testutils"))]` in soroban-sdk and there is no production
//     equivalent, because a Soroban contract cannot observe who invoked it.
//     So the signal was decorative.
//   * It was not merely decorative, it was destructive. With 7 public signals a
//     Groth16 verification key has 8 IC points, but the contract's
//     `VOTE_CIRCUIT_IC_LEN` and every call site still assumed 6/7. A key for
//     THIS circuit could never be registered (`validate_vk` rejects any other
//     IC length) and the checked-in 6-signal key could never verify — the
//     entire anonymous vote path was non-functional, while every test passed
//     because the tests build synthetic keys from the contract's own constant.
//     scripts/drift-guard.mjs now fails the build on any such disagreement.
//
// The enforceable form of relayer binding needs no new public signal: take the
// relayer as a call argument and `relayer.require_auth()`, which cryptographically
// proves that account submitted the transaction. See RELAYER_BINDING_DESIGN.md
// for that design and the front-running analysis that motivates it.
//
// The front-running risk that binding was meant to address is bounded today by
// the nullifier being single-use per election and the tally being additive;
// see THREAT_MODEL.md "Sybil bounds" and the anonymous-submission section.
template Vote(levels) {
    var DOMAIN_TAG = 19666041591797403834655481403982443037438503980743793537655983658411276515161;

    // Public inputs
    signal input root;              // Merkle tree root (verified on-chain)
    signal input nullifier;         // Prevents double voting (domain-separated)
    signal input daoId;             // DAO identifier (for domain separation)
    signal input proposalId;        // Which proposal this vote is for
    signal input voteChoice;        // Candidate index the voter selected
    signal input numCandidates;     // Total number of candidates (set by election config)

    // Private inputs
    signal input secret;            // Voter's secret (like password)
    signal input salt;              // Salt for commitment
    signal input blindingFactor;    // Random blinding factor for uniform distribution
    signal input pathElements[levels];  // Merkle proof siblings
    signal input pathIndices[levels];   // Merkle proof path (0=left, 1=right)

    // 1. Compute identity commitment: Poseidon(DOMAIN_TAG, secret, salt, blindingFactor)
    // Domain-separated commitment prevents cross-protocol attacks.
    // Blinding factor ensures uniform distribution across the field even
    // if secret and salt are correlated (e.g., derived from same wallet signature).
    // This is used as the leaf in the Merkle tree
    component commitmentHasher = Poseidon(4);
    commitmentHasher.inputs[0] <== DOMAIN_TAG;
    commitmentHasher.inputs[1] <== secret;
    commitmentHasher.inputs[2] <== salt;
    commitmentHasher.inputs[3] <== blindingFactor;

    // Commitment is computed internally (private) - not exposed as public signal
    signal commitment;
    commitment <== commitmentHasher.out;

    // 2. Verify Merkle tree inclusion
    component merkleProof = MerkleTreeInclusionProof(levels);
    merkleProof.leaf <== commitment;
    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }

    // Constrain computed root to match public root
    root === merkleProof.root;

    // 3. Compute nullifier: Poseidon(secret, daoId, proposalId)
    // Domain separation: includes daoId to prevent cross-DAO nullifier linkability
    // This ensures a voter can't be linked across DAOs even if reusing the same secret
    //
    // TODO(#531): Add epoch parameter to prevent nullifier collision when daoId is reused
    // after DAO deletion/recreation. Current formula assumes daoId never repeats.
    // Proposed fix: Poseidon(secret, daoId, epoch, proposalId) with epoch incremented
    // on DAO recreation. This is a BREAKING CHANGE requiring circuit recompilation,
    // new trusted setup, and contract migration. See ISSUE_531_NULLIFIER_EPOCH_ANALYSIS.md
    // for detailed migration strategy.
    component nullifierHasher = Poseidon(3);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== daoId;
    nullifierHasher.inputs[2] <== proposalId;

    // Constrain computed nullifier to match public nullifier
    nullifier === nullifierHasher.out;

    // 4. Verify candidate index is within bounds: voteChoice < numCandidates
    // Uses 32-bit LessThan comparator from circomlib.
    // This prevents a voter from proving a vote for a non-existent candidate.
    component validChoice = LessThan(32);
    validChoice.in[0] <== voteChoice;
    validChoice.in[1] <== numCandidates;
    validChoice.out === 1;
}
