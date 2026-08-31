/**
 * DAO Multisig Management Component Tests
 *
 * Tests for DaoMultisigManagement component:
 * - Multisig configuration initialization
 * - Proposal creation and signing
 * - Proposal execution with threshold checks
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DaoMultisigManagement } from "../components/DaoMultisigManagement";

describe("DaoMultisigManagement Component", () => {
  const mockOnInitMultisig = jest.fn();
  const mockOnCreateProposal = jest.fn();
  const mockOnSignProposal = jest.fn();
  const mockOnExecuteProposal = jest.fn();

  const testSigners = [
    "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIAMDB7XCVQS5GUIDED2URXAE2S",
    "GBXVJAFZXYJ3JFAFZXYJ3JFAFZXYJ3JFAFZXYJ3JFAFZXYJ3JFAFZXYJ",
    "GDVVF5XSUMEWVXO3BG2PYVJZUGCZPHUVFIXZ2BG7SEIYK4QNQQVLYAY4",
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should render the component", () => {
    render(
      <DaoMultisigManagement
        daoId={1}
        onInitMultisig={mockOnInitMultisig}
        onCreateProposal={mockOnCreateProposal}
        onSignProposal={mockOnSignProposal}
        onExecuteProposal={mockOnExecuteProposal}
      />
    );

    expect(screen.getByText("DAO Multisig Management")).toBeInTheDocument();
    expect(screen.getByText("Configuration")).toBeInTheDocument();
    expect(screen.getByText("Proposals")).toBeInTheDocument();
  });

  describe("Configuration Tab", () => {
    it("should show signer input form initially", () => {
      render(
        <DaoMultisigManagement
          daoId={1}
          onInitMultisig={mockOnInitMultisig}
          onCreateProposal={mockOnCreateProposal}
          onSignProposal={mockOnSignProposal}
          onExecuteProposal={mockOnExecuteProposal}
        />
      );

      expect(screen.getByPlaceholderText("Signer address")).toBeInTheDocument();
      expect(screen.getByText("Add")).toBeInTheDocument();
      expect(screen.getByText("Initialize Multisig")).toBeInTheDocument();
    });

    it("should add and display signers", async () => {
      render(
        <DaoMultisigManagement
          daoId={1}
          onInitMultisig={mockOnInitMultisig}
          onCreateProposal={mockOnCreateProposal}
          onSignProposal={mockOnSignProposal}
          onExecuteProposal={mockOnExecuteProposal}
        />
      );

      const signerInput = screen.getByPlaceholderText("Signer address");
      const addButton = screen.getByText("Add");

      for (const signer of testSigners) {
        await userEvent.type(signerInput, signer);
        await userEvent.click(addButton);
      }

      await waitFor(() => {
        expect(screen.getByText(`Signers (${testSigners.length})`)).toBeInTheDocument();
      });

      for (const signer of testSigners) {
        expect(screen.getByText(signer.slice(0, 20))).toBeInTheDocument();
      }
    });

    it("should remove signers", async () => {
      render(
        <DaoMultisigManagement
          daoId={1}
          onInitMultisig={mockOnInitMultisig}
          onCreateProposal={mockOnCreateProposal}
          onSignProposal={mockOnSignProposal}
          onExecuteProposal={mockOnExecuteProposal}
        />
      );

      const signerInput = screen.getByPlaceholderText("Signer address");
      const addButton = screen.getByText("Add");

      // Add first signer
      await userEvent.type(signerInput, testSigners[0]);
      await userEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByText("Signers (1)")).toBeInTheDocument();
      });

      // Remove first signer
      const removeButton = screen.getByText("Remove");
      await userEvent.click(removeButton);

      await waitFor(() => {
        expect(screen.queryByText("Signers (1)")).not.toBeInTheDocument();
      });
    });

    it("should allow threshold configuration", async () => {
      render(
        <DaoMultisigManagement
          daoId={1}
          onInitMultisig={mockOnInitMultisig}
          onCreateProposal={mockOnCreateProposal}
          onSignProposal={mockOnSignProposal}
          onExecuteProposal={mockOnExecuteProposal}
        />
      );

      const signerInput = screen.getByPlaceholderText("Signer address");
      const addButton = screen.getByText("Add");

      // Add signers
      for (let i = 0; i < 3; i++) {
        await userEvent.type(signerInput, testSigners[i]);
        await userEvent.click(addButton);
      }

      await waitFor(() => {
        const thresholdInput = screen.getByRole("spinbutton") as HTMLInputElement;
        expect(thresholdInput.max).toBe("3");
      });
    });

    it("should initialize multisig with correct parameters", async () => {
      mockOnInitMultisig.mockResolvedValueOnce(undefined);

      render(
        <DaoMultisigManagement
          daoId={1}
          onInitMultisig={mockOnInitMultisig}
          onCreateProposal={mockOnCreateProposal}
          onSignProposal={mockOnSignProposal}
          onExecuteProposal={mockOnExecuteProposal}
        />
      );

      const signerInput = screen.getByPlaceholderText("Signer address");
      const addButton = screen.getByText("Add");

      // Add signers
      for (let i = 0; i < 3; i++) {
        await userEvent.type(signerInput, testSigners[i]);
        await userEvent.click(addButton);
      }

      // Set threshold to 2
      const thresholdInput = screen.getByRole("spinbutton") as HTMLInputElement;
      await userEvent.clear(thresholdInput);
      await userEvent.type(thresholdInput, "2");

      const submitButton = screen.getByText("Initialize Multisig");
      await userEvent.click(submitButton);

      await waitFor(() => {
        expect(mockOnInitMultisig).toHaveBeenCalledWith(testSigners, 2);
      });
    });
  });

  describe("Proposals Tab", () => {
    beforeEach(() => {
      render(
        <DaoMultisigManagement
          daoId={1}
          onInitMultisig={mockOnInitMultisig}
          onCreateProposal={mockOnCreateProposal}
          onSignProposal={mockOnSignProposal}
          onExecuteProposal={mockOnExecuteProposal}
        />
      );

      // Click Proposals tab
      const proposalsTab = screen.getAllByText("Proposals")[0];
      fireEvent.click(proposalsTab);
    });

    it("should show proposal creation form", async () => {
      await waitFor(() => {
        expect(screen.getByPlaceholderText("Proposal title")).toBeInTheDocument();
        expect(screen.getByPlaceholderText("Proposal description")).toBeInTheDocument();
        expect(screen.getByDisplayValue("Transfer Admin")).toBeInTheDocument();
      });
    });

    it("should create a proposal", async () => {
      mockOnCreateProposal.mockResolvedValueOnce({
        proposalId: 1,
        title: "Test Proposal",
        description: "Test",
        actionType: "TransferAdmin",
        proposer: testSigners[0],
        signatures: [testSigners[0]],
        executed: false,
      });

      await waitFor(() => {
        const titleInput = screen.getByPlaceholderText("Proposal title");
        expect(titleInput).toBeInTheDocument();
      });

      const titleInput = screen.getByPlaceholderText("Proposal title");
      const descriptionInput = screen.getByPlaceholderText("Proposal description");
      const submitButton = screen.getByText("Create Proposal");

      await userEvent.type(titleInput, "Test Proposal");
      await userEvent.type(descriptionInput, "Test Description");
      await userEvent.click(submitButton);

      await waitFor(() => {
        expect(mockOnCreateProposal).toHaveBeenCalled();
      });
    });

    it("should display created proposals", async () => {
      mockOnCreateProposal.mockResolvedValueOnce({
        proposalId: 1,
        title: "Test Proposal",
        description: "Test Description",
        actionType: "TransferAdmin",
        proposer: testSigners[0],
        signatures: [testSigners[0]],
        executed: false,
      });

      await waitFor(() => {
        const titleInput = screen.getByPlaceholderText("Proposal title");
        expect(titleInput).toBeInTheDocument();
      });

      const titleInput = screen.getByPlaceholderText("Proposal title");
      const submitButton = screen.getByText("Create Proposal");

      await userEvent.type(titleInput, "Test Proposal");
      await userEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText("Test Proposal")).toBeInTheDocument();
      });
    });

    it("should allow signing proposals", async () => {
      mockOnCreateProposal.mockResolvedValueOnce({
        proposalId: 1,
        title: "Test",
        description: "Test",
        actionType: "TransferAdmin",
        proposer: testSigners[0],
        signatures: [testSigners[0]],
        executed: false,
      });

      mockOnSignProposal.mockResolvedValueOnce(undefined);

      await waitFor(() => {
        const titleInput = screen.getByPlaceholderText("Proposal title");
        expect(titleInput).toBeInTheDocument();
      });

      const titleInput = screen.getByPlaceholderText("Proposal title");
      const submitButton = screen.getByText("Create Proposal");

      await userEvent.type(titleInput, "Test");
      await userEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText("Sign")).toBeInTheDocument();
      });

      const signButton = screen.getByText("Sign");
      await userEvent.click(signButton);

      await waitFor(() => {
        expect(mockOnSignProposal).toHaveBeenCalledWith(1);
      });
    });

    it("should require confirmation to execute proposal", async () => {
      window.confirm = jest.fn(() => true);
      mockOnExecuteProposal.mockResolvedValueOnce(undefined);

      // Mock proposal with enough signatures
      mockOnCreateProposal.mockResolvedValueOnce({
        proposalId: 1,
        title: "Test",
        description: "Test",
        actionType: "TransferAdmin",
        proposer: testSigners[0],
        signatures: [testSigners[0], testSigners[1]],
        executed: false,
      });

      await waitFor(() => {
        const titleInput = screen.getByPlaceholderText("Proposal title");
        expect(titleInput).toBeInTheDocument();
      });

      const titleInput = screen.getByPlaceholderText("Proposal title");
      const submitButton = screen.getByText("Create Proposal");

      await userEvent.type(titleInput, "Test");
      await userEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText("Execute")).toBeInTheDocument();
      });

      const executeButton = screen.getByText("Execute");
      await userEvent.click(executeButton);

      expect(window.confirm).toHaveBeenCalled();
    });
  });

  it("should show error when operations fail", () => {
    render(
      <DaoMultisigManagement
        daoId={1}
        onInitMultisig={mockOnInitMultisig}
        onCreateProposal={mockOnCreateProposal}
        onSignProposal={mockOnSignProposal}
        onExecuteProposal={mockOnExecuteProposal}
        error="Operation failed"
      />
    );

    expect(screen.getByText("Operation failed")).toBeInTheDocument();
  });

  it("should disable controls when loading", () => {
    render(
      <DaoMultisigManagement
        daoId={1}
        onInitMultisig={mockOnInitMultisig}
        onCreateProposal={mockOnCreateProposal}
        onSignProposal={mockOnSignProposal}
        onExecuteProposal={mockOnExecuteProposal}
        loading={true}
      />
    );

    const signerInput = screen.getByPlaceholderText("Signer address") as HTMLInputElement;
    expect(signerInput.disabled).toBe(true);

    const submitButton = screen.getByText("Initializing...") as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
  });
});
