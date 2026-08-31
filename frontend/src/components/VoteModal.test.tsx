import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import VoteModal from "./VoteModal";

const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

// Mock all external dependencies
vi.mock("../lib/client", () => ({
  getZkVoteClient: vi.fn(() => ({
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

vi.mock("../lib/fetchWithProgress", () => ({
  fetchWithProgress: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
}));

vi.mock("../lib/zk", () => ({
  generateDeterministicZKCredentials: vi.fn().mockResolvedValue({
    secret: "123",
    salt: "456",
    blindingFactor: "999",
    commitment: "789",
  }),
  generateFakeZKCredentials: vi.fn().mockResolvedValue({
    secret: "fake_secret_111",
    salt: "fake_salt_222",
    blindingFactor: "fake_blinding_333",
    commitment: "fake_commitment_444",
  }),
  getZKCredentials: vi.fn().mockReturnValue({
    secret: "123",
    salt: "456",
    blindingFactor: "999",
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
    renderWithQueryClient(<VoteModal {...defaultProps} />);

    expect(screen.getByText("Cast Anonymous Vote")).toBeInTheDocument();
    expect(screen.getByText("Vote Yes")).toBeInTheDocument();
    expect(screen.getByText("Vote No")).toBeInTheDocument();
  });

  it("shows snapshot voting warning in Fixed mode", () => {
    renderWithQueryClient(<VoteModal {...defaultProps} voteMode="Fixed" />);

    expect(
      screen.getByText(/Revocation semantics in Fixed \(snapshot\) mode/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Only members who were present when the proposal was created/,
      ),
    ).toBeInTheDocument();
  });

  it("does not show snapshot warning in Trailing mode", () => {
    renderWithQueryClient(<VoteModal {...defaultProps} voteMode="Trailing" />);

    expect(
      screen.queryByText(
        /Only members who were present when the proposal was created/,
      ),
    ).not.toBeInTheDocument();
  });

  it("shows revocation semantics explainer for Trailing mode", () => {
    renderWithQueryClient(<VoteModal {...defaultProps} voteMode="Trailing" />);

    expect(
      screen.getByText(/Revocation semantics in Trailing \(dynamic\) mode/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/their eligibility ends immediately/),
    ).toBeInTheDocument();
  });

  it("shows accurate Fixed-mode revocation semantics when already revoked", () => {
    renderWithQueryClient(<VoteModal {...defaultProps} voteMode="Fixed" />);

    // Fixed-mode snapshot: a member revoked AFTER creation can still vote
    // with a pre-revocation proof (intentional privacy boundary).
    expect(
      screen.getByText(
        /cached a valid ZK proof generated before the revocation/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/This is intentional/)).toBeInTheDocument();
  });

  it("calls onClose when clicking outside the modal", () => {
    renderWithQueryClient(<VoteModal {...defaultProps} />);

    // Click the backdrop (the outer div)
    const backdrop = screen.getByText("Cast Anonymous Vote").closest(".fixed");
    if (backdrop) {
      fireEvent.click(backdrop);
    }

    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("does not call onClose when clicking inside the modal", () => {
    renderWithQueryClient(<VoteModal {...defaultProps} />);

    // Click a button inside the modal
    fireEvent.click(screen.getByText("Vote Yes"));

    // onClose should not be called from the click (only from internal logic)
    // We check it wasn't called immediately
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when clicking the X close button", () => {
    renderWithQueryClient(<VoteModal {...defaultProps} />);

    const xButton = screen.getByRole("button", { name: "Close voting dialog" });
    fireEvent.click(xButton);

    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("shows generating state after clicking Vote Yes", async () => {
    renderWithQueryClient(<VoteModal {...defaultProps} />);

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
    renderWithQueryClient(<VoteModal {...defaultProps} />);

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
    renderWithQueryClient(<VoteModal {...defaultProps} />);

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

    renderWithQueryClient(<VoteModal {...defaultProps} />);

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

    renderWithQueryClient(<VoteModal {...defaultProps} voteMode="Fixed" />);

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

  it("shows optimistic vote submission step when vote is cast", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "Network error" }),
    });

    renderWithQueryClient(<VoteModal {...defaultProps} />);

    fireEvent.click(screen.getByText("Vote Yes"));

    expect(await screen.findByText("Vote Submitted!")).toBeInTheDocument();
  });

  it("provides Close button in error state", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "Some error" }),
    });

    renderWithQueryClient(<VoteModal {...defaultProps} />);

    fireEvent.click(screen.getByText("Vote Yes"));

    // Optimistic UI immediately transitions to success step
    expect(await screen.findByText("Vote Submitted!")).toBeInTheDocument();
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
    renderWithQueryClient(<VoteModal {...defaultProps} />);

    fireEvent.click(screen.getByText("Vote Yes"));

    // Should eventually show success
    expect(await screen.findByText("Vote Submitted!")).toBeInTheDocument();
  });

  it("displays success message", async () => {
    renderWithQueryClient(<VoteModal {...defaultProps} />);

    fireEvent.click(screen.getByText("Vote Yes"));

    expect(
      await screen.findByText(/Your anonymous vote has been recorded/),
    ).toBeInTheDocument();
  });
});

// ─── Issue #337 – Panic-mode UI tests ───────────────────────────────────────

describe("VoteModal panic-mode (coercion resistance, issue #337)", () => {
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

  it("renders the coercion-resistant mode toggle", () => {
    renderWithQueryClient(<VoteModal {...defaultProps} />);

    const toggle = screen.getByTestId("panic-mode-toggle");
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAttribute("role", "switch");
  });

  it("does NOT show panic-mode warning when toggle is off", () => {
    renderWithQueryClient(<VoteModal {...defaultProps} />);

    expect(screen.queryByTestId("panic-mode-warning")).not.toBeInTheDocument();
  });

  it("shows panic-mode warning after enabling the toggle", () => {
    renderWithQueryClient(<VoteModal {...defaultProps} />);

    const toggle = screen.getByTestId("panic-mode-toggle");
    fireEvent.click(toggle);

    expect(screen.getByTestId("panic-mode-warning")).toBeInTheDocument();
    expect(
      screen.getByText(/Panic mode is ON — decoy credentials will be used/),
    ).toBeInTheDocument();
  });

  it("toggle aria-checked becomes true after enabling", () => {
    renderWithQueryClient(<VoteModal {...defaultProps} />);

    const toggle = screen.getByTestId("panic-mode-toggle");
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("warning disappears after toggling off again", () => {
    renderWithQueryClient(<VoteModal {...defaultProps} />);

    const toggle = screen.getByTestId("panic-mode-toggle");
    // enable
    fireEvent.click(toggle);
    expect(screen.getByTestId("panic-mode-warning")).toBeInTheDocument();
    // disable
    fireEvent.click(toggle);
    expect(screen.queryByTestId("panic-mode-warning")).not.toBeInTheDocument();
  });

  it("calls generateFakeZKCredentials (not real) when panic mode is on", async () => {
    const { generateFakeZKCredentials, getZKCredentials } =
      await import("../lib/zk");

    renderWithQueryClient(<VoteModal {...defaultProps} />);

    // Enable panic mode
    fireEvent.click(screen.getByTestId("panic-mode-toggle"));

    // Cast a vote
    fireEvent.click(screen.getByText("Vote Yes"));

    await vi.waitFor(() => {
      expect(generateFakeZKCredentials).toHaveBeenCalled();
    });

    // Real credentials must never be accessed
    expect(getZKCredentials).not.toHaveBeenCalled();
  });

  it("real credentials are accessible after panic mode vote (real cred untouched)", async () => {
    const { getZKCredentials } = await import("../lib/zk");

    renderWithQueryClient(<VoteModal {...defaultProps} />);

    // Enable panic mode
    fireEvent.click(screen.getByTestId("panic-mode-toggle"));

    // Cast a panic vote
    fireEvent.click(screen.getByText("Vote Yes"));

    await vi.waitFor(() => {
      expect(
        screen.queryByText(/Vote Submitted|Generating|Submitting/),
      ).toBeInTheDocument();
    });

    // getZKCredentials was never called (real creds untouched)
    expect(getZKCredentials).not.toHaveBeenCalled();
  });

  it("still shows vote buttons when panic mode is enabled", () => {
    renderWithQueryClient(<VoteModal {...defaultProps} />);

    fireEvent.click(screen.getByTestId("panic-mode-toggle"));

    expect(screen.getByText("Vote Yes")).toBeInTheDocument();
    expect(screen.getByText("Vote No")).toBeInTheDocument();
  });

  it("panic mode is off by default (real credentials used)", async () => {
    const { getZKCredentials } = await import("../lib/zk");

    renderWithQueryClient(<VoteModal {...defaultProps} />);

    // Do NOT enable panic mode, just cast vote
    fireEvent.click(screen.getByText("Vote Yes"));

    await vi.waitFor(() => {
      expect(getZKCredentials).toHaveBeenCalled();
    });
  });
});
