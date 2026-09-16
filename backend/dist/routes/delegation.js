/**
 * Anonymous Delegation Routes (issue #304)
 *
 * Derivation helpers and tally aggregation for liquid democracy. Secrets are
 * accepted as decimal field elements and are never persisted or logged — the
 * relay computes a commitment and forgets it, exactly as it does for the
 * quadratic-voting helpers in `quadratic.ts`.
 *
 *   POST /delegation/tag             derive a delegate's public tag
 *   POST /delegation/register        build the registration payload
 *   POST /delegation/vote            build the vote-on-behalf payload
 *   POST /delegation/revoke          build the revocation payload
 *   POST /delegation/tally           aggregate a tally including delegations
 *   POST /delegation/concentration   report delegate concentration
 */
import { Router } from "express";
import { z } from "zod";
import { log } from "../services/logger.js";
import { queryLimiter, voteLimiter, validateBody, bodyLimit, } from "../middleware/index.js";
import { deriveDelegateTag, buildDelegationRegistration, buildVoteOnBehalf, buildRevocation, tallyWithDelegations, delegationConcentration, BN254_SCALAR_FIELD, } from "../services/delegation.js";
const router = Router();
/**
 * A field element as a decimal string.
 *
 * Validated against the BN254 modulus here rather than only inside Poseidon,
 * so an out-of-range value is a 400 with a clear message instead of a 500 from
 * deep in the hash.
 */
const fieldElement = z
    .string()
    .regex(/^\d+$/, "must be a decimal field element")
    .refine((v) => BigInt(v) < BN254_SCALAR_FIELD, {
    message: "value must be less than the BN254 scalar field modulus",
});
const tagSchema = z.object({
    delegateSecret: fieldElement,
    daoId: z.number().int().nonnegative(),
});
const registerSchema = z.object({
    secret: fieldElement,
    salt: fieldElement,
    blindingFactor: fieldElement,
    delegationSecret: fieldElement,
    delegateTag: fieldElement,
    daoId: z.number().int().nonnegative(),
    proposalId: z.number().int().nonnegative(),
});
const voteSchema = z.object({
    delegationSecret: fieldElement,
    delegateSecret: fieldElement,
    daoId: z.number().int().nonnegative(),
    proposalId: z.number().int().nonnegative(),
    voteChoice: z.number().int().min(0).max(65_535),
});
const revokeSchema = z.object({
    secret: fieldElement,
    delegationSecret: fieldElement,
    delegateTag: fieldElement,
    daoId: z.number().int().nonnegative(),
    proposalId: z.number().int().nonnegative(),
});
const tallySchema = z.object({
    ballots: z
        .array(z.object({
        choice: z.number().int().min(0).max(65_535),
        source: z.enum(["direct", "delegated", "reclaimed"]),
        weight: z.number().int().min(1).max(10).optional(),
    }))
        .min(1)
        .max(10_000),
});
const concentrationSchema = z.object({
    holdings: z
        .array(z.object({
        delegateTag: fieldElement,
        delegationCount: z.number().int().min(0),
    }))
        .min(1)
        .max(1_000),
    totalEligible: z.number().int().positive(),
});
/**
 * POST /delegation/tag
 * Derive the public tag a delegate publishes so members can delegate to them.
 */
router.post("/delegation/tag", bodyLimit("10kb"), queryLimiter, validateBody(tagSchema), (async (req, res) => {
    const { delegateSecret, daoId } = req.body;
    const tag = await deriveDelegateTag(BigInt(delegateSecret), daoId);
    log("info", "delegation_tag_derived", { daoId });
    return res.json({ delegateTag: tag.toString(), daoId });
}));
/**
 * POST /delegation/register
 * Build the public signals for a delegation registration.
 *
 * The returned `voteNullifier` is the same value a direct vote would consume —
 * once the registration lands, the delegator can no longer vote directly, which
 * is what makes the delegation exclusive.
 */
router.post("/delegation/register", bodyLimit("10kb"), voteLimiter, validateBody(registerSchema), (async (req, res) => {
    const body = req.body;
    const payload = await buildDelegationRegistration({
        secret: BigInt(body.secret),
        salt: BigInt(body.salt),
        blindingFactor: BigInt(body.blindingFactor),
        delegationSecret: BigInt(body.delegationSecret),
        delegateTag: BigInt(body.delegateTag),
        daoId: body.daoId,
        proposalId: body.proposalId,
    });
    return res.json({
        ...payload,
        note: "voteNullifier is the same nullifier a direct vote would spend. Once " +
            "registered, this member cannot also vote directly on this proposal.",
    });
}));
/**
 * POST /delegation/vote
 * Build the public signals for a vote cast on a delegator's behalf.
 */
router.post("/delegation/vote", bodyLimit("10kb"), voteLimiter, validateBody(voteSchema), (async (req, res) => {
    const body = req.body;
    const payload = await buildVoteOnBehalf({
        delegationSecret: BigInt(body.delegationSecret),
        delegateSecret: BigInt(body.delegateSecret),
        daoId: body.daoId,
        proposalId: body.proposalId,
        voteChoice: body.voteChoice,
    });
    log("info", "delegation_vote_built", {
        daoId: body.daoId,
        proposalId: body.proposalId,
    });
    return res.json(payload);
}));
/**
 * POST /delegation/revoke
 * Build the public signals for revoking a delegation and reclaiming the vote.
 */
router.post("/delegation/revoke", bodyLimit("10kb"), voteLimiter, validateBody(revokeSchema), (async (req, res) => {
    const body = req.body;
    const payload = await buildRevocation({
        secret: BigInt(body.secret),
        delegationSecret: BigInt(body.delegationSecret),
        delegateTag: BigInt(body.delegateTag),
        daoId: body.daoId,
        proposalId: body.proposalId,
    });
    log("info", "delegation_revoke_built", {
        daoId: body.daoId,
        proposalId: body.proposalId,
    });
    return res.json({
        ...payload,
        note: "reclaimNullifier is a fresh, domain-separated voting right. The " +
            "original vote nullifier stays spent.",
    });
}));
/**
 * POST /delegation/tally
 * Aggregate a tally including delegated ballots, with provenance broken out.
 */
router.post("/delegation/tally", bodyLimit("1mb"), queryLimiter, validateBody(tallySchema), (async (req, res) => {
    const { ballots } = req.body;
    const result = tallyWithDelegations(ballots);
    log("info", "delegation_tally", {
        totalVotes: result.totalVotes,
        delegationRate: result.delegationRate,
    });
    return res.json(result);
}));
/**
 * POST /delegation/concentration
 * Report how concentrated delegation holdings are.
 *
 * Liquid democracy's characteristic failure is concentration, not Sybil. The
 * chain cannot measure it — delegated votes are unlinkable by construction — so
 * this works from delegates' self-reported holdings and is a monitoring aid,
 * not an enforcement mechanism.
 */
router.post("/delegation/concentration", bodyLimit("100kb"), queryLimiter, validateBody(concentrationSchema), (async (req, res) => {
    const { holdings, totalEligible } = req.body;
    const ranked = delegationConcentration(holdings, totalEligible);
    const topShare = ranked[0]?.share ?? 0;
    return res.json({
        totalEligible,
        delegates: ranked,
        topDelegateShare: topShare,
        concentrationWarning: topShare > 0.33,
    });
}));
export default router;
//# sourceMappingURL=delegation.js.map