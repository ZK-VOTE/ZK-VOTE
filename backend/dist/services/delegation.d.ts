/**
 * Anonymous Vote Delegation / Liquid Democracy (issue #304)
 *
 * The off-chain half of the delegation flow: deriving the commitments and
 * nullifiers that `circuits/delegation.circom` constrains, and aggregating a
 * tally that accounts for delegated votes.
 *
 * Everything here mirrors the circuit exactly — same Poseidon arities, same
 * input order, same domain tags — so a value computed by the relay and a value
 * derived inside a proof are the same field element. Where they disagree, the
 * proof simply fails to verify, which is the failure mode you want, but the
 * mirror is asserted directly in `backend/test/delegation.test.ts`.
 *
 * ## Flow
 *
 *   1. `delegate` — the delegator burns their vote nullifier for one proposal
 *      and registers a delegation commitment naming a delegate tag. Because the
 *      nullifier is the same one `vote()` would consume, delegation is
 *      exclusive: the delegator provably cannot also vote directly.
 *   2. `voteOnBehalf` — the delegate proves knowledge of the delegation secret
 *      *and* their own delegate secret, and casts a vote under an unlinkable
 *      delegation nullifier.
 *   3. `revoke` — the delegator proves knowledge of both the identity secret
 *      and the delegation secret, invalidating the delegation and minting a
 *      domain-separated reclaim nullifier they can vote with directly.
 *
 * Delegation is per-proposal rather than per-epoch. See the header of
 * `circuits/delegation.circom` for why an epoch-scoped design cannot enforce
 * exclusivity without revealing the delegator.
 */
/** SHA-256("ZKVOTE-DELEGATION-V1") mod r */
export declare const DELEGATION_DOMAIN = 4074953209020604296796233028533084209136407228415986902603574001096505564802n;
/** SHA-256("ZKVOTE-DELEGATE-TAG-V1") mod r */
export declare const DELEGATE_TAG_DOMAIN = 20367560054525120358692905334498485323759564930776788217317361731012466618253n;
/** SHA-256("ZKVOTE-DELEGATION-RECLAIM-V1") mod r */
export declare const RECLAIM_DOMAIN = 16523944268489912110000970241490921975162926995760440989374579247887434470462n;
/** Identity-commitment domain tag, shared with vote.circom. */
export declare const IDENTITY_DOMAIN = 19666041591797403834655481403982443037438503980743793537655983658411276515161n;
/** BN254 scalar field modulus. */
export declare const BN254_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/**
 * The delegate's public handle: `Poseidon(DELEGATE_TAG_DOMAIN, delegateSecret, daoId)`.
 *
 * A delegate publishes this so delegators can name them, and proves knowledge
 * of the preimage when voting. It is per-DAO, so the same person acting as a
 * delegate in two DAOs presents two unlinkable tags.
 */
export declare function deriveDelegateTag(delegateSecret: bigint, daoId: number | bigint): Promise<bigint>;
/**
 * The delegator's vote nullifier — the *same* derivation `vote.circom` uses.
 *
 * Registering a delegation spends this, which is what makes delegation
 * exclusive: the contract's nullifier set cannot tell a delegation apart from a
 * direct vote, so having delegated, the member cannot vote again.
 */
export declare function deriveVoteNullifier(secret: bigint, daoId: number | bigint, proposalId: number | bigint): Promise<bigint>;
/** The transferable voting right. */
export declare function deriveDelegationCommitment(delegationSecret: bigint, delegateTag: bigint, daoId: number | bigint, proposalId: number | bigint): Promise<bigint>;
/**
 * One delegated vote per delegation.
 *
 * Derived from the commitment rather than from the delegate, so a delegate
 * holding many delegations casts many *unlinkable* votes: the tally sees N
 * independent votes and cannot group them into a bloc.
 */
export declare function deriveDelegationNullifier(delegationCommitment: bigint, daoId: number | bigint, proposalId: number | bigint): Promise<bigint>;
/**
 * The delegator's replacement voting right after revoking.
 *
 * Domain-separated from the vote nullifier, so the original stays spent (the
 * delegation cannot be un-spent) while the delegator still gets exactly one
 * fresh chance to vote. Bound to the specific delegation commitment, so someone
 * who delegated twice gets one reclaim each rather than one reusable reclaim.
 */
