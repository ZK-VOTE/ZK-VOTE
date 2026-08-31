import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import VoteModeSelector from "./VoteModeSelector";

describe("VoteModeSelector", () => {
  it("renders both vote mode options", () => {
    render(<VoteModeSelector value="fixed" onChange={vi.fn()} />);

    expect(screen.getByTestId("vote-mode-option-fixed")).toBeInTheDocument();
    expect(screen.getByTestId("vote-mode-option-trailing")).toBeInTheDocument();
    expect(screen.getByText("Fixed (Snapshot)")).toBeInTheDocument();
    expect(screen.getByText("Trailing (Dynamic)")).toBeInTheDocument();
  });

  it("marks the selected mode as checked", () => {
    render(<VoteModeSelector value="fixed" onChange={vi.fn()} />);

    const fixed = screen
      .getAllByRole("radio")
      .find((r) => r.getAttribute("value") === "fixed");
    const trailing = screen
      .getAllByRole("radio")
      .find((r) => r.getAttribute("value") === "trailing");
    expect(fixed).toBeChecked();
    expect(trailing).not.toBeChecked();
  });

  it("calls onChange when a mode is picked", () => {
    const onChange = vi.fn();
    render(<VoteModeSelector value="fixed" onChange={onChange} />);

    const trailing = screen
      .getAllByRole("radio")
      .find((r) => r.getAttribute("value") === "trailing");
    fireEvent.click(trailing!);

    expect(onChange).toHaveBeenCalledWith("trailing");
  });

  it("does not surface the revocation explainer by default", () => {
    render(<VoteModeSelector value="fixed" onChange={vi.fn()} />);
    expect(screen.queryByTestId("vote-mode-explainer")).not.toBeInTheDocument();
  });

  it("reveals the revocation explainer for the selected mode on demand (issue #347)", () => {
    render(<VoteModeSelector value="fixed" onChange={vi.fn()} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /How does revocation affect this mode\?/,
      }),
    );

    expect(
      screen.getByRole("region", { name: /Revocation semantics in Fixed/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Hide revocation details/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/cached a valid ZK proof generated before/),
    ).toBeInTheDocument();
  });

  it("toggles the explainer off and on", () => {
    render(<VoteModeSelector value="fixed" onChange={vi.fn()} />);

    fireEvent.click(
      screen.getByRole("button", { name: /How does revocation/ }),
    );
    expect(screen.getByTestId("vote-mode-explainer")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /Hide revocation details/ }),
    );
    expect(screen.queryByTestId("vote-mode-explainer")).not.toBeInTheDocument();
  });

  it("disables the mode inputs when disabled is set", () => {
    render(<VoteModeSelector value="fixed" onChange={vi.fn()} disabled />);
    screen.getAllByRole("radio").forEach((radio) => {
      expect(radio).toBeDisabled();
    });
  });
});
