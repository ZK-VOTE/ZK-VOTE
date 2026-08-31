import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import VoteEligibilityPreview from "./VoteEligibilityPreview";

const baseProps = {
  voteMode: "Fixed" as const,
  hasMembership: true,
  isRegistered: true,
  hasVoted: false,
  isOpen: true,
};

describe("VoteEligibilityPreview (issue #347)", () => {
  it("shows an eligible state for a registered Fixed-mode voter", () => {
    render(<VoteEligibilityPreview {...baseProps} />);

    expect(screen.getByTestId("vote-eligibility-preview")).toBeInTheDocument();
    expect(screen.getByText("You are eligible to vote")).toBeInTheDocument();
    expect(screen.getByText(/Mode: Fixed/)).toBeInTheDocument();
  });

  it("shows an eligible state for a Trailing-mode current member", () => {
    render(<VoteEligibilityPreview {...baseProps} voteMode="Trailing" />);

    expect(screen.getByText("You are eligible to vote")).toBeInTheDocument();
    expect(screen.getByText(/Mode: Trailing/)).toBeInTheDocument();
  });

  it("reports non-members as ineligible", () => {
    render(<VoteEligibilityPreview {...baseProps} hasMembership={false} />);

    expect(screen.getByText("Not a DAO member")).toBeInTheDocument();
  });

  it("reports unregistered members who must register first", () => {
    render(<VoteEligibilityPreview {...baseProps} isRegistered={false} />);

    expect(
      screen.getByText("Registered membership required"),
    ).toBeInTheDocument();
  });

  it("reports a closed proposal", () => {
    render(<VoteEligibilityPreview {...baseProps} isOpen={false} />);

    expect(screen.getByText("Voting has closed")).toBeInTheDocument();
  });

  it("reports an already-cast vote", () => {
    render(<VoteEligibilityPreview {...baseProps} hasVoted />);

    expect(screen.getByText("You have already voted")).toBeInTheDocument();
  });
});