export declare function deriveReclaimNullifier(secret: bigint, delegationCommitment: bigint, daoId: number | bigint, proposalId: number | bigint): Promise<bigint>;
/** The membership-tree leaf, shared with vote.circom. */
export declare function deriveIdentityCommitment(secret: bigint, salt: bigint, blindingFactor: bigint): Promise<bigint>;
export interface DelegationRegistrationInputs {
    secret: bigint;
    salt: bigint;
    blindingFactor: bigint;
    delegationSecret: bigint;
    delegateTag: bigint;
    daoId: number;
    proposalId: number;
}
export interface DelegationRegistrationPublic {
    voteNullifier: string;
    delegationCommitment: string;
    delegateTag: string;
    daoId: number;
    proposalId: number;
}
/**
 * Everything the registration transaction publishes.
 *
 * The Merkle root and path come from the caller's membership proof, so they are
 * not derived here — this function's job is the values the circuit's public
 * signals must equal.
 */
export declare function buildDelegationRegistration(inputs: DelegationRegistrationInputs): Promise<DelegationRegistrationPublic>;
export interface VoteOnBehalfPublic {
    delegationCommitment: string;
    delegationNullifier: string;
    daoId: number;
    proposalId: number;
    voteChoice: number;
}
/** Everything the vote-on-behalf transaction publishes. */
export declare function buildVoteOnBehalf(params: {
    delegationSecret: bigint;
    delegateSecret: bigint;
    daoId: number;
    proposalId: number;
    voteChoice: number;
}): Promise<VoteOnBehalfPublic>;
export interface RevocationPublic {
    delegationCommitment: string;
    reclaimNullifier: string;
    daoId: number;
    proposalId: number;
}
/** Everything the revocation transaction publishes. */
export declare function buildRevocation(params: {
    secret: bigint;
    delegationSecret: bigint;
    delegateTag: bigint;
    daoId: number;
    proposalId: number;
}): Promise<RevocationPublic>;
export interface TallyBallot {
    choice: number;
    /** How the ballot reached the tally. */
    source: "direct" | "delegated" | "reclaimed";
    /** Weight the ballot carries. 1 for one-member-one-vote; the Sybil-bounded
     *  weight from issue #301 when weighted voting is enabled. */
    weight?: number;
}
export interface DelegatedTally {
    perChoice: Array<{
        choice: number;
        votes: number;
        weight: number;
    }>;
    totalVotes: number;
    totalWeight: number;
    directVotes: number;
    delegatedVotes: number;
    reclaimedVotes: number;
    /** Share of total weight cast by delegates. */
    delegationRate: number;
}
/**
 * Aggregate a tally that includes delegated ballots.
 *
 * Delegated votes count exactly like direct votes — a delegated vote *is* the
 * delegator's vote, cast by someone else — so they are summed into the same
 * per-choice totals. What is tracked separately is provenance, because a DAO
 * that cannot see how much of its turnout was delegated cannot notice a
 * delegate accumulating disproportionate influence.
 *
 * Reclaimed votes are counted as direct in the per-choice totals but reported
 * separately, since a spike in reclaims is a signal about delegate behaviour.
 */
export declare function tallyWithDelegations(ballots: TallyBallot[]): DelegatedTally;
/**
 * Detect delegates holding a concentrated share of the vote.
 *
 * Liquid democracy's characteristic failure is not Sybil but *concentration*: a
 * handful of delegates quietly accumulating a majority. The chain cannot see
 * this — delegated votes are unlinkable by construction — but delegates
 * publish their own tags, so a DAO can measure concentration from
 * self-reported holdings and act on it in policy. Reporting is the honest
 * mitigation here; enforcing a cap on-chain would require exactly the linkage
 * the design removes.
 */
export declare function delegationConcentration(holdings: Array<{
    delegateTag: string;
    delegationCount: number;
}>, totalEligible: number): Array<{
    delegateTag: string;
    delegationCount: number;
    share: number;
}>;
//# sourceMappingURL=delegation.d.ts.map