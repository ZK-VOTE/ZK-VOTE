import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import VoteModeExplainer from "./VoteModeExplainer";

describe("VoteModeExplainer", () => {
  it("renders the Fixed-mode revocation explainer (issue #347)", () => {
    render(<VoteModeExplainer mode="fixed" />);

    expect(
      screen.getByRole("region", {
        name: /Revocation semantics in Fixed \(snapshot\) mode/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Only members who were present when the proposal was created/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /cached a valid ZK proof generated before the revocation/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/This is intentional/)).toBeInTheDocument();
  });

  it("renders the Trailing-mode revocation explainer", () => {
    render(<VoteModeExplainer mode="Trailing" />);

    expect(
      screen.getByRole("region", {
        name: /Revocation semantics in Trailing \(dynamic\) mode/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/their eligibility ends immediately/),
    ).toBeInTheDocument();
  });

  it("accepts lowercase picker-style mode values", () => {
    const { rerender } = render(<VoteModeExplainer mode="trailing" />);
    expect(
      screen.getByRole("region", {
        name: /Revocation semantics in Trailing/,
      }),
    ).toBeInTheDocument();

    rerender(<VoteModeExplainer mode="fixed" />);
    expect(
      screen.getByRole("region", {
        name: /Revocation semantics in Fixed/,
      }),
    ).toBeInTheDocument();
  });

  it("does not show the Fixed snapshot phrasing for Trailing mode", () => {
    render(<VoteModeExplainer mode="trailing" />);
    expect(
      screen.queryByText(
        /Only members who were present when the proposal was created/,
      ),
    ).not.toBeInTheDocument();
  });
});
