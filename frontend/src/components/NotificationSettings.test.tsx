import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import NotificationSettings from "./NotificationSettings";

const TOKEN_STORAGE_KEY = "zkvote:notification-token";

const TOKEN = "a".repeat(64);
const API = "http://relayer.test/api/v1";

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

// The shared test setup stubs localStorage with no-op mocks; back them with a map here.
const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  Object.assign(localStorage, {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
});

describe("NotificationSettings (#886)", () => {

  it("subscribes by email with the chosen event types and keeps only the token", async () => {
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/notifications/channels")) return json({ channels: ["email"], vapidPublicKey: null });
      const view = { channel: "email", destinationHint: "v***@example.org", eventTypes: ["election_started"], daoIds: ["7"], expiresAt: "2027-05-01T00:00:00.000Z" };
      if (url.endsWith("/notifications/subscriptions") && init?.method === "POST") return json({ token: TOKEN, ...view }, 201);
      if (url.endsWith(`/notifications/subscriptions/${TOKEN}`)) return json(view);
      return json({}, 404);
    }) as unknown as typeof fetch;

    render(<NotificationSettings daoId="7" fetchImpl={fetchImpl} apiBase={API} />);
    fireEvent.click(await screen.findByLabelText("An election closes"));
    fireEvent.click(screen.getByLabelText("A dispute is resolved"));
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "voter@example.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));

    expect(await screen.findByRole("status")).toHaveTextContent("You're subscribed.");
    const post = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(post![1].body)).toEqual({
      channel: "email",
      destination: "voter@example.org",
      eventTypes: ["election_started"],
      daoIds: ["7"],
    });
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN);
    expect(screen.getByText(/Sending to v\*\*\*@example.org/)).toBeInTheDocument();
  });

  it("changes preferences and unsubscribes with the stored token", async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    const calls: { url: string; method: string; body?: string }[] = [];
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (url.endsWith("/notifications/channels")) return json({ channels: ["email"], vapidPublicKey: null });
      const view = { channel: "email", destinationHint: "v***@example.org", eventTypes: [], daoIds: [], expiresAt: "2027-05-01T00:00:00.000Z" };
      if (init?.method === "PATCH") return json({ ...view, eventTypes: JSON.parse(String(init.body)).eventTypes });
      if (init?.method === "DELETE") return json({ unsubscribed: true });
      return json(view);
    }) as unknown as typeof fetch;

    render(<NotificationSettings fetchImpl={fetchImpl} apiBase={API} />);
    fireEvent.click(await screen.findByLabelText("A dispute is resolved"));
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Preferences saved.");
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!)).toEqual({
      eventTypes: ["election_started", "election_ended"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("You're unsubscribed."));
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith(`/notifications/subscriptions/${TOKEN}`))).toBe(true);
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("forgets a token the server no longer knows (expired or unsubscribed by link)", async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    const fetchImpl = vi.fn((url: string) =>
      url.endsWith("/notifications/channels") ? json({ channels: ["email"], vapidPublicKey: null }) : json({ error: "gone" }, 404),
    ) as unknown as typeof fetch;
    render(<NotificationSettings fetchImpl={fetchImpl} apiBase={API} />);
    expect(await screen.findByRole("button", { name: "Subscribe" })).toBeInTheDocument();
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("says so when the server offers no channel", async () => {
    const fetchImpl = vi.fn(() => json({ channels: [], vapidPublicKey: null })) as unknown as typeof fetch;
    render(<NotificationSettings fetchImpl={fetchImpl} apiBase={API} />);
    expect(await screen.findByText("Notifications are not available on this server.")).toBeInTheDocument();
  });
});
