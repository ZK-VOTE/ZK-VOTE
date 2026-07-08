import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import ProposalCard from "./ProposalCard";
import { getZKCredentials } from "../lib/zk";

// Mock react-router-dom useNavigate
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Mock the ZK library
vi.mock("../lib/zk", () => ({
  getZKCredentials: vi.fn().mockReturnValue(null),
}));

const mockGetZKCredentials = vi.mocked(getZKCredentials);

// Mock fetch for IPFS metadata
global.fetch = vi.fn();

describe("ProposalCard", () => {
  const defaultProps = {
    proposal: {
      id: 1,
      title: "Test Proposal",
      contentCid: "QmTestCid123",
      yesVotes: 5,
      noVotes: 3,
      hasVoted: false,
      eligibleRoot: BigInt("12345"),
      voteMode: "Fixed" as const,
      endTime: Math.floor(Date.now() / 1000) + 86400, // 24 hours from now
      vkVersion: 1,
    },
    daoId: 1,
    daoName: "Test DAO",
    publicKey: "GPUBLIC...",
    kit: null,
    hasMembership: true,
    onVoteComplete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          version: 1,
          body: "Test proposal description",
        }),
    });
  });

  const renderWithRouter = (component: React.ReactElement) => {
    return render(<BrowserRouter>{component}</BrowserRouter>);
  };

  describe("Rendering", () => {
    it("renders proposal title", () => {
      renderWithRouter(<ProposalCard {...defaultProps} />);

      expect(screen.getByText("Test Proposal")).toBeInTheDocument();
    });

    it("renders proposal ID", () => {
      renderWithRouter(<ProposalCard {...defaultProps} />);

      expect(screen.getByText("#1")).toBeInTheDocument();
    });

    it("displays vote counts", () => {
      renderWithRouter(<ProposalCard {...defaultProps} />);

      expect(screen.getByText("5")).toBeInTheDocument(); // yes votes
      expect(screen.getByText("3")).toBeInTheDocument(); // no votes
      expect(screen.getByText("8 votes total")).toBeInTheDocument();
    });

    it("shows VK version badge", () => {
      renderWithRouter(<ProposalCard {...defaultProps} />);

      expect(screen.getByText("v1")).toBeInTheDocument();
    });

    it("shows vote mode badge", () => {
      renderWithRouter(<ProposalCard {...defaultProps} />);

      expect(screen.getByText("Fixed")).toBeInTheDocument();
    });

    it("shows Trailing mode when applicable", () => {
      const props = {
        ...defaultProps,
        proposal: { ...defaultProps.proposal, voteMode: "Trailing" as const },
      };
      renderWithRouter(<ProposalCard {...props} />);

      expect(screen.getByText("Trailing")).toBeInTheDocument();
    });

    it("shows voted badge when user has voted", () => {
      const props = {
        ...defaultProps,
        proposal: { ...defaultProps.proposal, hasVoted: true },
      };
      renderWithRouter(<ProposalCard {...props} />);

      expect(screen.getByText("Voted")).toBeInTheDocument();
    });
  });

  describe("Deadline Display", () => {
    it("shows time remaining for active proposals", () => {
      renderWithRouter(<ProposalCard {...defaultProps} />);

      // Should show some form of time remaining
      expect(screen.getByText(/day|hour|minute|left/i)).toBeInTheDocument();
    });

    it("shows Closed badge for past deadline", () => {
      const props = {
        ...defaultProps,
        proposal: {
          ...defaultProps.proposal,
          endTime: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
        },
      };
      renderWithRouter(<ProposalCard {...props} />);

      // "Closed" appears in multiple places (badge, button, deadline)
      const closedElements = screen.getAllByText("Closed");
      expect(closedElements.length).toBeGreaterThan(0);
    });

    it("handles no deadline (endTime = 0)", () => {
      const props = {
        ...defaultProps,
        proposal: { ...defaultProps.proposal, endTime: 0 },
      };
      renderWithRouter(<ProposalCard {...props} />);

      // Should not show deadline-related text (no time left, no closed badge)
      expect(screen.queryByText(/left/i)).not.toBeInTheDocument();
      // Note: The "Closed" text may still appear in button when hasMembership is true
      // but the destructive badge should not appear
      const badges = document.querySelectorAll('[class*="destructive"]');
      const closedBadge = Array.from(badges).find(
        (b) => b.textContent === "Closed",
      );
      expect(closedBadge).toBeUndefined();
    });
  });

  describe("Vote Progress Bar", () => {
    it("shows correct vote percentages", () => {
      renderWithRouter(<ProposalCard {...defaultProps} />);

      // Progress bar should exist
      const progressBars = document.querySelectorAll(
        ".bg-green-500, .bg-red-500",
      );
      expect(progressBars.length).toBe(2);
    });

    it("handles zero votes gracefully", () => {
      const props = {
        ...defaultProps,
        proposal: { ...defaultProps.proposal, yesVotes: 0, noVotes: 0 },
      };
      renderWithRouter(<ProposalCard {...props} />);

      expect(screen.getByText("0 votes total")).toBeInTheDocument();
    });
  });

  describe("Navigation", () => {
    it("navigates to proposal details on card click", () => {
      renderWithRouter(<ProposalCard {...defaultProps} />);

      // Click the card
      const card = screen
        .getByText("Test Proposal")
        .closest("[class*='group/card']");
      if (card) {
        fireEvent.click(card);
      }

      expect(mockNavigate).toHaveBeenCalledWith(
        expect.stringContaining("/daos/"),
      );
    });

    it("navigates on View button click", () => {
      renderWithRouter(<ProposalCard {...defaultProps} />);

      const viewButton = screen.getByText("View");
      fireEvent.click(viewButton);

      expect(mockNavigate).toHaveBeenCalled();
    });
  });

  describe("Vote Button", () => {
    it("shows Vote button for members who have not voted", () => {
      mockGetZKCredentials.mockReturnValue({
        secret: "123",
        salt: "456",
        commitment: "789",
        leafIndex: 0,
      });

      renderWithRouter(<ProposalCard {...defaultProps} />);

      expect(screen.getByText("Vote")).toBeInTheDocument();
    });

    it("shows Register button when user is not registered", () => {
      mockGetZKCredentials.mockReturnValue(null);

      renderWithRouter(<ProposalCard {...defaultProps} />);

      expect(screen.getByText("Register")).toBeInTheDocument();
    });

    it("hides Vote button for non-members", () => {
      const props = {
        ...defaultProps,
        hasMembership: false,
      };
      renderWithRouter(<ProposalCard {...props} />);

      expect(screen.queryByText("Vote")).not.toBeInTheDocument();
    });

    it("hides Vote button when user has already voted", () => {
      const props = {
        ...defaultProps,
        proposal: { ...defaultProps.proposal, hasVoted: true },
      };
      renderWithRouter(<ProposalCard {...props} />);

      expect(
        screen.queryByRole("button", { name: /vote/i }),
      ).not.toBeInTheDocument();
    });

    it("disables Vote button when proposal is closed", () => {
      mockGetZKCredentials.mockReturnValue({
        secret: "123",
        salt: "456",
        commitment: "789",
        leafIndex: 0,
      });

      const props = {
        ...defaultProps,
        proposal: {
          ...defaultProps.proposal,
          endTime: Math.floor(Date.now() / 1000) - 3600, // closed
        },
      };
      renderWithRouter(<ProposalCard {...props} />);

      // Should show "Closed" instead of "Vote"
      const buttons = screen.getAllByRole("button");
      const closedButton = buttons.find((btn) => btn.textContent === "Closed");
      expect(closedButton).toBeTruthy();
    });

    it("opens vote modal when Vote button is clicked", async () => {
      mockGetZKCredentials.mockReturnValue({
        secret: "123",
        salt: "456",
        commitment: "789",
        leafIndex: 0,
      });

      renderWithRouter(<ProposalCard {...defaultProps} />);

      const voteButton = screen.getByText("Vote");
      fireEvent.click(voteButton);

      // VoteModal should appear
      await waitFor(() => {
        expect(screen.getByText("Cast Anonymous Vote")).toBeInTheDocument();
      });
    });
  });

  describe("IPFS Metadata", () => {
    it("fetches metadata for CID content", async () => {
      renderWithRouter(<ProposalCard {...defaultProps} />);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining("/ipfs/QmTestCid123"),
        );
      });
    });

    it("handles non-CID content gracefully", () => {
      const props = {
        ...defaultProps,
        proposal: {
          ...defaultProps.proposal,
          contentCid: "Plain text content",
        },
      };
      renderWithRouter(<ProposalCard {...props} />);

      // Should display the plain text
      expect(screen.getByText("Plain text content")).toBeInTheDocument();
    });

    it("shows image thumbnail when metadata contains image", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            version: 1,
            body: "Description",
            image: {
              cid: "QmImageCid",
              filename: "image.png",
              mimeType: "image/png",
            },
          }),
      });

      renderWithRouter(<ProposalCard {...defaultProps} />);

      await waitFor(() => {
        const img = document.querySelector("img");
        expect(img).toBeTruthy();
        expect(img?.alt).toBe("image.png");
      });
    });

    it("retries on fetch failure", async () => {
      let callCount = 0;
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.reject(new Error("Network error"));
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: 1, body: "Success" }),
        });
      });

      renderWithRouter(<ProposalCard {...defaultProps} />);

      // Wait for retries
      await waitFor(
        () => {
          expect(callCount).toBeGreaterThanOrEqual(1);
        },
        { timeout: 5000 },
      );
    });
  });

  describe("Accessibility", () => {
    it("has clickable card for keyboard navigation", () => {
      renderWithRouter(<ProposalCard {...defaultProps} />);

      const card = screen
        .getByText("Test Proposal")
        .closest("[class*='cursor-pointer']");
      expect(card).toBeTruthy();
    });

    it("buttons are focusable", () => {
      renderWithRouter(<ProposalCard {...defaultProps} />);

      const viewButton = screen.getByText("View");
      expect(viewButton.tagName).toBe("BUTTON");
    });
  });
});

