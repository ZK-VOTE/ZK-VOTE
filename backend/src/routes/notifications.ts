/**
 * Notification preferences (ZV-037 / #886).
 *
 *   GET    /notifications/channels                which channels are configured, and the VAPID key
 *   POST   /notifications/subscriptions           { channel, destination, eventTypes?, daoIds? } → { token, … }
 *   GET    /notifications/subscriptions/:token    current preferences
 *   PATCH  /notifications/subscriptions/:token    { eventTypes?, daoIds? } — also renews the expiry
 *   DELETE /notifications/subscriptions/:token    unsubscribe
 *   GET|POST /notifications/unsubscribe?token=…   one-click unsubscribe (email links, List-Unsubscribe-Post)
 *
 * The contact token is the only credential: it is random, returned once, and
 * never tied to a wallet. Responses never echo the destination in full.
 */
import { Router, type Request, type Response } from "express";
import { bodyLimit } from "../middleware/bodyLimit.js";
import { queryLimiter } from "../middleware/rateLimit.js";
import { config } from "../config.js";
import { log } from "../services/logger.js";
import {
  availableChannels,
  NOTIFICATION_EVENT_TYPES,
  subscriptionStore,
  SubscriptionValidationError,
  type Subscription,
} from "../services/notifications/index.js";

const router = Router();
const TOKEN = /^[0-9a-f]{64}$/;

/** What a subscriber sees: preferences, and only a hint of the destination. */
function publicView(subscription: Subscription) {
  let destinationHint: string;
  if (subscription.channel === "email") {
    const [user, domain] = subscription.destination.split("@");
    destinationHint = `${user.slice(0, 1)}***@${domain}`;
  } else {
    destinationHint = new URL(JSON.parse(subscription.destination).endpoint).host;
  }
  return {
    channel: subscription.channel,
    destinationHint,
    eventTypes: subscription.eventTypes,
    daoIds: subscription.daoIds,
    expiresAt: new Date(subscription.expiresAt).toISOString(),
  };
}

function tokenParam(req: Request): string | null {
  const token = String(req.params.token ?? req.query.token ?? "");
  return TOKEN.test(token) ? token : null;
}

router.get("/notifications/channels", queryLimiter, (_req: Request, res: Response) => {
  res.json({
    channels: availableChannels(),
    eventTypes: NOTIFICATION_EVENT_TYPES,
    vapidPublicKey: config.notifications.vapidPublicKey,
  });
});

router.post(
  "/notifications/subscriptions",
  bodyLimit("10kb"),
  queryLimiter,
  (req: Request, res: Response) => {
    const { channel, destination, eventTypes, daoIds } = req.body ?? {};
    if (!availableChannels().includes(channel)) {
      return res.status(400).json({ error: `Channel "${String(channel)}" is not available` });
    }
    try {
      const subscription = subscriptionStore.create({ channel, destination, eventTypes, daoIds });
      log("info", "notification_subscribed", { channel: subscription.channel });
      res.status(201).json({ token: subscription.token, ...publicView(subscription) });
    } catch (err) {
      if (err instanceof SubscriptionValidationError) return res.status(400).json({ error: err.message });
      throw err;
    }
  },
);

router.get("/notifications/subscriptions/:token", queryLimiter, (req: Request, res: Response) => {
  const token = tokenParam(req);
  const subscription = token ? subscriptionStore.get(token) : null;
  if (!subscription) return res.status(404).json({ error: "Subscription not found or expired" });
  res.json(publicView(subscription));
});

router.patch(
  "/notifications/subscriptions/:token",
  bodyLimit("10kb"),
  queryLimiter,
  (req: Request, res: Response) => {
    const token = tokenParam(req);
    try {
      const subscription = token
        ? subscriptionStore.update(token, { eventTypes: req.body?.eventTypes, daoIds: req.body?.daoIds })
        : null;
      if (!subscription) return res.status(404).json({ error: "Subscription not found or expired" });
      res.json(publicView(subscription));
    } catch (err) {
      if (err instanceof SubscriptionValidationError) return res.status(400).json({ error: err.message });
      throw err;
    }
  },
);

function unsubscribe(req: Request, res: Response): void {
  const token = tokenParam(req);
  // Same answer whether or not the token existed: an unsubscribe link reveals nothing.
  if (token) subscriptionStore.remove(token);
  if (req.method === "GET" && req.accepts(["html", "json"]) === "html") {
    res.type("html").send("<!doctype html><p>You are unsubscribed from ZK-VOTE notifications.</p>");
    return;
  }
  res.status(200).json({ unsubscribed: true });
}

router.delete("/notifications/subscriptions/:token", queryLimiter, unsubscribe);
router.get("/notifications/unsubscribe", queryLimiter, unsubscribe);
router.post("/notifications/unsubscribe", queryLimiter, unsubscribe);

export default router;
