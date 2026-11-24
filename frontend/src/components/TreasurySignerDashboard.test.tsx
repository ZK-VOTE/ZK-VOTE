import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TreasurySignerDashboard from "./TreasurySignerDashboard";

const ME = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const OTHER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBUAY";
const API = "http://relayer.test/api/v1";
const DIGEST = "ab".repeat(32);

const session = (overrides = {}) => ({
  id: "s1",
  proposalId: 4,
  digest: DIGEST,
  action: { kind: "spend", token: "C".padEnd(56, "A"), to: OTHER, amount: "250" },
  signers: [ME, OTHER],
  required: 2,
  expiresAt: 1_900_000_000,
  status: "collecting",
  signatures: [{ signer: OTHER, signedAt: 1 }],
  stellarTxHash: null,
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("TreasurySignerDashboard (#888)", () => {
  it("signs the approval message for the proposal's digest and shows the threshold is met", async () => {
    const message = `ZK-VOTE treasury approval\nproposal: 4\ndigest: ${DIGEST}\nexpires: 1900000000`;
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/admin/treasury/sessions")) return json({ sessions: [session()] });
      if (url.endsWith("/admin/treasury/sessions/s1")) return json({ session: session(), message });
      if (url.endsWith("/signatures")) {
        expect(JSON.parse(String(init?.body))).toEqual({ signer: ME, signature: "c2lnbmVk" });
        return json({ session: session({ status: "ready", signatures: [{ signer: OTHER, signedAt: 1 }, { signer: ME, signedAt: 2 }] }) });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;
    const signMessage = vi.fn(async () => "c2lnbmVk");

    render(
      <TreasurySignerDashboard
        signerAddress={ME}
        signMessage={signMessage}
        authHeaders={{ Authorization: "Bearer operator" }}
        fetchImpl={fetchImpl}
        apiBase={API}
      />,
    );
    expect(await screen.findByText(/#4: Pay 250 to/)).toBeInTheDocument();
    expect(screen.getByText("1 of 2 signatures · collecting")).toBeInTheDocument();
    expect(screen.getByText(`digest ${DIGEST}`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign approval" }));
    expect(await screen.findByRole("status")).toHaveTextContent("The threshold is met");
    expect(signMessage).toHaveBeenCalledWith(message);
    expect(screen.getByText("2 of 2 signatures · ready")).toBeInTheDocument();
    expect(screen.getByText("You signed this proposal.")).toBeInTheDocument();
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.every(([, init]) => (init?.headers as Record<string, string>)?.Authorization === "Bearer operator")).toBe(true);
  });

  it("offers no signing to someone outside the signer set or who already signed", async () => {
    const fetchImpl = vi.fn(() =>
      json({ sessions: [session(), session({ id: "s2", proposalId: 5, signatures: [{ signer: ME, signedAt: 1 }] })] }),
    ) as unknown as typeof fetch;
    const { rerender } = render(
      <TreasurySignerDashboard signerAddress={"G".padEnd(56, "C")} signMessage={vi.fn()} authHeaders={{}} fetchImpl={fetchImpl} apiBase={API} />,
    );
    expect(await screen.findAllByTestId("treasury-session")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Sign approval" })).toBeNull();

    rerender(<TreasurySignerDashboard signerAddress={ME} signMessage={vi.fn()} authHeaders={{}} fetchImpl={fetchImpl} apiBase={API} />);
    expect(await screen.findAllByRole("button", { name: "Sign approval" })).toHaveLength(1);
  });
});
