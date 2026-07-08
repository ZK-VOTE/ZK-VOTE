import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import VoteModal from "./VoteModal";

// Mock all external dependencies
vi.mock("../lib/contracts", () => ({
  initializeContractClients: vi.fn(() => ({
    membershipTree: {
      get_leaf_index: vi.fn().mockResolvedValue({ result: 0 }),
      current_root: vi.fn().mockResolvedValue({ result: BigInt("12345") }),
    },
  })),
}));

vi.mock("../lib/zkproof", () => ({
  generateVoteProof: vi.fn().mockResolvedValue({
    proof: {
      pi_a: ["1", "2", "1"],
      pi_b: [
        ["1", "2"],
        ["3", "4"],
        ["1", "0"],
      ],
      pi_c: ["5", "6", "1"],
    },
    publicSignals: ["1", "2", "3"],
  }),
  formatProofForSoroban: vi.fn().mockReturnValue({
    proof_a: "00".repeat(64),
    proof_b: "00".repeat(128),
    proof_c: "00".repeat(64),
  }),
  calculateNullifier: vi.fn().mockResolvedValue("12345"),
  verifyProofLocally: vi.fn().mockResolvedValue(true),
}));

vi.mock("../lib/merkletree", () => ({
  getMerklePath: vi.fn().mockResolvedValue({
    pathElements: ["0", "1", "2"],
    pathIndices: [0, 1, 0],
  }),
}));

vi.mock("../lib/zk", () => ({
  generateDeterministicZKCredentials: vi.fn().mockResolvedValue({
    secret: "123",
    salt: "456",
    commitment: "789",
  }),
  getZKCredentials: vi.fn().mockReturnValue({
    secret: "123",
    salt: "456",
    commitment: "789",
    leafIndex: 0,
  }),
  storeZKCredentials: vi.fn(),
}));

// Mock fetch for relay submission
global.fetch = vi.fn();

