import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const escrowAddress = "0x" + "9".repeat(40);
const depositor = "0x" + "1".repeat(40);
const recipient = "0x" + "2".repeat(40);

vi.mock("../config/env", () => ({
  TREASURY_ESCROW_ADDRESS: "0x" + "9".repeat(40),
}));

const mockEthereum = {
  request: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
};

// Imported after the env mock so the module picks up the mocked constant.
const { default: TreasuryEscrowPanel } = await import("./TreasuryEscrowPanel");

function mockFetchSequence(responses: Array<Record<string, unknown>>) {
  let call = 0;
  (global as unknown as { fetch: typeof fetch }).fetch = vi
    .fn()
    .mockImplementation(() => {
      const body = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      } as unknown as Response);
    });
}

describe("TreasuryEscrowPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error test injects a minimal EIP-1193 provider mock
    window.ethereum = mockEthereum;
    mockFetchSequence([{ locks: [] }]);
  });

  it("renders nothing when no escrow address is configured", async () => {
    vi.resetModules();
    vi.doMock("../config/env", () => ({ TREASURY_ESCROW_ADDRESS: "" }));
    const { default: Panel } = await import("./TreasuryEscrowPanel");
    const { container } = render(
      <Panel daoId={1} proposalId={1} evmAddress={depositor} />,
    );
    expect(container).toBeEmptyDOMElement();
    vi.doUnmock("../config/env");
  });

  it("shows the lock form when a wallet is connected", async () => {
    render(
      <TreasuryEscrowPanel daoId={1} proposalId={1} evmAddress={depositor} />,
    );
    await waitFor(() =>
      expect(screen.getByText("Lock Funds in Escrow")).toBeInTheDocument(),
    );
  });

  it("locks funds, reports the lock, and refreshes the list", async () => {
    mockFetchSequence([
      { locks: [] }, // initial refresh on mount
      { success: true }, // reportLock response
      {
        locks: [
          {
            lockId: "0",
            daoId: 1,
            proposalId: 1,
            depositor,
            recipient,
            amount: "500000000000000000",
            lockTxHash: "0x" + "a".repeat(64),
            createdAt: Math.floor(Date.now() / 1000),
            timeoutSeconds: 86400,
            status: "locked",
          },
        ],
      }, // refresh after lock
    ]);

    mockEthereum.request.mockImplementation(({ method }: { method: string }) => {
      if (method === "eth_sendTransaction") {
        return Promise.resolve("0x" + "a".repeat(64));
      }
      if (method === "eth_getTransactionReceipt") {
        return Promise.resolve({
          logs: [
            {
              address: escrowAddress,
              topics: [
                "0x2d50ef40a38f8735b967e855b5d60fbd0c23b3cf20938d9d8fdc9c422fb512ef",
                "0x" + "0".repeat(64), // lockId 0
              ],
            },
          ],
        });
      }
      return Promise.resolve(null);
    });

    render(
      <TreasuryEscrowPanel daoId={1} proposalId={1} evmAddress={depositor} />,
    );

    fireEvent.change(screen.getByLabelText("Recipient address"), {
      target: { value: recipient },
    });
    fireEvent.change(screen.getByLabelText("Amount (ETH)"), {
      target: { value: "0.5" },
    });
    fireEvent.click(screen.getByText("Lock Funds in Escrow"));

    await waitFor(() =>
      expect(screen.getByText("Lock #0")).toBeInTheDocument(),
    );
    expect(screen.getByText("Locked")).toBeInTheDocument();
  });

  it("shows a Claim Refund button once the timeout has elapsed for the connected depositor", async () => {
    mockFetchSequence([
      {
        locks: [
          {
            lockId: "5",
            daoId: 1,
            proposalId: 1,
            depositor,
            recipient,
            amount: "1000000000000000000",
            lockTxHash: "0x" + "a".repeat(64),
            createdAt: Math.floor(Date.now() / 1000) - 86400 - 10,
            timeoutSeconds: 86400,
            status: "locked",
          },
        ],
      },
    ]);

    render(
      <TreasuryEscrowPanel daoId={1} proposalId={1} evmAddress={depositor} />,
    );

    await waitFor(() =>
      expect(screen.getByText("Claim Refund")).toBeInTheDocument(),
    );
  });

  it("does not show Claim Refund for a different connected wallet", async () => {
    mockFetchSequence([
      {
        locks: [
          {
            lockId: "5",
            daoId: 1,
            proposalId: 1,
            depositor,
            recipient,
            amount: "1000000000000000000",
            lockTxHash: "0x" + "a".repeat(64),
            createdAt: Math.floor(Date.now() / 1000) - 86400 - 10,
            timeoutSeconds: 86400,
            status: "locked",
          },
        ],
      },
    ]);

    render(
      <TreasuryEscrowPanel
        daoId={1}
        proposalId={1}
        evmAddress={"0x" + "3".repeat(40)}
      />,
    );

    await waitFor(() => expect(screen.getByText("Lock #5")).toBeInTheDocument());
    expect(screen.queryByText("Claim Refund")).not.toBeInTheDocument();
  });
});
