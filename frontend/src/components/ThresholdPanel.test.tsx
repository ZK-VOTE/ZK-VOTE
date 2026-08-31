import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ThresholdPanel } from "./ThresholdPanel";

const mockRelayerFetch = vi.fn();

vi.mock("../lib/api", () => ({
  relayerFetch: (...args: unknown[]) => mockRelayerFetch(...args),
  parseApiError: (data: { error?: string }) => data?.error || "Unknown error",
}));

describe("ThresholdPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockRelayerFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    } as unknown as Response);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows connect prompt when not connected", () => {
    render(
      <ThresholdPanel
        daoId={1}
        proposalId={1}
        isConnected={false}
        publicKey={null}
      />,
    );
    expect(
      screen.getByText(/Connect your wallet to manage threshold decryption/),
    ).toBeInTheDocument();
  });

  it("renders setup tab by default when connected", () => {
    render(
      <ThresholdPanel
        daoId={1}
        proposalId={1}
        isConnected={true}
        publicKey="0x1234"
      />,
    );
    expect(
      screen.getByText("Initialize Threshold Decryption"),
    ).toBeInTheDocument();
    expect(screen.getByText("Threshold Decryption")).toBeInTheDocument();
  });

  it("shows status badge as Not Initialized", () => {
    render(
      <ThresholdPanel
        daoId={1}
        proposalId={1}
        isConnected={true}
        publicKey="0x1234"
      />,
    );
    expect(screen.getByText("Not Initialized")).toBeInTheDocument();
  });

  it("calls init API on Initialize Election click", async () => {
    mockRelayerFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          round: { phase: "registration" },
        }),
    } as unknown as Response);

    render(
      <ThresholdPanel
        daoId={1}
        proposalId={1}
        isConnected={true}
        publicKey="0x1234"
      />,
    );

    fireEvent.click(screen.getByText("Initialize Election"));

    await waitFor(() => expect(mockRelayerFetch).toHaveBeenCalledTimes(1));
    expect(mockRelayerFetch).toHaveBeenCalledWith("/threshold/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        daoId: 1,
        proposalId: 1,
        thresholdN: 3,
        thresholdT: 2,
        creator: "0x1234",
      }),
    });
  });

  it("shows error on init failure", async () => {
    mockRelayerFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ success: false, error: "Initialization failed" }),
    } as unknown as Response);

    render(
      <ThresholdPanel
        daoId={1}
        proposalId={1}
        isConnected={true}
        publicKey="0x1234"
      />,
    );

    fireEvent.click(screen.getByText("Initialize Election"));

    await waitFor(() =>
      expect(screen.getByText("Initialization failed")).toBeInTheDocument(),
    );
  });

  it("shows authority registration form after init", async () => {
    mockRelayerFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          round: { phase: "registration" },
        }),
    } as unknown as Response);

    render(
      <ThresholdPanel
        daoId={1}
        proposalId={1}
        isConnected={true}
        publicKey="0x1234"
      />,
    );

    fireEvent.click(screen.getByText("Initialize Election"));

    await waitFor(() =>
      expect(
        screen.getByText("Register as Tally Authority"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("Authority Name")).toBeInTheDocument();
  });

  it("calls register API on Register click", async () => {
    mockRelayerFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            round: { phase: "registration" },
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, authorityAddress: "0x1234" }),
      } as unknown as Response);

    render(
      <ThresholdPanel
        daoId={1}
        proposalId={1}
        isConnected={true}
        publicKey="0x1234"
      />,
    );

    fireEvent.click(screen.getByText("Initialize Election"));

    await waitFor(() =>
      expect(
        screen.getByText("Register as Tally Authority"),
      ).toBeInTheDocument(),
    );

    const nameInput = screen.getByPlaceholderText("e.g., Tally Authority 1");
    fireEvent.change(nameInput, { target: { value: "My Authority" } });
    fireEvent.click(screen.getByText("Register"));

    await waitFor(() => expect(mockRelayerFetch).toHaveBeenCalledTimes(2));
    expect(mockRelayerFetch).toHaveBeenCalledWith(
      "/threshold/authority/register",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("switches between tabs", () => {
    render(
      <ThresholdPanel
        daoId={1}
        proposalId={1}
        isConnected={true}
        publicKey="0x1234"
      />,
    );

    fireEvent.click(screen.getByText("Status"));
    expect(screen.getByText("Encrypted Votes")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Decrypt"));
    expect(screen.getByText("Decryption Participation")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Setup"));
    expect(
      screen.getByText("Initialize Threshold Decryption"),
    ).toBeInTheDocument();
  });

  it("shows DKG must be completed message in decrypt tab when idle", () => {
    render(
      <ThresholdPanel
        daoId={1}
        proposalId={1}
        isConnected={true}
        publicKey="0x1234"
      />,
    );

    fireEvent.click(screen.getByText("Decrypt"));
    expect(
      screen.getByText(/DKG must be completed before decryption/),
    ).toBeInTheDocument();
  });

  it("polls for state updates", async () => {
    mockRelayerFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          state: {
            encryptedVoteCount: 0,
            decryptionShareCount: 0,
            isTallyDecrypted: false,
            decryptedTally: null,
          },
        }),
    } as unknown as Response);

    render(
      <ThresholdPanel
        daoId={1}
        proposalId={1}
        isConnected={true}
        publicKey="0x1234"
      />,
    );

    await waitFor(() => expect(mockRelayerFetch).toHaveBeenCalled());

    vi.advanceTimersByTime(5000);

    await waitFor(() =>
      expect(mockRelayerFetch).toHaveBeenCalledWith(
        "/threshold/state/1/1",
        expect.objectContaining({ method: "GET" }),
      ),
    );
  });

  it("renders threshold configuration inputs", () => {
    render(
      <ThresholdPanel
        daoId={1}
        proposalId={1}
        isConnected={true}
        publicKey="0x1234"
      />,
    );

    expect(screen.getByText("Total Authorities (n)")).toBeInTheDocument();
    expect(screen.getByText("Threshold (t)")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Any 2 of 3 authorities can decrypt the tally/,
      ),
    ).toBeInTheDocument();
  });
});
