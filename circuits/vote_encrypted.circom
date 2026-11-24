pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "merkle_tree.circom";
include "elgamal.circom";

// Encrypted anonymous vote circuit.
//
// This is the privacy-preserving replacement for the plaintext `voteChoice`
// public signal in vote.circom / vote_v2.circom. The voter proves:
//
//   1. they know secret, salt and blindingFactor opening a membership leaf;
//   2. the leaf is included in the election Merkle root;
//   3. the nullifier is Poseidon(secret, daoId, proposalId);
//   4. the choice is a bit and the ElGamal ciphertext is a correct encryption
//      of (choice, 1 - choice) under the election public key;
//   5. the proof is bound to the registry epoch used to build the witness.
//
// Public signals (15):
//   [root, nullifier, daoId, proposalId, numCandidates, epoch,
//    publicKeyX, publicKeyY, c1X, c1Y, cYesX, cYesY, cNoX, cNoY,
//    relayerAddress]
//
// The plaintext choice is PRIVATE. It is only recoverable by the 2-of-3
// decryption ceremony after the proposal closes.
template VoteEncrypted(levels) {
    var DOMAIN_TAG = 19666041591797403834655481403982443037438503980743793537655983658411276515161;

    // Public
    signal input root;
    signal input nullifier;
    signal input daoId;
    signal input proposalId;
    signal input numCandidates;
    signal input epoch;
    signal input publicKey[2];
    signal input c1[2];
    signal input cYes[2];
    signal input cNo[2];
    signal input relayerAddress;

    // Private
    signal input voteChoice;
    signal input secret;
    signal input salt;
    signal input blindingFactor;
    signal input randomness;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // 1. Membership commitment.
    component commitmentHasher = Poseidon(4);
    commitmentHasher.inputs[0] <== DOMAIN_TAG;
    commitmentHasher.inputs[1] <== secret;
    commitmentHasher.inputs[2] <== salt;
    commitmentHasher.inputs[3] <== blindingFactor;
    signal commitment;
    commitment <== commitmentHasher.out;

    // 2. Merkle inclusion against the epoch-pinned root.
    component merkleProof = MerkleTreeInclusionProof(levels);
    merkleProof.leaf <== commitment;
    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }
    root === merkleProof.root;

    // 3. Election-scoped nullifier (same derivation as the plaintext circuit,
    // so both paths share one replay-protection set during migration).
    component nullifierHasher = Poseidon(3);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== daoId;
    nullifierHasher.inputs[2] <== proposalId;
    nullifier === nullifierHasher.out;

    // 4. Candidate bound. Encrypted tallies are yes/no only for now; allowing
    // numCandidates > 2 would make the two-ciphertext ballot ambiguous.
    component validChoice = LessThan(32);
    validChoice.in[0] <== voteChoice;
    validChoice.in[1] <== numCandidates;
    validChoice.out === 1;
    component twoCandidates = LessThan(32);
    twoCandidates.in[0] <== numCandidates;
    twoCandidates.in[1] <== 3;
    twoCandidates.out === 1;

    // 5. ElGamal ciphertext correctness. Vote choice stays private.
    component ballot = ElGamalBallot();
    ballot.vote <== voteChoice;
    ballot.randomness <== randomness;
    ballot.publicKey[0] <== publicKey[0];
    ballot.publicKey[1] <== publicKey[1];

    c1[0] === ballot.c1[0];
    c1[1] === ballot.c1[1];
    cYes[0] === ballot.cYes[0];
    cYes[1] === ballot.cYes[1];
    cNo[0] === ballot.cNo[0];
    cNo[1] === ballot.cNo[1];

    // 6. Epoch binding: the public epoch is part of the statement, so a proof
    // built for epoch N cannot be replayed as an epoch N+1 proof. The contract
    // additionally checks that the supplied root is the registry's epoch root
    // (or inside the documented grace window) and that the epoch is current.
    component epochHasher = Poseidon(5);
    epochHasher.inputs[0] <== secret;
    epochHasher.inputs[1] <== daoId;
    epochHasher.inputs[2] <== proposalId;
    epochHasher.inputs[3] <== epoch;
    epochHasher.inputs[4] <== relayerAddress;
    signal epochBinding;
    epochBinding <== epochHasher.out;
}

// Default tree depth of 18 (supports ~262K members).
component main {public [root, nullifier, daoId, proposalId, numCandidates, epoch,
    publicKey, c1, cYes, cNo, relayerAddress]} = VoteEncrypted(18);
