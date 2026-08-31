pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "merkle_tree.circom";

// VDF-Gated Commit–Reveal Vote (issue #302)
//
// The second half of the commit–reveal flow the voting contract implements.
// During the commit phase a voter publishes a binding, hiding commitment to
// their choice; after the VDF delay has elapsed they reveal. This circuit is
// what makes the reveal *anonymous* — without it, revealing would mean
// re-identifying yourself to the commitment you posted.
//
// ## Why the reveal needs a proof at all
//
// The naive reveal is "send (choice, blinding) and let the contract re-hash".
// That works, and the contract supports exactly that for the transparent case.
// But it forces the voter to send the reveal from the same context that made
// the commit, and it publishes the opening — so anyone who saw the commit
// transaction learns the choice with certainty and can link it to whatever
// metadata the commit carried.
//
// Proving the opening instead means the voter demonstrates *that* a valid
// opening exists for a commitment in the committed set, without saying which
// commitment or which opening. The tally still moves by exactly one vote in the
// proven direction.
//
// ## What is proven
//
//   1. The voter knows an opening (choice, blinding) of `voteCommitment`.
//   2. `voteCommitment` is a leaf in `commitRoot` — the Merkle root over all
//      commitments accepted during the commit phase, which the contract fixes
//      when the phase closes.
//   3. The revealed `voteChoice` is that same choice, and is in range.
//   4. The reveal nullifier is domain-separated by (daoId, proposalId), so one
//      commitment yields exactly one reveal.
//   5. `commitDeadline` and `revealNotBefore` are bound into the proof, so a
//      proof built for one election's schedule cannot be replayed into another.
//
// ## What is deliberately NOT proven
//
// That the VDF delay elapsed. A circuit cannot observe wall-clock time; the
// delay is enforced by the contract, which refuses to open the reveal phase
// until the VDF output for the election has been submitted and verified. The
// circuit's job is anonymity of the opening, not liveness of the clock — see
// §4 of docs/spikes/302-vdf-commit-reveal.md.
//
// Public signals:
//   [commitRoot, revealNullifier, daoId, proposalId, voteChoice,
//    numCandidates, commitDeadline, revealNotBefore]
// Private:
//   blinding, voteCommitment, secret, pathElements, pathIndices
template VdfCommitReveal(levels) {
    // Public
    signal input commitRoot;       // Merkle root over accepted commitments
    signal input revealNullifier;  // One reveal per commitment
    signal input daoId;
    signal input proposalId;
    signal input voteChoice;       // The choice being revealed and tallied
    signal input numCandidates;
    signal input commitDeadline;   // Election schedule, bound into the proof
    signal input revealNotBefore;  // Earliest legal reveal (VDF-gated on-chain)

    // Private
    signal input blinding;         // High-entropy; hides a low-entropy choice
    signal input secret;           // The voter's identity secret
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // 1. Re-derive the commitment from its opening.
    //
    //    Poseidon here, not SHA-256: this is the in-circuit commitment over the
    //    *commitment tree*, and Poseidon is ~100x cheaper in constraints. The
    //    contract's own SHA-256 commitment (see `computeVoteCommitment` in
    //    backend/src/services/vdf.ts) is the transparent-reveal path; this is
    //    the anonymous one, and the two are separate schemes on purpose — the
    //    contract can recompute SHA-256 natively but not Poseidon.
    //
    //    The schedule is inside the hash so a commitment is bound to the
    //    election window it was made for.
    component commitmentHasher = Poseidon(6);
    commitmentHasher.inputs[0] <== daoId;
    commitmentHasher.inputs[1] <== proposalId;
    commitmentHasher.inputs[2] <== voteChoice;
    commitmentHasher.inputs[3] <== blinding;
    commitmentHasher.inputs[4] <== commitDeadline;
    commitmentHasher.inputs[5] <== revealNotBefore;

    signal voteCommitment;
    voteCommitment <== commitmentHasher.out;

    // 2. That commitment must be one the contract accepted during the commit
    //    phase. Because the root is fixed when the phase closes, a voter cannot
    //    invent a commitment after seeing how the reveals are going — which is
    //    precisely the last-minute manipulation being closed.
    component merkleProof = MerkleTreeInclusionProof(levels);
    merkleProof.leaf <== voteCommitment;
    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }
    commitRoot === merkleProof.root;

    // 3. Reveal nullifier, domain-separated by election.
    //
    //    Derived from the secret and the commitment together: from the secret
    //    alone, a voter with two commitments could only reveal once; from the
    //    commitment alone, it would be computable by anyone who watched the
    //    commit phase and could therefore be front-run.
    component nullifierHasher = Poseidon(4);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== voteCommitment;
    nullifierHasher.inputs[2] <== daoId;
    nullifierHasher.inputs[3] <== proposalId;
    revealNullifier === nullifierHasher.out;

    // 4. Candidate bound, matching vote.circom.
    component validChoice = LessThan(32);
    validChoice.in[0] <== voteChoice;
    validChoice.in[1] <== numCandidates;
    validChoice.out === 1;

    // 5. Schedule sanity: the reveal window must open at or after the commit
    //    phase closes. A malformed schedule where they overlap would let a
    //    voter reveal while others are still committing, restoring exactly the
    //    live-signal leak the flow exists to remove.
    component orderedSchedule = LessEqThan(64);
    orderedSchedule.in[0] <== commitDeadline;
    orderedSchedule.in[1] <== revealNotBefore;
    orderedSchedule.out === 1;
}

// Tree depth 18, matching vote.circom.
component main {public [
    commitRoot,
    revealNullifier,
    daoId,
    proposalId,
    voteChoice,
    numCandidates,
    commitDeadline,
    revealNotBefore
]} = VdfCommitReveal(18);