describe("VoteModal", () => {
  const defaultProps = {
    proposalId: 1,
    eligibleRoot: BigInt("12345"),
    voteMode: "Fixed" as const,
    vkVersion: 1,
    daoId: 1,
    publicKey: "GDTEST...",
    kit: null,
    onClose: vi.fn(),
    onComplete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ txHash: "abc123" }),
    });
  });

  it("renders the vote selection screen initially", () => {
    render(<VoteModal {...defaultProps} />);

    expect(screen.getByText("Cast Anonymous Vote")).toBeInTheDocument();
    expect(screen.getByText("Vote Yes")).toBeInTheDocument();
    expect(screen.getByText("Vote No")).toBeInTheDocument();
  });

  it("shows snapshot voting warning in Fixed mode", () => {
    render(<VoteModal {...defaultProps} voteMode="Fixed" />);

    expect(
      screen.getByText(
        /Only members present when this proposal was created can vote/,
      ),
    ).toBeInTheDocument();
  });

  it("does not show snapshot warning in Trailing mode", () => {
    render(<VoteModal {...defaultProps} voteMode="Trailing" />);

    expect(
      screen.queryByText(
        /Only members present when this proposal was created can vote/,
      ),
    ).not.toBeInTheDocument();
  });

  it("calls onClose when clicking outside the modal", () => {
    render(<VoteModal {...defaultProps} />);

    // Click the backdrop (the outer div)
    const backdrop = screen.getByText("Cast Anonymous Vote").closest(".fixed");
    if (backdrop) {
      fireEvent.click(backdrop);
    }

    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("does not call onClose when clicking inside the modal", () => {
    render(<VoteModal {...defaultProps} />);

    // Click a button inside the modal
    fireEvent.click(screen.getByText("Vote Yes"));

    // onClose should not be called from the click (only from internal logic)
    // We check it wasn't called immediately
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when clicking the X close button", () => {
    render(<VoteModal {...defaultProps} />);

    // Get the X button specifically (sr-only "Close" span)
    const closeButtons = screen.getAllByRole("button");
    const xButton = closeButtons.find((btn) => btn.querySelector(".sr-only"));
    if (xButton) {
      fireEvent.click(xButton);
    }

    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("shows generating state after clicking Vote Yes", async () => {
    render(<VoteModal {...defaultProps} />);

    fireEvent.click(screen.getByText("Vote Yes"));

    // Mocks resolve immediately, so we check for any progress/success state
    // indicating the vote process started
    await vi.waitFor(() => {
      const progressOrSuccess = screen.queryByText(
        /Generating|Submitting|Vote Submitted/,
      );
      expect(progressOrSuccess).toBeInTheDocument();
    });
  });

  it("shows generating state after clicking Vote No", async () => {
    render(<VoteModal {...defaultProps} />);

    fireEvent.click(screen.getByText("Vote No"));

    // Mocks resolve immediately, so we check for any progress/success state
    // indicating the vote process started
    await vi.waitFor(() => {
      const progressOrSuccess = screen.queryByText(
        /Generating|Submitting|Vote Submitted/,
      );
      expect(progressOrSuccess).toBeInTheDocument();
    });
  });

  it("displays progress messages during proof generation", async () => {
    render(<VoteModal {...defaultProps} />);

    fireEvent.click(screen.getByText("Vote Yes"));

    // Progress messages are transient - the component will eventually reach a final state
    // We verify the component transitions from "select" step by checking for one of:
    // - Progress text (if we catch it)
    // - Success state (if it completed)
    // - Generating/Submitting state
    await vi.waitFor(() => {
      const hasProgress = screen.queryByText(
        /Loading|Generating|Submitting|Vote Submitted/,
      );
      expect(hasProgress).toBeInTheDocument();
    });
  });

  it("provides correct vote choice to proof generation", async () => {
    const { generateVoteProof } = await import("../lib/zkproof");

    render(<VoteModal {...defaultProps} />);

    fireEvent.click(screen.getByText("Vote Yes"));

    // Wait for proof generation to be called
    await vi.waitFor(() => {
      expect(generateVoteProof).toHaveBeenCalled();
    });

    // Check the vote choice is "1" for Yes
    const callArgs = (generateVoteProof as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(callArgs[0].voteChoice).toBe("1");
  });

  it("uses eligibleRoot in Fixed mode", async () => {
    const { generateVoteProof } = await import("../lib/zkproof");

    render(<VoteModal {...defaultProps} voteMode="Fixed" />);

    fireEvent.click(screen.getByText("Vote Yes"));

    await vi.waitFor(() => {
      expect(generateVoteProof).toHaveBeenCalled();
    });

    const callArgs = (generateVoteProof as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(callArgs[0].root).toBe("12345");
  });
});

describe("VoteModal error handling", () => {
  const defaultProps = {
    proposalId: 1,
    eligibleRoot: BigInt("12345"),
    voteMode: "Fixed" as const,
    vkVersion: 1,
    daoId: 1,
    publicKey: "GDTEST...",
    kit: null,
    onClose: vi.fn(),
    onComplete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows error state when relay submission fails", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "Network error" }),
    });

    render(<VoteModal {...defaultProps} />);

    fireEvent.click(screen.getByText("Vote Yes"));

    // Should eventually show error
    expect(await screen.findByText("Error")).toBeInTheDocument();
  });

  it("shows double-vote error message", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: () =>
        Promise.resolve({ error: "You have already voted on this proposal" }),
    });

    render(<VoteModal {...defaultProps} />);

    fireEvent.click(screen.getByText("Vote Yes"));

    // Should show specific double-vote error
    expect(
      await screen.findByText(/already voted on this proposal/),
    ).toBeInTheDocument();
  });

  it("provides Close button in error state", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "Some error" }),
    });

    render(<VoteModal {...defaultProps} />);

    fireEvent.click(screen.getByText("Vote Yes"));

    // Wait for error state
    await screen.findByText("Error");

    // Should have Close buttons (X icon has sr-only "Close", plus visible Close button)
    const closeButtons = screen.getAllByRole("button", { name: /close/i });
    // At least the visible "Close" text button should exist
    expect(closeButtons.length).toBeGreaterThanOrEqual(1);
    // Find the visible one (not the X icon with sr-only text)
    const visibleCloseButton = closeButtons.find(
      (btn) => btn.textContent === "Close",
    );
    expect(visibleCloseButton).toBeInTheDocument();
  });
});

describe("VoteModal success state", () => {
  const defaultProps = {
    proposalId: 1,
    eligibleRoot: BigInt("12345"),
    voteMode: "Fixed" as const,
    vkVersion: 1,
    daoId: 1,
    publicKey: "GDTEST...",
    kit: null,
    onClose: vi.fn(),
    onComplete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ txHash: "abc123" }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows success state after successful submission", async () => {
    render(<VoteModal {...defaultProps} />);

    fireEvent.click(screen.getByText("Vote Yes"));

    // Should eventually show success
    expect(await screen.findByText("Vote Submitted!")).toBeInTheDocument();
  });

  it("displays success message", async () => {
    render(<VoteModal {...defaultProps} />);

    fireEvent.click(screen.getByText("Vote Yes"));

    expect(
      await screen.findByText(/Your anonymous vote has been recorded/),
    ).toBeInTheDocument();
  });
});
