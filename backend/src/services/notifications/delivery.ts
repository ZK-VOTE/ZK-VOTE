/**
 * Notification delivery through the durable job outbox (ZV-037 / #886).
 *
 * Publishing an event writes one job per matching subscription into the
 * persisted `jobs` table and returns; a worker drains the outbox in batches.
 * Delivery therefore does not depend on the SSE process (or any open
 * connection): a notification survives restarts and is retried with
 * exponential back-off until it is sent or dead-lettered.
 *
 * A job carries the event and the subscriber's contact token, never the
 * destination; the destination is read at send time, so an unsubscribe
 * between publishing and sending is honoured.
 */
import crypto from "node:crypto";
import { config } from "../../config.js";
import { createLogger } from "../logger.js";
import { ackJob, claimJob, enqueueJob, nackJob } from "../durable-jobs.js";
import { getDb } from "../db.js";
import { notificationDeadLetterTotal, notificationDeliveriesTotal } from "../metrics.js";
import { getProvider } from "./providers.js";
import { subscriptionStore, type SubscriptionStore } from "./store.js";
import { renderNotification } from "./templates.js";
import { DestinationGoneError, type NotificationEvent } from "./types.js";

const logger = createLogger({ component: "notifications" });
export const NOTIFICATION_JOB_TYPE = "notification";

interface NotificationJobPayload {
  token: string;
  event: NotificationEvent;
}

const destinationKey = (destination: string): string =>
  crypto.createHash("sha256").update(destination).digest("hex").slice(0, 32);

/**
 * Queues `event` for every active subscription that asked for it. One job per
 * destination: the business key makes a re-published event, or two
 * subscriptions with the same destination, a single delivery.
 *
 * @returns the number of subscriptions queued.
 */
export function publishNotificationEvent(
  event: NotificationEvent,
  store: SubscriptionStore = subscriptionStore,
): number {
  const matches = store.matching(event.type, event.daoId);
  for (const subscription of matches) {
    const payload: NotificationJobPayload = { token: subscription.token, event };
    enqueueJob({
      job_type: NOTIFICATION_JOB_TYPE,
      payload: payload as unknown as Record<string, unknown>,
      business_key: `notify:${event.id}:${subscription.channel}:${destinationKey(subscription.destination)}`,
      max_attempts: config.notifications.maxAttempts,
    });
  }
  if (matches.length > 0) {
    logger.info("notification_event_queued", { type: event.type, subscriptions: matches.length });
  }
  return matches.length;
}

/**
 * Publishes without ever throwing into the caller: notification delivery must
 * not break the indexer or an admin action that triggered it.
 */
export function publishNotificationEventSafely(event: NotificationEvent): void {
  try {
    publishNotificationEvent(event);
  } catch (err) {
    logger.warn("notification_publish_failed", { type: event.type, error: (err as Error).message });
  }
}

export interface BatchResult {
  sent: number;
  retried: number;
  deadLettered: number;
  gone: number;
  skipped: number;
}

/** Sends up to `limit` queued notifications. */
export async function processNotificationBatch(
  options: { limit?: number; store?: SubscriptionStore } = {},
): Promise<BatchResult> {
  const limit = options.limit ?? config.notifications.batchSize;
  const store = options.store ?? subscriptionStore;
  const result: BatchResult = { sent: 0, retried: 0, deadLettered: 0, gone: 0, skipped: 0 };

  for (let i = 0; i < limit; i += 1) {
    const job = claimJob(NOTIFICATION_JOB_TYPE);
    if (!job) break;

    let payload: NotificationJobPayload;
    try {
      payload = JSON.parse(job.payload) as NotificationJobPayload;
    } catch {
      ackJob(job.id);
      result.skipped += 1;
      continue;
    }

    const subscription = store.get(payload.token);
    if (!subscription) {
      // Unsubscribed or expired since the event was queued.
      ackJob(job.id);
      notificationDeliveriesTotal.inc({ channel: "unknown", result: "skipped" });
      result.skipped += 1;
      continue;
    }

    const channel = subscription.channel;
    try {
      const provider = getProvider(channel);
      if (!provider) throw new Error(`No ${channel} provider configured`);
      const message = renderNotification(payload.event, {
        publicUrl: config.notifications.publicUrl,
        token: subscription.token,
      });
      await provider.send(subscription.destination, message);
      ackJob(job.id);
      notificationDeliveriesTotal.inc({ channel, result: "sent" });
      result.sent += 1;
    } catch (err) {
      if (err instanceof DestinationGoneError) {
        // The address or push subscription no longer exists: stop sending to it.
        store.remove(subscription.token);
        ackJob(job.id);
        notificationDeliveriesTotal.inc({ channel, result: "gone" });
        logger.info("notification_destination_gone", { channel });
        result.gone += 1;
        continue;
      }
      nackJob(job.id, (err as Error).message);
      const status = getDb().prepare("SELECT status FROM jobs WHERE id = ?").get(job.id) as
        | { status: string }
        | undefined;
      if (status?.status === "dead") {
        notificationDeadLetterTotal.inc({ channel });
        result.deadLettered += 1;
      } else {
        result.retried += 1;
      }
      notificationDeliveriesTotal.inc({ channel, result: "retry" });
      logger.warn("notification_delivery_failed", { channel, attempt: job.attempt_count, error: (err as Error).message });
    }
  }
  return result;
}

/** Drains the outbox on an interval and purges expired subscriptions hourly. */
export function startNotificationWorker(intervalMs = 5_000): () => void {
  let running = false;
  const tick = setInterval(() => {
    if (running) return;
    running = true;
    processNotificationBatch()
      .catch((err) => logger.error("notification_batch_failed", { error: (err as Error).message }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  const purge = setInterval(() => {
    try {
      const removed = subscriptionStore.purgeExpired();
      if (removed > 0) logger.info("notification_subscriptions_expired", { removed });
    } catch (err) {
      logger.warn("notification_purge_failed", { error: (err as Error).message });
    }
  }, 60 * 60 * 1000);
  tick.unref?.();
  purge.unref?.();
  return () => {
    clearInterval(tick);
    clearInterval(purge);
  };
}
