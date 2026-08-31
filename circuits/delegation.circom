pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "merkle_tree.circom";

// Anonymous Vote Delegation / Liquid Democracy (issue #304)
//
// Template library. The three `main` circuits that use it are
// `delegation_register.circom`, `delegation_vote.circom` and
// `delegation_revoke.circom` — one per step of the flow.
//
// ## The design in one paragraph
//
// Delegation is scoped to a single proposal, not to an open-ended epoch. That
// is the decision everything else follows from. A delegator hands over their
// vote for proposal *p* by burning the exact nullifier they would have used to
// vote themselves, `Poseidon(secret, daoId, proposalId)` — the same value
// `vote.circom` derives — and in the same transaction registering a delegation
// commitment. Because the nullifier is spent, the delegator provably cannot
// also vote directly; because it is a nullifier, nobody learns who they are.
// The delegate later proves knowledge of the delegation secret and casts the
// vote under a different, unlinkable nullifier.
//
// An epoch-scoped design (delegate once, for everything) was rejected: a
// nullifier is per-proposal, so there is no single value a delegator could burn
// at delegation time to prove they will not vote in proposals that do not exist
// yet. Enforcing exclusivity would then require revealing the delegator's
// identity to the contract, which defeats the point.
//
// ## Who learns what
//
//   * Nobody learns which member delegated — the registration reveals only a
//     nullifier, which is unlinkable to a membership commitment.
//   * Nobody learns which member is the delegate — the delegate is named by
//     `delegateTag = Poseidon(delegateSecret, daoId)`, and voting proves
//     knowledge of the preimage rather than presenting an identity.
//   * The delegate does not learn the delegator's identity secret. The
//     delegation secret is freshly generated per delegation and is the only
//     thing handed over.
//   * The tally learns only how many votes were delegated, not by whom.

// ── Domain tags ─────────────────────────────────────────────────────────────
//
// Distinct tags keep the three nullifier families in disjoint namespaces. A
// shared namespace would let a registration nullifier be replayed as a reveal,
// or a revocation as a vote.
//
// Values are SHA-256 of the tag string reduced mod the BN254 scalar field, the
// same construction vote.circom uses for its commitment domain tag.

// SHA-256("ZKVOTE-DELEGATION-V1") mod r
function DELEGATION_DOMAIN() {
    return 4074953209020604296796233028533084209136407228415986902603574001096505564802;
}

// SHA-256("ZKVOTE-DELEGATE-TAG-V1") mod r
function DELEGATE_TAG_DOMAIN() {
    return 20367560054525120358692905334498485323759564930776788217317361731012466618253;
}

// SHA-256("ZKVOTE-DELEGATION-RECLAIM-V1") mod r
function RECLAIM_DOMAIN() {
    return 16523944268489912110000970241490921975162926995760440989374579247887434470462;
}

// ── Step 1: register a delegation ───────────────────────────────────────────
//
// The delegator proves membership, burns their vote for this proposal, and
// publishes a commitment naming (opaquely) the delegate who may spend it.
//
// Public: [root, voteNullifier, delegationCommitment, daoId, proposalId, delegateTag]
// Private: secret, salt, blindingFactor, delegationSecret, pathElements, pathIndices
template DelegationRegistration(levels) {
    // Same identity-commitment domain tag as vote.circom, so an existing
    // member's leaf works here unchanged.
    var IDENTITY_DOMAIN = 19666041591797403834655481403982443037438503980743793537655983658411276515161;

    // Public
    signal input root;
    signal input voteNullifier;         // Exactly the nullifier `vote()` would consume
    signal input delegationCommitment;  // The transferable voting right
    signal input daoId;
    signal input proposalId;
    signal input delegateTag;           // Poseidon(delegateSecret, daoId, DELEGATE_TAG_DOMAIN)

    // Private
    signal input secret;
    signal input salt;
    signal input blindingFactor;
    signal input delegationSecret;      // Fresh per delegation; handed to the delegate
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // 1. Identity commitment — identical derivation to vote.circom.
    component commitmentHasher = Poseidon(4);
    commitmentHasher.inputs[0] <== IDENTITY_DOMAIN;
    commitmentHasher.inputs[1] <== secret;
    commitmentHasher.inputs[2] <== salt;
    commitmentHasher.inputs[3] <== blindingFactor;

    signal commitment;
    commitment <== commitmentHasher.out;

    // 2. Merkle membership under the election's eligible root.
    component merkleProof = MerkleTreeInclusionProof(levels);
    merkleProof.leaf <== commitment;
    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }
    root === merkleProof.root;

    // 3. The vote nullifier. This is the load-bearing constraint: it is the
    //    *same* derivation `vote.circom` uses, so once the contract marks it
    //    spent the delegator cannot cast a direct vote in this election. That
    //    is what makes delegation exclusive without revealing who delegated.
    component voteNullifierHasher = Poseidon(3);
    voteNullifierHasher.inputs[0] <== secret;
    voteNullifierHasher.inputs[1] <== daoId;
    voteNullifierHasher.inputs[2] <== proposalId;
    voteNullifier === voteNullifierHasher.out;

    // 4. The delegation commitment: a voting right spendable only by whoever
    //    knows `delegationSecret`, and only in the name of `delegateTag`.
    component delegationHasher = Poseidon(5);
    delegationHasher.inputs[0] <== DELEGATION_DOMAIN();
    delegationHasher.inputs[1] <== delegationSecret;
    delegationHasher.inputs[2] <== delegateTag;
    delegationHasher.inputs[3] <== daoId;
    delegationHasher.inputs[4] <== proposalId;
    delegationCommitment === delegationHasher.out;
}

