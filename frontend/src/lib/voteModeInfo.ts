/**
 * Vote-mode copy + helpers (issue #347)
 *
 * Single source of truth for the Fixed/Trailing vote-mode copy shown to
 * users. The revocation semantics text below mirrors
 * `THREAT_MODEL.md` → "Fixed Mode Revocation Semantics (Intentional Behavior)"
 * so the UI, tests, and the threat model can never drift apart.
 */

export type VoteMode = "fixed" | "trailing";
export type VoteModeLabel = "Fixed" | "Trailing";

export const VOTE_MODE_LABELS: Record<VoteMode, VoteModeLabel> = {
  fixed: "Fixed",
  trailing: "Trailing",
};

/** Normalize the case-sensitive label used by the contracts/API to the picker type. */
export function normalizeVoteMode(mode: VoteMode | VoteModeLabel): VoteMode {
  return mode.toLowerCase() === "trailing" ? "trailing" : "fixed";
}

export interface VoteModeExplainer {
  mode: VoteMode;
  /** Heading shown in the explainer card. */
  title: string;
  /** One-line summary of who can vote in this mode. */
  whoCanVote: string;
  /** What happens to a revoked member. */
  revocation: string;
  /** Why the behavior exists (privacy / revocation trade-offs). */
  rationale: string;
}

export const VOTE_MODE_EXPLAINERS: Record<VoteMode, VoteModeExplainer> = {
  fixed: {
    mode: "fixed",
    title: "Revocation semantics in Fixed (snapshot) mode",
    whoCanVote:
      "Only members who were present when the proposal was created (the snapshotted eligible root) can vote.",
    revocation:
      "If a member is revoked (SBT burned / commitment removed from the tree) AFTER a Fixed-mode proposal was created, they can still vote on it — provided they cached a valid ZK proof generated before the revocation and their nullifier is unused. The proof must use the proposal's eligible_root.",
    rationale:
      "This is intentional: if revoked members could not vote on already-open proposals, an admin could infer who has and hasn't voted by timing revocations. The snapshot provides a consistent, privacy-preserving eligibility boundary.",
  },
  trailing: {
    mode: "trailing",
    title: "Revocation semantics in Trailing (dynamic) mode",
    whoCanVote:
      "Members can vote even if they joined after the proposal was created; the contract checks the root at which each member was added (min_root).",
    revocation:
      "If a member is revoked, their eligibility ends immediately. They can no longer vote — including on proposals created before the revocation — because their min_root is invalidated when they are removed from the tree.",
    rationale:
      "Trailing mode gives stronger revocation guarantees at the cost of some privacy: an admin can remove a member's voting power mid-proposal and influence the outcome.",
  },
};

/** Returns the explainer copy for a given mode (accepts either casing). */
export function getVoteModeExplainer(
  mode: VoteMode | VoteModeLabel,
): VoteModeExplainer {
  return VOTE_MODE_EXPLAINERS[normalizeVoteMode(mode)];
}

export type EligibilityStatus =
  | "eligible"
  | "not_member"
  | "unregistered"
  | "closed"
  | "already_voted";

export interface EligibilityInput {
  hasMembership: boolean;
  isRegistered: boolean;
  hasVoted: boolean;
  /** Whether the proposal is still open (not past the deadline). */
  isOpen: boolean;
}

/**
 * Classifies a voter's eligibility for a proposal using only facts the
 * frontend already knows (membership SBT, registration credentials, vote
 * history, deadline). Order matters: an already-voted member is *not*
 * "eligible" even if everything else lines up.
 */
export function getEligibilityStatus(
  input: EligibilityInput,
): EligibilityStatus {
  if (input.hasVoted) return "already_voted";
  if (!input.hasMembership) return "not_member";
  if (!input.isOpen) return "closed";
  if (!input.isRegistered) return "unregistered";
  return "eligible";
}

export interface EligibilityMessage {
  title: string;
  description: string;
  tone: "success" | "warning" | "error" | "neutral";
}

/**
 * Human-readable eligibility summary. Includes a mode-specific hint so the
 * user understands *why* their status is what it is for a Fixed vs Trailing
 * proposal.
 */
export function getEligibilityMessage(
  mode: VoteMode | VoteModeLabel,
  input: EligibilityInput,
): EligibilityMessage {
  const normalized = normalizeVoteMode(mode);
  const explainer = VOTE_MODE_EXPLAINERS[normalized];
  const status = getEligibilityStatus(input);

  switch (status) {
    case "eligible":
      return {
        title: "You are eligible to vote",
        description:
          normalized === "fixed"
            ? "You were present at the snapshot and have voting credentials. Cast your anonymous vote."
            : "You are a current member with voting credentials. Cast your anonymous vote.",
        tone: "success",
      };
    case "not_member":
      return {
        title: "Not a DAO member",
        description:
          "Join the DAO first to be considered for eligibility. Membership is required before you can register for voting.",
        tone: "error",
      };
    case "unregistered":
      return {
        title: "Registered membership required",
        description:
          "You are a member but haven't registered voting credentials for this DAO yet. Register for voting, then come back to vote.",
        tone: "warning",
      };
    case "closed":
      return {
        title: "Voting has closed",
        description:
          "This proposal's deadline has passed, so no further votes can be cast.",
        tone: "neutral",
      };
    case "already_voted":
      return {
        title: "You have already voted",
        description:
          "Each member can vote once per proposal. You can still view the results or claim your reward.",
        tone: "neutral",
      };
    default:
      return {
        title: "Eligibility unknown",
        description: explainer.whoCanVote,
        tone: "neutral",
      };
  }
}
