import { describe, it, expect } from "vitest";
import {
  getVoteModeExplainer,
  getEligibilityStatus,
  getEligibilityMessage,
  normalizeVoteMode,
  VOTE_MODE_LABELS,
  type EligibilityInput,
} from "./voteModeInfo";

describe("voteModeInfo", () => {
  describe("normalizeVoteMode", () => {
    it("accepts both label cases", () => {
      expect(normalizeVoteMode("Fixed")).toBe("fixed");
      expect(normalizeVoteMode("Trailing")).toBe("trailing");
      expect(normalizeVoteMode("fixed")).toBe("fixed");
      expect(normalizeVoteMode("trailing")).toBe("trailing");
    });
  });

  describe("getVoteModeExplainer (explainer accuracy vs THREAT_MODEL.md)", () => {
    it("Fixed mode: revoked-after-creation members can still vote with a cached pre-revocation proof", () => {
      const fixed = getVoteModeExplainer("fixed");

      expect(fixed.title).toMatch(/Fixed/);
      expect(fixed.whoCanVote).toMatch(/present when the proposal was created/);
      // THREAT_MODEL.md "Fixed Mode Revocation Semantics": a member revoked AFTER
      // proposal creation can still vote if they cached a proof before revocation.
      expect(fixed.revocation).toMatch(
        /cached a valid ZK proof generated before/,
      );
      expect(fixed.revocation).toMatch(/after/i);
      expect(fixed.rationale).toMatch(/intentional/);
      expect(fixed.rationale).toMatch(/timing revocations/);
    });

    it("Trailing mode: revoked members lose eligibility immediately via min_root", () => {
      const trailing = getVoteModeExplainer("trailing");

      expect(trailing.title).toMatch(/Trailing/);
      expect(trailing.whoCanVote).toMatch(
        /joined after the proposal was created/,
      );
      expect(trailing.whoCanVote).toMatch(/min_root/);
      // THREAT_MODEL.md: Trailing mode checks min_root so revoked members cannot
      // vote even on older proposals.
      expect(trailing.revocation).toMatch(/no longer vote/);
      expect(trailing.rationale).toMatch(/stronger revocation guarantees/);
    });

    it("is case-insensitive on the label input", () => {
      expect(getVoteModeExplainer("Fixed")).toEqual(
        getVoteModeExplainer("fixed"),
      );
    });
  });

  describe("getEligibilityStatus", () => {
    const base: EligibilityInput = {
      hasMembership: true,
      isRegistered: true,
      hasVoted: false,
      isOpen: true,
    };

    it("returns eligible when everything lines up", () => {
      expect(getEligibilityStatus(base)).toBe("eligible");
    });

    it("already_voted takes precedence over other facts", () => {
      expect(getEligibilityStatus({ ...base, hasVoted: true })).toBe(
        "already_voted",
      );
      expect(
        getEligibilityStatus({
          ...base,
          hasVoted: true,
          isOpen: false,
          isRegistered: false,
        }),
      ).toBe("already_voted");
    });

    it("returns not_member when user has no SBT", () => {
      expect(getEligibilityStatus({ ...base, hasMembership: false })).toBe(
        "not_member",
      );
    });

    it("returns closed before unregistered", () => {
      expect(getEligibilityStatus({ ...base, isOpen: false })).toBe("closed");
      expect(
        getEligibilityStatus({ ...base, isOpen: false, isRegistered: false }),
      ).toBe("closed");
    });

    it("returns unregistered for registered-less eligible member on open proposal", () => {
      expect(getEligibilityStatus({ ...base, isRegistered: false })).toBe(
        "unregistered",
      );
    });
  });

  describe("getEligibilityMessage", () => {
    const base: EligibilityInput = {
      hasMembership: true,
      isRegistered: true,
      hasVoted: false,
      isOpen: true,
    };

    it("labels Fixed-mode eligible voters against the snapshot", () => {
      const msg = getEligibilityMessage("Fixed", base);
      expect(msg.title).toMatch(/eligible to vote/);
      expect(msg.tone).toBe("success");
      expect(msg.description).toMatch(/snapshot/);
    });

    it("labels Trailing-mode eligible voters as current members", () => {
      const msg = getEligibilityMessage("trailing", base);
      expect(msg.title).toMatch(/eligible to vote/);
      expect(msg.description).toMatch(/current member/);
    });

    it("explains membership requirement", () => {
      const msg = getEligibilityMessage("Fixed", {
        ...base,
        hasMembership: false,
      });
      expect(msg.title).toMatch(/Not a DAO member/);
      expect(msg.tone).toBe("error");
    });

    it("explains registration requirement", () => {
      const msg = getEligibilityMessage("Fixed", {
        ...base,
        isRegistered: false,
      });
      expect(msg.title).toMatch(/Registered membership required/);
      expect(msg.tone).toBe("warning");
    });

    it("explains a closed proposal", () => {
      const msg = getEligibilityMessage("Fixed", { ...base, isOpen: false });
      expect(msg.title).toMatch(/Voting has closed/);
      expect(msg.tone).toBe("neutral");
    });

    it("explains an already-cast vote", () => {
      const msg = getEligibilityMessage("Fixed", { ...base, hasVoted: true });
      expect(msg.title).toMatch(/already voted/);
      expect(msg.tone).toBe("neutral");
    });
  });

  describe("VOTE_MODE_LABELS", () => {
    it("maps both modes to the contract label casing", () => {
      expect(VOTE_MODE_LABELS.fixed).toBe("Fixed");
      expect(VOTE_MODE_LABELS.trailing).toBe("Trailing");
    });
  });
});
