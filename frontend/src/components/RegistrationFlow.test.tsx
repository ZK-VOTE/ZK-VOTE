import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import RegistrationFlow from "./RegistrationFlow";

describe("RegistrationFlow", () => {
  it("renders nothing when idle", () => {
    const { container } = render(
      <RegistrationFlow registrationStatus={null} isRegistering={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("explains the wallet-signature credential model during step 1", () => {
    render(
      <RegistrationFlow
        registrationStatus="Step 1/2: Generating Secret"
        isRegistering={true}
      />,
    );
    expect(
      screen.getByText(/derived from your wallet's signature/),
    ).toBeInTheDocument();
  });

  it("does not show the dual-secret note once registration is complete", () => {
    render(
      <RegistrationFlow
        registrationStatus="Registration complete!"
        isRegistering={false}
      />,
    );
    expect(
      screen.queryByText(/derived from your wallet's signature/),
    ).not.toBeInTheDocument();
  });
});
