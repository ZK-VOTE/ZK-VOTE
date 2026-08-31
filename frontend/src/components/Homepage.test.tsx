import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import Homepage from "./Homepage";

// Mock react-router-dom useNavigate
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe("Homepage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderWithRouter = (component: React.ReactElement) => {
    return render(<BrowserRouter>{component}</BrowserRouter>);
  };

  describe("Hero section", () => {
    it("renders the hero heading text", () => {
      renderWithRouter(<Homepage />);

      expect(screen.getByText("Private voting for")).toBeInTheDocument();
      expect(
        screen.getByText("decentralized organizations"),
      ).toBeInTheDocument();
    });

    it("renders the hero description", () => {
      renderWithRouter(<Homepage />);

      expect(
        screen.getByText(/Zero-knowledge proof voting on Stellar/),
      ).toBeInTheDocument();
    });

    it("shows Start voting button", () => {
      renderWithRouter(<Homepage />);

      expect(screen.getByText("Start voting")).toBeInTheDocument();
    });

    it("shows Documentation button", () => {
      renderWithRouter(<Homepage />);

      expect(
        screen.getByText((content, element) => {
          return (
            element?.tagName === "BUTTON" && content.includes("Documentation")
          );
        }),
      ).toBeInTheDocument();
    });
  });

  describe("Navigation", () => {
    it("navigates to /daos/ when Start voting is clicked", () => {
      renderWithRouter(<Homepage />);

      fireEvent.click(screen.getByText("Start voting"));

      expect(mockNavigate).toHaveBeenCalledWith("/daos/");
    });

    it("navigates to /docs/ when Documentation is clicked", () => {
      renderWithRouter(<Homepage />);

      const docButton = screen.getByText((content, element) => {
        return (
          element?.tagName === "BUTTON" && content.includes("Documentation")
        );
      });
      fireEvent.click(docButton);

      expect(mockNavigate).toHaveBeenCalledWith("/docs/");
    });

    it("navigates to /daos/ when Browse DAOs is clicked", () => {
      renderWithRouter(<Homepage />);

      fireEvent.click(screen.getByText("Browse DAOs"));

      expect(mockNavigate).toHaveBeenCalledWith("/daos/");
    });

    it("navigates to /daos/ when Explore DAOs is clicked", () => {
      renderWithRouter(<Homepage />);

      fireEvent.click(screen.getByText("Explore DAOs"));

      expect(mockNavigate).toHaveBeenCalledWith("/daos/");
    });
  });

  describe("Tech stack badges", () => {
    it("shows Groth16 ZK-SNARKs badge", () => {
      renderWithRouter(<Homepage />);

      expect(screen.getByText("Groth16 ZK-SNARKs")).toBeInTheDocument();
    });

    it("shows BN254 Elliptic Curve badge", () => {
      renderWithRouter(<Homepage />);

      expect(screen.getByText("BN254 Elliptic Curve")).toBeInTheDocument();
    });

    it("shows Poseidon Hash badge", () => {
      renderWithRouter(<Homepage />);

      expect(screen.getByText("Poseidon Hash")).toBeInTheDocument();
    });
  });

  describe("How It Works section", () => {
    it("renders the ZK explanation heading", () => {
      renderWithRouter(<Homepage />);

      expect(screen.getByText(/Vote privately/)).toBeInTheDocument();
    });

    it("shows feature cards", () => {
      renderWithRouter(<Homepage />);

      expect(screen.getByText("Poseidon Merkle Trees")).toBeInTheDocument();
      expect(screen.getByText("BN254 Pairing Curve")).toBeInTheDocument();
      expect(screen.getByText("Groth16 Verification")).toBeInTheDocument();
    });
  });

  describe("Architecture section", () => {
    it("renders the architecture heading", () => {
      renderWithRouter(<Homepage />);

      expect(
        screen.getByText("Multi-contract design for modularity"),
      ).toBeInTheDocument();
    });

    it("lists the contract names", () => {
      renderWithRouter(<Homepage />);

      expect(screen.getByText("DAORegistry")).toBeInTheDocument();
      expect(screen.getByText("MembershipSBT")).toBeInTheDocument();
      expect(screen.getByText("MembershipTree")).toBeInTheDocument();
      expect(screen.getByText("Voting")).toBeInTheDocument();
      expect(screen.getByText("Comments")).toBeInTheDocument();
    });
  });

  describe("Privacy section", () => {
    it("renders Stays Private heading", () => {
      renderWithRouter(<Homepage />);

      expect(screen.getByText("Stays Private")).toBeInTheDocument();
    });

    it("renders Publicly Visible heading", () => {
      renderWithRouter(<Homepage />);

      expect(screen.getByText("Publicly Visible")).toBeInTheDocument();
    });

    it("lists private items", () => {
      renderWithRouter(<Homepage />);

      expect(
        screen.getByText("Your vote choice (yes/no/abstain)"),
      ).toBeInTheDocument();
      expect(screen.getByText("Your identity as a voter")).toBeInTheDocument();
    });

    it("lists public items", () => {
      renderWithRouter(<Homepage />);

      expect(screen.getByText("Aggregate vote tallies")).toBeInTheDocument();
      expect(
        screen.getByText("Nullifier hash (prevents double voting)"),
      ).toBeInTheDocument();
    });
  });

  describe("Public protocol stats", () => {
    it("loads and renders anonymized aggregate stats", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            status: "ok",
            data: {
              totalDaos: 42,
              totalEvents: 3210,
              lastLedger: 987654,
              lastUpdated: "2026-08-30T12:00:00.000Z",
            },
          }),
        }),
      );

      renderWithRouter(<Homepage />);

      expect(await screen.findByText("Anonymous network activity")).toBeInTheDocument();
      expect(screen.getByText("42")).toBeInTheDocument();
      expect(screen.getByText("3,210")).toBeInTheDocument();
      expect(screen.getByText("987,654")).toBeInTheDocument();
    });
  });

  describe("CTA section", () => {
    it("renders the CTA heading", () => {
      renderWithRouter(<Homepage />);

      expect(screen.getByText("Ready to get started?")).toBeInTheDocument();
    });

    it("shows View on GitHub button", () => {
      renderWithRouter(<Homepage />);

      expect(screen.getByText("View on GitHub")).toBeInTheDocument();
    });

    it("opens GitHub in new tab when View on GitHub is clicked", () => {
      const mockOpen = vi.fn();
      vi.stubGlobal("open", mockOpen);

      renderWithRouter(<Homepage />);

      fireEvent.click(screen.getByText("View on GitHub"));

      expect(mockOpen).toHaveBeenCalledWith(
        "https://github.com/ZK-VOTE/ZK-VOTE",
        "_blank",
      );

      vi.unstubAllGlobals();
    });
  });
});
