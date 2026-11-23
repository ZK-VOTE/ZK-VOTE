import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BridgePanel from "./BridgePanel";

// Mock window.ethereum
const mockEthereum = {
  request: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
};

const ROOTS = {
  sbtRoot: "0x" + "12".repeat(32),
  voteRoot: "0x" + "ab".repeat(32),
  sbtRootBlock: 42,
  anchored: true,
};

describe("BridgePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (global as unknown as { fetch: typeof fetch }).fetch = vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            String(url).startsWith("/bridge/roots/") ? ROOTS : { success: true, txHash: "0xabc123" },
          ),
      } as unknown as Response),
    ) as unknown as typeof fetch;
    // @ts-expect-error test injects a minimal EIP-1193 provider mock
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
    // @ts-expect-error test removes the injected EIP-1193 provider mock
    window.ethereum = undefined;
    render(<BridgePanel daoId={1} proposalId={1} isConnected={true} />);
    fireEvent.click(screen.getByText("Connect MetaMask"));
    await waitFor(() =>
      expect(screen.getByText(/No EVM wallet detected/)).toBeInTheDocument(),
    );
  });

  it("handles bridge proof generation failure", async () => {
    render(<BridgePanel daoId={1} proposalId={1} isConnected={true} />);
    // Let the roots load first, so the failure hits the vote submission.
    await screen.findByText(ROOTS.sbtRoot);
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Network error"),
    );
    fireEvent.click(screen.getByText("Connect MetaMask"));
    await waitFor(() => screen.getByText("For"));
    fireEvent.click(screen.getByText("For"));
    fireEvent.click(screen.getByText("Submit Cross-Chain Vote"));
    await waitFor(() =>
      expect(screen.getByText(/Bridge vote failed/)).toBeInTheDocument(),
    );
  });

  it("shows the roots anchored on Bridge.sol and submits the vote with them (#887)", async () => {
    render(<BridgePanel daoId={3} proposalId={9} isConnected={true} />);
    expect(await screen.findByText(ROOTS.sbtRoot)).toBeInTheDocument();
    expect(screen.getByText(ROOTS.voteRoot)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Connect MetaMask"));
    await waitFor(() => screen.getByText("For"));
    fireEvent.click(screen.getByText("For"));
    fireEvent.click(screen.getByText("Submit Cross-Chain Vote"));
    await waitFor(() => expect(screen.getByText(/Vote submitted successfully/)).toBeInTheDocument());

    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe("/bridge/roots/3/9");
    const vote = calls.find(([url]) => url === "/bridge/vote");
    expect(JSON.parse(vote![1].body)).toMatchObject({ sbtRoot: ROOTS.sbtRoot, voteRoot: ROOTS.voteRoot });
  });

  it("refuses to submit until the roots are anchored (#887)", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            String(url).startsWith("/bridge/roots/")
              ? { ...ROOTS, sbtRoot: "0x" + "0".repeat(64), anchored: false }
              : { success: true },
          ),
      } as unknown as Response),
    );
    render(<BridgePanel daoId={3} proposalId={9} isConnected={true} />);
    expect(await screen.findByText(/not anchored yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Connect MetaMask"));
    await waitFor(() => screen.getByText("For"));
    fireEvent.click(screen.getByText("For"));
    fireEvent.click(screen.getByText("Submit Cross-Chain Vote"));
    expect(await screen.findByText(/roots for this proposal are not anchored yet. Try again/)).toBeInTheDocument();
    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([url]) => url === "/bridge/vote")).toBe(false);
  });
});
