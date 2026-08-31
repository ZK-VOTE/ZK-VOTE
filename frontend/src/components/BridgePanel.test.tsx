import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BridgePanel from "./BridgePanel";

// Mock window.ethereum
const mockEthereum = {
  request: vi.fn(),
};

describe("BridgePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (global as unknown as { fetch: typeof fetch }).fetch = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, txHash: "0xabc123" }),
      } as unknown as Response);
    // @ts-expect-error - test shim for browser wallet API
    window.ethereum = mockEthereum;
    mockEthereum.request.mockResolvedValue([
      "0x1234567890123456789012345678901234567890",
    ]);
  });

  it("shows connect prompt when not connected to Stellar", () => {
    render(<BridgePanel daoId={1} proposalId={1} isConnected={false} />);
    expect(screen.getByText(/Connect your Stellar wallet/)).toBeInTheDocument();
  });

  it("renders cross-chain UI when connected", () => {
    render(<BridgePanel daoId={1} proposalId={1} isConnected={true} />);
    expect(screen.getByText("Vote from Ethereum")).toBeInTheDocument();
    expect(screen.getByText(/Connect MetaMask/)).toBeInTheDocument();
  });

  it("connects EVM wallet on button click", async () => {
    render(<BridgePanel daoId={1} proposalId={1} isConnected={true} />);
    fireEvent.click(screen.getByText("Connect MetaMask"));
    await waitFor(() =>
      expect(mockEthereum.request).toHaveBeenCalledWith({
        method: "eth_requestAccounts",
      }),
    );
    await waitFor(() => expect(screen.getByText(/0x1234/)).toBeInTheDocument());
  });

  it("shows vote choice after EVM connected", async () => {
    render(<BridgePanel daoId={1} proposalId={1} isConnected={true} />);
    fireEvent.click(screen.getByText("Connect MetaMask"));
    await waitFor(() => screen.getByText("Vote Choice"));
    expect(screen.getByText("For")).toBeInTheDocument();
    expect(screen.getByText("Against")).toBeInTheDocument();
  });

  it("submits bridge vote and shows success", async () => {
    render(
      <BridgePanel
        daoId={1}
        proposalId={1}
        isConnected={true}
        onVoteSubmitted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Connect MetaMask"));
    await waitFor(() => screen.getByText("For"));
    fireEvent.click(screen.getByText("For"));
    fireEvent.click(screen.getByText("Submit Cross-Chain Vote"));
    await waitFor(() =>
      expect(
        screen.getByText(/Vote submitted successfully/),
      ).toBeInTheDocument(),
    );
  });

  it("handles EVM wallet missing error", async () => {
    // @ts-expect-error - test shim for missing browser wallet API
    window.ethereum = undefined;
    render(<BridgePanel daoId={1} proposalId={1} isConnected={true} />);
    fireEvent.click(screen.getByText("Connect MetaMask"));
    await waitFor(() =>
      expect(screen.getByText(/No EVM wallet detected/)).toBeInTheDocument(),
    );
  });

  it("handles bridge proof generation failure", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Network error"),
    );
    render(<BridgePanel daoId={1} proposalId={1} isConnected={true} />);
    fireEvent.click(screen.getByText("Connect MetaMask"));
    await waitFor(() => screen.getByText("For"));
    fireEvent.click(screen.getByText("For"));
    fireEvent.click(screen.getByText("Submit Cross-Chain Vote"));
    await waitFor(() =>
      expect(screen.getByText(/Bridge vote failed/)).toBeInTheDocument(),
    );
  });
});
