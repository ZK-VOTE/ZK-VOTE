/**
 * Tests for DAOSettings's Emergency Halt Status section (ZV-114 / #954).
 *
 * Covers only the halt-status display added for this issue - the
 * membership/proposal toggles already have their own coverage elsewhere
 * and are untouched by this change.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import DAOSettings from "./DAOSettings";

vi.mock("../lib/client", () => ({
  getZkVoteClient: vi.fn(),
}));
vi.mock("./DAOProfileEditor", () => ({
  default: () => null,
}));

const relayerFetchMock = vi.fn();
vi.mock("../lib/api", () => ({
  notifyEvent: vi.fn(),
  relayerFetch: (...args: unknown[]) => relayerFetchMock(...args),
}));

const baseProps = {
  daoId: 1,
  daoName: "Test DAO",
  publicKey: "GTEST",
  kit: {} as never,
  membershipOpen: true,
  membersCanPropose: true,
  metadataCid: null,
  onSettingsChanged: vi.fn(),
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("DAOSettings - Emergency Halt Status", () => {
  it("renders each tier with its status once the fetch resolves", async () => {
    relayerFetchMock.mockResolvedValue({
      json: async () => ({
        tiers: [
          { tier: 0x1, name: "vote_submission", halted: false },
          { tier: 0x2, name: "tally_finalization", halted: true },
          { tier: 0x4, name: "treasury_execution", halted: null },
        ],
      }),
    });

    render(<DAOSettings {...baseProps} />);

    expect(relayerFetchMock).toHaveBeenCalledWith("/voting/halt/status");

    await waitFor(() => {
      expect(screen.getByText("Vote Submission")).toBeInTheDocument();
    });
    expect(screen.getByText("Tally Finalization")).toBeInTheDocument();
    expect(screen.getByText("Treasury Execution")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Halted")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("shows an error message when the status fetch fails", async () => {
    relayerFetchMock.mockRejectedValue(new Error("network down"));

    render(<DAOSettings {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText(/Could not load halt status/)).toBeInTheDocument();
    });
  });
});
