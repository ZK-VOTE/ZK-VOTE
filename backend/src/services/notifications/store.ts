/**
 * Notification preferences, keyed by anonymous contact tokens (ZV-037 / #886).
 *
 * The token is 32 random bytes handed to the subscriber once; it is the only
 * handle on a subscription (manage, change, unsubscribe). No wallet address,
 * membership or vote is stored or derivable from a row.
 */
import crypto from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import { getDb } from "../db.js";
import { config } from "../../config.js";
import { parseWebPushSubscription } from "./webpush.js";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENT_TYPES,
  type NotificationChannel,
  type NotificationEventType,
  type Subscription,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAO_IDS = 50;
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]{1,253}\.[A-Za-z]{2,}$/;

interface Row {
  token: string;
  channel: NotificationChannel;
  destination: string;
  event_types: string;
  dao_ids: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

const toSubscription = (row: Row): Subscription => ({
  token: row.token,
  channel: row.channel,
  destination: row.destination,
  eventTypes: JSON.parse(row.event_types),
  daoIds: JSON.parse(row.dao_ids),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  expiresAt: row.expires_at,
});

export class SubscriptionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionValidationError";
  }
}

export interface Preferences {
  eventTypes?: string[];
  daoIds?: string[];
}

function validateEventTypes(value: unknown): NotificationEventType[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new SubscriptionValidationError("eventTypes must be an array");
  const known = new Set<string>(NOTIFICATION_EVENT_TYPES);
  for (const type of value) {
    if (typeof type !== "string" || !known.has(type)) {
      throw new SubscriptionValidationError(
        `Unknown event type "${String(type)}"; expected ${NOTIFICATION_EVENT_TYPES.join(", ")}`,
      );
    }
  }
  return [...new Set(value as NotificationEventType[])];
}

function validateDaoIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_DAO_IDS) {
    throw new SubscriptionValidationError(`daoIds must be an array of at most ${MAX_DAO_IDS} ids`);
  }
  return [
    ...new Set(
      value.map((id) => {
        const text = String(id);
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(text)) throw new SubscriptionValidationError(`Invalid DAO id "${text}"`);
        return text;
      }),
    ),
  ];
}

function validateDestination(channel: NotificationChannel, destination: unknown): string {
  if (channel === "email") {
    if (typeof destination !== "string" || !EMAIL.test(destination.trim())) {
      throw new SubscriptionValidationError("destination must be an email address");
    }
    return destination.trim().toLowerCase();
  }
  try {
    return JSON.stringify(parseWebPushSubscription(destination));
  } catch (err) {
    throw new SubscriptionValidationError(`Invalid push subscription: ${(err as Error).message}`);
  }
}

export class SubscriptionStore {
  constructor(private readonly db: () => DatabaseType = getDb) {}

  create(input: { channel: unknown; destination: unknown } & Preferences, now = Date.now()): Subscription {
    if (!NOTIFICATION_CHANNELS.includes(input.channel as NotificationChannel)) {
      throw new SubscriptionValidationError(`channel must be one of ${NOTIFICATION_CHANNELS.join(", ")}`);
    }
    const channel = input.channel as NotificationChannel;
    const subscription: Subscription = {
      token: crypto.randomBytes(32).toString("hex"),
      channel,
      destination: validateDestination(channel, input.destination),
      eventTypes: validateEventTypes(input.eventTypes),
      daoIds: validateDaoIds(input.daoIds),
      createdAt: now,
      updatedAt: now,
      expiresAt: now + config.notifications.subscriptionTtlDays * DAY_MS,
    };
    this.db()
      .prepare(
        `INSERT INTO notification_subscriptions
           (token, channel, destination, event_types, dao_ids, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        subscription.token,
        subscription.channel,
        subscription.destination,
        JSON.stringify(subscription.eventTypes),
        JSON.stringify(subscription.daoIds),
        subscription.createdAt,
        subscription.updatedAt,
        subscription.expiresAt,
      );
    return subscription;
  }

  /** The subscription, or null when unknown or expired. */
  get(token: string, now = Date.now()): Subscription | null {
    const row = this.db()
      .prepare("SELECT * FROM notification_subscriptions WHERE token = ?")
      .get(token) as Row | undefined;
    if (!row || row.expires_at <= now) return null;
    return toSubscription(row);
  }

  /** Replaces the preferences and renews the expiry. Returns null when unknown or expired. */
  update(token: string, prefs: Preferences, now = Date.now()): Subscription | null {
    const current = this.get(token, now);
    if (!current) return null;
    const eventTypes = prefs.eventTypes === undefined ? current.eventTypes : validateEventTypes(prefs.eventTypes);
    const daoIds = prefs.daoIds === undefined ? current.daoIds : validateDaoIds(prefs.daoIds);
    const expiresAt = now + config.notifications.subscriptionTtlDays * DAY_MS;
    this.db()
      .prepare(
        `UPDATE notification_subscriptions
         SET event_types = ?, dao_ids = ?, updated_at = ?, expires_at = ?
         WHERE token = ?`,
      )
      .run(JSON.stringify(eventTypes), JSON.stringify(daoIds), now, expiresAt, token);
    return { ...current, eventTypes, daoIds, updatedAt: now, expiresAt };
  }

  /** Unsubscribes. True when a subscription was removed. */
  remove(token: string): boolean {
    return this.db().prepare("DELETE FROM notification_subscriptions WHERE token = ?").run(token).changes > 0;
  }

  /** Active subscriptions that asked for this event type and DAO. */
  matching(type: NotificationEventType, daoId: string | null | undefined, now = Date.now()): Subscription[] {
    const rows = this.db()
      .prepare("SELECT * FROM notification_subscriptions WHERE expires_at > ?")
      .all(now) as Row[];
    return rows
      .map(toSubscription)
      .filter(
        (s) =>
          (s.eventTypes.length === 0 || s.eventTypes.includes(type)) &&
          (s.daoIds.length === 0 || (daoId != null && s.daoIds.includes(String(daoId)))),
      );
  }

  /** Deletes expired subscriptions. Returns how many were removed. */
  purgeExpired(now = Date.now()): number {
    return this.db().prepare("DELETE FROM notification_subscriptions WHERE expires_at <= ?").run(now).changes;
  }
}

export const subscriptionStore = new SubscriptionStore();
