/**
 * Notification preferences (ZV-037 / #886).
 *
 * Subscribing is anonymous: the relayer returns a random contact token, kept
 * only in this browser, and nothing ties it to the connected wallet. Email or
 * browser push are offered when the relayer has that channel configured.
 */
import { useEffect, useState } from "react";
import { RELAYER_URL } from "../config/env";

const NOTIFICATION_EVENT_TYPES = [
  { id: "election_started", label: "An election opens" },
  { id: "election_ended", label: "An election closes" },
  { id: "dispute_outcome", label: "A dispute is resolved" },
] as const;
type EventType = (typeof NOTIFICATION_EVENT_TYPES)[number]["id"];
type Channel = "email" | "webpush";

const TOKEN_STORAGE_KEY = "zkvote:notification-token";

interface ChannelInfo {
  channels: Channel[];
  vapidPublicKey: string | null;
}

interface SubscriptionView {
  channel: Channel;
  destinationHint: string;
  eventTypes: EventType[];
  daoIds: string[];
  expiresAt: string;
}

export interface NotificationSettingsProps {
  /** Limit notifications to this DAO. Omit for every DAO. */
  daoId?: string;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* storage unavailable: the subscription still works until the tab closes */
  }
}

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padded = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function browserPushSubscription(vapidPublicKey: string): Promise<PushSubscriptionJSON> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("This browser does not support push notifications.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications were not allowed.");
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
  return subscription.toJSON();
}

export default function NotificationSettings({
  daoId,
  fetchImpl = fetch,
  apiBase = `${RELAYER_URL}/api/v1`,
}: NotificationSettingsProps) {
  const [info, setInfo] = useState<ChannelInfo | null>(null);
  const [token, setToken] = useState<string | null>(() => readToken());
  const [current, setCurrent] = useState<SubscriptionView | null>(null);
  const [channel, setChannel] = useState<Channel>("email");
  const [email, setEmail] = useState("");
  const [eventTypes, setEventTypes] = useState<EventType[]>(NOTIFICATION_EVENT_TYPES.map((e) => e.id));
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchImpl(`${apiBase}/notifications/channels`)
      .then((res) => (res.ok ? res.json() : { channels: [], vapidPublicKey: null }))
      .then((body: ChannelInfo) => {
        setInfo(body);
        if (body.channels.length > 0 && !body.channels.includes("email")) setChannel(body.channels[0]);
      })
      .catch(() => setInfo({ channels: [], vapidPublicKey: null }));
  }, [apiBase, fetchImpl]);

  useEffect(() => {
    if (!token) {
      setCurrent(null);
      return;
    }
    fetchImpl(`${apiBase}/notifications/subscriptions/${token}`)
      .then(async (res) => {
        if (res.status === 404) {
          // Expired or unsubscribed elsewhere (e.g. from an email link).
          writeToken(null);
          setToken(null);
          return;
        }
        const body: SubscriptionView = await res.json();
        setCurrent(body);
        setEventTypes(body.eventTypes.length > 0 ? body.eventTypes : NOTIFICATION_EVENT_TYPES.map((e) => e.id));
      })
      .catch(() => undefined);
  }, [apiBase, fetchImpl, token]);

  const toggle = (type: EventType) =>
    setEventTypes((types) => (types.includes(type) ? types.filter((t) => t !== type) : [...types, type]));

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setStatus(null);
    try {
      setStatus(await action());
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const subscribe = () =>
    run(async () => {
      if (eventTypes.length === 0) throw new Error("Choose at least one kind of notification.");
      const destination =
        channel === "email" ? email.trim() : await browserPushSubscription(info?.vapidPublicKey ?? "");
      const res = await fetchImpl(`${apiBase}/notifications/subscriptions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel, destination, eventTypes, daoIds: daoId ? [daoId] : [] }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not subscribe.");
      writeToken(body.token);
      setToken(body.token);
      setCurrent(body);
      return "You're subscribed.";
    });

  const save = () =>
    run(async () => {
      if (eventTypes.length === 0) throw new Error("Choose at least one kind of notification.");
      const res = await fetchImpl(`${apiBase}/notifications/subscriptions/${token}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventTypes }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not save.");
      setCurrent(body);
      return "Preferences saved.";
    });

  const unsubscribe = () =>
    run(async () => {
      await fetchImpl(`${apiBase}/notifications/subscriptions/${token}`, { method: "DELETE" });
      writeToken(null);
      setToken(null);
      setCurrent(null);
      return "You're unsubscribed.";
    });

  if (info && info.channels.length === 0) {
    return (
      <section aria-labelledby="notifications-heading" className="space-y-2">
        <h3 id="notifications-heading" className="font-semibold">Notifications</h3>
        <p className="text-sm text-muted-foreground">Notifications are not available on this server.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="notifications-heading" className="space-y-3">
      <h3 id="notifications-heading" className="font-semibold">Notifications</h3>
      <p className="text-sm text-muted-foreground">
        Your address or push subscription is never linked to your wallet or your votes.
      </p>

      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">Tell me when</legend>
        {NOTIFICATION_EVENT_TYPES.map(({ id, label }) => (
          <label key={id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={eventTypes.includes(id)} onChange={() => toggle(id)} />
            {label}
          </label>
        ))}
      </fieldset>

      {current ? (
        <div className="space-y-2">
          <p className="text-sm">
            Sending to {current.destinationHint} ({current.channel === "email" ? "email" : "browser push"}) until{" "}
            {new Date(current.expiresAt).toLocaleDateString()}.
          </p>
          <div className="flex gap-2">
            <button type="button" className="rounded-md border px-3 py-1.5 text-sm" onClick={save} disabled={busy}>
              Save preferences
            </button>
            <button type="button" className="rounded-md border px-3 py-1.5 text-sm" onClick={unsubscribe} disabled={busy}>
              Unsubscribe
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {(info?.channels.length ?? 0) > 1 && (
            <div role="radiogroup" aria-label="Channel" className="flex gap-3 text-sm">
              {info!.channels.map((c) => (
                <label key={c} className="flex items-center gap-1">
                  <input type="radio" name="notification-channel" checked={channel === c} onChange={() => setChannel(c)} />
                  {c === "email" ? "Email" : "Browser push"}
                </label>
              ))}
            </div>
          )}
          {channel === "email" && (
            <label className="block text-sm">
              Email address
              <input
                type="email"
                className="mt-1 block w-full rounded-md border px-2 py-1"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </label>
          )}
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm"
            onClick={subscribe}
            disabled={busy || !info || (channel === "email" && !email.trim())}
          >
            Subscribe
          </button>
        </div>
      )}

      {status && (
        <p role="status" className="text-sm">
          {status}
        </p>
      )}
    </section>
  );
}
