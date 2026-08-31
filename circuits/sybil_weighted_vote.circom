pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "merkle_tree.circom";
include "range_proof.circom";
include "sybil_weight.circom";

// Sybil-Resistant Weighted Vote (issue #301)
//
// Proves, in zero knowledge, that a voter is an eligible member AND that the
// weight their vote carries is exactly what the Sybil-resistance curve says it
// should be, given the age of their membership SBT and their accrued
// reputation — without revealing either.
//
// ## Why the weight has to be in the proof
//
// The contract cannot compute the weight itself: `vote` is anonymous, so at the
// point of tallying there is no address to look up an SBT age or reputation
// score for. If the voter simply *asserted* a weight, the Sybil bound would be
// advisory — a fresh identity would claim weight 10 and the chain would have no
// way to contradict it. Putting the curve in the circuit makes the weight a
// consequence of committed facts rather than a claim.
//
// ## Where the committed facts come from
//
// The DAO's SBT contract issues an eligibility attestation per member:
//
//     attestationCommitment = Poseidon(daoId, subjectSecret, mintedAt, reputation, salt)
//
// and anchors it on-chain (the same shape as the cross-DAO attestation in
// `reputation_attestation.circom`). The circuit opens that commitment, so
// `mintedAt` and `reputation` are whatever the SBT contract attested — not
// whatever the voter would like them to be. Deliberately NOT folded into the
// membership-tree leaf: doing so would fork the leaf format and force a
// re-registration of every existing member.
//
// ## What is proven
//
//   1. Merkle membership of the identity commitment (unchanged from vote.circom).
//   2. The attestation commitment opens to (mintedAt, reputation) under a
//      secret the voter knows.
//   3. `ageDays` is the correct whole-day age at the public `snapshotTime`.
//   4. `voteWeight` equals SybilWeightCurve(ageDays, reputation) exactly.
//   5. The nullifier is domain-separated by (daoId, proposalId) — one weighted
//      vote per member per election.
//   6. `voteChoice < numCandidates`.
//
// Public signals (order must match the contract's `pub_signals` vector):
//   [root, nullifier, daoId, proposalId, voteChoice, numCandidates,
//    snapshotTime, attestationCommitment, voteWeight]
//
// Private: secret, salt, blindingFactor, subjectSecret, attestationSalt,
//          mintedAt, reputation, ageDays, pathElements, pathIndices
template SybilWeightedVote(levels) {
    // Same domain tag as vote.circom — the identity commitment scheme is
    // unchanged, so an existing member's leaf still verifies here.
    var DOMAIN_TAG = 19666041591797403834655481403982443037438503980743793537655983658411276515161;

    // Timestamps and reputation are bounded well under 2^32; 40 bits gives the
    // age comparison headroom for unix seconds (which need 31 bits today and
    // will need 32 after 2038) without paying for a full field-width compare.
    var TIME_BITS = 40;

    // Public inputs
    signal input root;
    signal input nullifier;
    signal input daoId;
    signal input proposalId;
    signal input voteChoice;
    signal input numCandidates;
    signal input snapshotTime;            // Election snapshot; age is measured at this instant
    signal input attestationCommitment;   // Anchored on-chain by the SBT contract
    signal input voteWeight;              // The weight the tally will apply

    // Private inputs
    signal input secret;
    signal input salt;
    signal input blindingFactor;
    signal input subjectSecret;           // Binds the attestation to this voter
    signal input attestationSalt;
    signal input mintedAt;                // Unix seconds, attested by the SBT contract
    signal input reputation;              // Attested reputation score
    signal input ageDays;                 // Witness: whole days between mintedAt and snapshotTime
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // 1. Identity commitment — identical to vote.circom so the same leaf works.
    component commitmentHasher = Poseidon(4);
    commitmentHasher.inputs[0] <== DOMAIN_TAG;
    commitmentHasher.inputs[1] <== secret;
    commitmentHasher.inputs[2] <== salt;
    commitmentHasher.inputs[3] <== blindingFactor;

    signal commitment;
    commitment <== commitmentHasher.out;

    // 2. Merkle inclusion of that commitment under the public root.
    component merkleProof = MerkleTreeInclusionProof(levels);
    merkleProof.leaf <== commitment;
    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }
    root === merkleProof.root;

    // 3. Open the SBT eligibility attestation. This is what pins mintedAt and
    //    reputation to values the DAO actually issued.
    component attestationHasher = Poseidon(5);
    attestationHasher.inputs[0] <== daoId;
    attestationHasher.inputs[1] <== subjectSecret;
    attestationHasher.inputs[2] <== mintedAt;
    attestationHasher.inputs[3] <== reputation;
    attestationHasher.inputs[4] <== attestationSalt;
    attestationCommitment === attestationHasher.out;

    // 4. Range-bound the curve inputs. SybilWeightCurve compares at 32 bits and
    //    is only exact on inputs that fit; an unbounded `reputation` could
    //    otherwise be chosen to alias past a threshold comparison.
    component repRange = RangeProof(32);
    repRange.in <== reputation;
    repRange.maxValue <== 10000;   // MAX_REPUTATION in membership-sbt

    component ageRange = RangeProof(32);
    ageRange.in <== ageDays;
    ageRange.maxValue <== 36500;   // 100 years — far beyond any real SBT

    // 5. Constrain ageDays to be the true whole-day age at the snapshot.
    component age = AgeInDays(TIME_BITS);
    age.mintedAt <== mintedAt;
    age.snapshotTime <== snapshotTime;
    age.ageDays <== ageDays;

    // 6. The weight is a consequence of (ageDays, reputation), not a claim.
    component curve = SybilWeightCurve();
    curve.ageDays <== ageDays;
    curve.reputation <== reputation;
    voteWeight === curve.weight;

    // 7. Nullifier: Poseidon(secret, daoId, proposalId) — same derivation as
    //    vote.circom, so a member cannot cast both a plain and a weighted vote
    //    in the same election (the contract stores one nullifier set).
    component nullifierHasher = Poseidon(3);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== daoId;
    nullifierHasher.inputs[2] <== proposalId;
    nullifier === nullifierHasher.out;

    // 8. Candidate bound.
    component validChoice = LessThan(32);
    validChoice.in[0] <== voteChoice;
    validChoice.in[1] <== numCandidates;
    validChoice.out === 1;
}

// Tree depth 18, matching vote.circom (~262K members).
component main {public [
    root,
    nullifier,
    daoId,
    proposalId,
    voteChoice,
    numCandidates,
    snapshotTime,
    attestationCommitment,
    voteWeight
]} = SybilWeightedVote(18);