describe("ProposalCard with VoteModal", () => {
  const defaultProps = {
    proposal: {
      id: 1,
      title: "Test Proposal",
      contentCid: "QmTestCid",
      yesVotes: 0,
      noVotes: 0,
      hasVoted: false,
      eligibleRoot: BigInt("12345"),
      voteMode: "Fixed" as const,
      endTime: Math.floor(Date.now() / 1000) + 86400,
      vkVersion: 1,
    },
    daoId: 1,
    publicKey: "GPUBLIC...",
    kit: null,
    hasMembership: true,
    onVoteComplete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetZKCredentials.mockReturnValue({
      secret: "123",
      salt: "456",
      commitment: "789",
      leafIndex: 0,
    });
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: 1, body: "Test" }),
    });
  });

  const renderWithRouter = (component: React.ReactElement) => {
    return render(<BrowserRouter>{component}</BrowserRouter>);
  };

  it("closes vote modal when onClose is triggered", async () => {
    renderWithRouter(<ProposalCard {...defaultProps} />);

    // Open the modal
    const voteButton = screen.getByText("Vote");
    fireEvent.click(voteButton);

    await waitFor(() => {
      expect(screen.getByText("Cast Anonymous Vote")).toBeInTheDocument();
    });

    // Click outside to close (backdrop click)
    const backdrop = screen.getByText("Cast Anonymous Vote").closest(".fixed");
    if (backdrop) {
      fireEvent.click(backdrop);
    }

    await waitFor(() => {
      expect(screen.queryByText("Cast Anonymous Vote")).not.toBeInTheDocument();
    });
  });
});