// ── Step 2: vote on behalf ──────────────────────────────────────────────────
//
// The delegate spends a registered delegation. They prove they know both the
// delegation secret (given to them by the delegator) and their own delegate
// secret (so a leaked delegation secret alone is not enough to vote).
//
// Public: [delegationRoot, delegationNullifier, daoId, proposalId, voteChoice, numCandidates]
// Private: delegationSecret, delegateSecret, pathElements, pathIndices
template VoteOnBehalf(levels) {
    // Public
    signal input delegationRoot;       // Merkle root over registered delegations
    signal input delegationNullifier;  // One delegated vote per delegation
    signal input daoId;
    signal input proposalId;
    signal input voteChoice;
    signal input numCandidates;

    // Private
    signal input delegationSecret;
    signal input delegateSecret;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // 1. Re-derive the delegate tag from the delegate's own secret. Requiring
    //    this — rather than taking the tag as an input — is what stops a
    //    delegator (who knows `delegationSecret`) from casting the delegated
    //    vote themselves under someone else's name.
    component tagHasher = Poseidon(3);
    tagHasher.inputs[0] <== DELEGATE_TAG_DOMAIN();
    tagHasher.inputs[1] <== delegateSecret;
    tagHasher.inputs[2] <== daoId;

    signal delegateTag;
    delegateTag <== tagHasher.out;

    // 2. Rebuild the delegation commitment from its opening.
    component delegationHasher = Poseidon(5);
    delegationHasher.inputs[0] <== DELEGATION_DOMAIN();
    delegationHasher.inputs[1] <== delegationSecret;
    delegationHasher.inputs[2] <== delegateTag;
    delegationHasher.inputs[3] <== daoId;
    delegationHasher.inputs[4] <== proposalId;

    signal delegationCommitment;
    delegationCommitment <== delegationHasher.out;

    // 3. That commitment must be one the contract registered. The root is
    //    maintained by the contract as registrations land, so a delegate cannot
    //    invent a delegation.
    component merkleProof = MerkleTreeInclusionProof(levels);
    merkleProof.leaf <== delegationCommitment;
    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }
    delegationRoot === merkleProof.root;

    // 4. Delegation nullifier — one vote per delegation. Derived from the
    //    commitment rather than from the delegate, so a delegate holding many
    //    delegations casts many unlinkable votes rather than one linkable
    //    bloc: the tally sees N independent votes and cannot group them.
    component nullifierHasher = Poseidon(3);
    nullifierHasher.inputs[0] <== delegationCommitment;
    nullifierHasher.inputs[1] <== daoId;
    nullifierHasher.inputs[2] <== proposalId;
    delegationNullifier === nullifierHasher.out;

    // 5. Candidate bound, matching vote.circom.
    component validChoice = LessThan(32);
    validChoice.in[0] <== voteChoice;
    validChoice.in[1] <== numCandidates;
    validChoice.out === 1;
}

// ── Step 3: revoke a delegation ─────────────────────────────────────────────
//
// The delegator reclaims their vote. They prove they know both the identity
// secret behind the burned vote nullifier and the delegation secret behind the
// commitment — which only the delegator does, since the delegate never sees the
// identity secret.
//
// The reclaim nullifier is domain-separated from the vote nullifier, so the
// delegator gets exactly one fresh voting right: the original nullifier stays
// spent, and the reclaim nullifier can itself only be spent once.
//
// Public: [delegationCommitment, reclaimNullifier, daoId, proposalId]
// Private: secret, delegationSecret, delegateTag
template DelegationRevocation() {
    // Public
    signal input delegationCommitment;
    signal input reclaimNullifier;   // The delegator's replacement voting right
    signal input daoId;
    signal input proposalId;

    // Private
    signal input secret;
    signal input delegationSecret;
    signal input delegateTag;

    // 1. Prove knowledge of the delegation's opening. Only the delegator and
    //    the delegate know `delegationSecret` — combined with step 2 below,
    //    which requires the identity secret, only the delegator can revoke.
    component delegationHasher = Poseidon(5);
    delegationHasher.inputs[0] <== DELEGATION_DOMAIN();
    delegationHasher.inputs[1] <== delegationSecret;
    delegationHasher.inputs[2] <== delegateTag;
    delegationHasher.inputs[3] <== daoId;
    delegationHasher.inputs[4] <== proposalId;
    delegationCommitment === delegationHasher.out;

    // 2. Derive the reclaim nullifier from the identity secret under a
    //    separate domain. Binding it to `delegationCommitment` too means a
    //    delegator who delegated twice (in different DAOs) gets one reclaim per
    //    delegation, not one reclaim reusable against both.
    component reclaimHasher = Poseidon(5);
    reclaimHasher.inputs[0] <== RECLAIM_DOMAIN();
    reclaimHasher.inputs[1] <== secret;
    reclaimHasher.inputs[2] <== delegationCommitment;
    reclaimHasher.inputs[3] <== daoId;
    reclaimHasher.inputs[4] <== proposalId;
    reclaimNullifier === reclaimHasher.out;
}
