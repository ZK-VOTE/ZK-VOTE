/**
 * Pluggable notification providers (ZV-037 / #886).
 *
 * A provider delivers one rendered message to one destination on one channel.
 * Two are built in, both configured from the environment:
 *
 * - `http-email`: POSTs the message as JSON to an email relay (any
 *   transactional email API or an internal mail gateway), with a bearer token.
 * - `webpush`: encrypts the payload for the browser's PushSubscription
 *   (RFC 8291) and signs the request with VAPID (RFC 8292).
 *
 * Others (SES, SMTP, a test double) register with {@link registerProvider}.
 * A provider throws {@link DestinationGoneError} when the destination is gone
 * for good, so the subscription is removed instead of retried; anything else
 * it throws is retried by the delivery worker.
 */
import { config } from "../../config.js";
import {
  DestinationGoneError,
  type NotificationChannel,
  type RenderedMessage,
} from "./types.js";
import {
  encryptPayload,
  parseWebPushSubscription,
  vapidAuthorization,
  type VapidKeys,
} from "./webpush.js";

export interface NotificationProvider {
  name: string;
  channel: NotificationChannel;
  send(destination: string, message: RenderedMessage): Promise<void>;
}

type Fetch = typeof fetch;

/** Maps an HTTP response onto the retry contract: gone, retry, or done. */
async function checkResponse(res: Response, provider: string): Promise<void> {
  if (res.ok) return;
  if (res.status === 404 || res.status === 410) {
    throw new DestinationGoneError(`${provider}: destination gone (HTTP ${res.status})`);
  }
  throw new Error(`${provider}: HTTP ${res.status}`);
}

export function createHttpEmailProvider(options: {
  url: string;
  token: string | null;
  from: string;
  fetchImpl?: Fetch;
}): NotificationProvider {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    name: "http-email",
    channel: "email",
    async send(destination, message) {
      const res = await doFetch(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: JSON.stringify({
          from: options.from,
          to: destination,
          subject: message.subject,
          text: message.text,
          html: message.html,
          headers: {
            "List-Unsubscribe": `<${message.unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      await checkResponse(res, "http-email");
    },
  };
}

export function createWebPushProvider(options: {
  vapid: VapidKeys;
  ttlSeconds?: number;
  fetchImpl?: Fetch;
}): NotificationProvider {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    name: "webpush",
    channel: "webpush",
    async send(destination, message) {
      const subscription = parseWebPushSubscription(destination);
      const body = encryptPayload(Buffer.from(JSON.stringify(message.push)), subscription);
      const res = await doFetch(subscription.endpoint, {
        method: "POST",
        headers: {
          authorization: vapidAuthorization(subscription.endpoint, options.vapid),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(options.ttlSeconds ?? 24 * 60 * 60),
          urgency: "normal",
        },
        // A copy typed over a plain ArrayBuffer, which is what fetch's BodyInit accepts.
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(10_000),
      });
      await checkResponse(res, "webpush");
    },
  };
}

const registry = new Map<NotificationChannel, NotificationProvider>();
let configured = false;

/** Registers (or replaces) the provider for its channel. */
export function registerProvider(provider: NotificationProvider): void {
  registry.set(provider.channel, provider);
}

/** Removes every provider, including the configured ones. For tests. */
export function resetProviders(): void {
  registry.clear();
  configured = true;
}

/** Installs the providers the environment configures, once. */
function ensureConfigured(): void {
  if (configured) return;
  configured = true;
  const n = config.notifications;
  if (n.emailRelayUrl && !registry.has("email")) {
    registerProvider(createHttpEmailProvider({ url: n.emailRelayUrl, token: n.emailRelayToken, from: n.emailFrom }));
  }
  if (n.vapidPublicKey && n.vapidPrivateKey && !registry.has("webpush")) {
    registerProvider(
      createWebPushProvider({
        vapid: { publicKey: n.vapidPublicKey, privateKey: n.vapidPrivateKey, subject: n.vapidSubject },
      }),
    );
  }
}

export function getProvider(channel: NotificationChannel): NotificationProvider | undefined {
  ensureConfigured();
  return registry.get(channel);
}

/** The channels a subscriber can choose right now. */
export function availableChannels(): NotificationChannel[] {
  ensureConfigured();
  return [...registry.keys()];
}
