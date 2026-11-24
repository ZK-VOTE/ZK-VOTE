/**
 * Notification delivery (ZV-037 / #886) — shared types.
 *
 * Notifications are opt-in and anonymous: a subscription is a destination
 * (an email address or a WebPush subscription) plus preferences, keyed by a
 * random contact token. Nothing links it to a wallet, a membership or a vote.
 */

/** The events a subscriber can opt into. */
export const NOTIFICATION_EVENT_TYPES = [
  "election_started",
  "election_ended",
  "dispute_outcome",
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export const NOTIFICATION_CHANNELS = ["email", "webpush"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** An event worth telling subscribers about. `data` may hold user content; templates escape it. */
export interface NotificationEvent {
  /** Stable id, so a re-published event is not delivered twice (e.g. `proposal_closed:12:7`). */
  id: string;
  type: NotificationEventType;
  /** The DAO the event belongs to, for per-DAO preferences. */
  daoId?: string | null;
  data: {
    daoName?: string | null;
    proposalId?: string | number | null;
    proposalTitle?: string | null;
    /** ISO time the election closes (election_started) or closed (election_ended). */
    at?: string | null;
    /** dispute_outcome: the resolution text. */
    outcome?: string | null;
  };
}

/** A rendered message, ready for a provider. */
export interface RenderedMessage {
  subject: string;
  text: string;
  html: string;
  /** One-click unsubscribe link (also sent as List-Unsubscribe for email). */
  unsubscribeUrl: string;
  /** Short payload for a push notification. */
  push: { title: string; body: string; url: string };
}

/** A browser PushSubscription, as `PushSubscription.toJSON()` returns it. */
export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface Subscription {
  token: string;
  channel: NotificationChannel;
  /** An email address, or a serialized {@link WebPushSubscription}. */
  destination: string;
  /** Empty means every event type. */
  eventTypes: NotificationEventType[];
  /** Empty means every DAO. */
  daoIds: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

/** A provider rejected the destination for good (unknown address, expired push subscription). */
export class DestinationGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DestinationGoneError";
  }
}
