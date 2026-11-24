import crypto from "crypto";
import dns from "dns/promises";
import net from "net";
import { log } from "./logger.js";
import { SSEEvent, EventType } from "./sse.js";
import { getWriteDb, getReadDb, isDbInitialized } from "./db.js";
import {
  webhookQueueDepth,
  webhookAttemptsTotal,
  webhookDeadLetterTotal,
  webhookDeliveryDuration,
} from "./metrics.js";

export interface WebhookSubscription {
  id: string;
  url: string;
  secret: string;
  eventTypes: Set<EventType>;
  daoIds: Set<string>;
  active: boolean;
  rateLimitPerMinute: number;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDeliveryRecord {
  id?: number;
  outboxId: number;
  subscriptionId: string;
  attempt: number;
  statusCode?: number;
  responseBody?: string;
  error?: string;
  durationMs: number;
  createdAt?: string;
}

export interface OutboxItem {
  id: number;
  eventId: string;
  eventType: EventType;
  daoId?: string;
  payload: string;
  status: "pending" | "processing" | "delivered" | "dead_letter";
  retryCount: number;
  nextAttemptAt: number;
  lastError?: string;
  createdAt: string;
  processedAt?: string;
}

// ============================================
// SSRF VALIDATION
// ============================================

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map((n) => parseInt(n, 10));
    if (parts.length !== 4 || parts.some(isNaN)) return true;

    // 0.0.0.0/8 (Current network)
    if (parts[0] === 0) return true;
    // 10.0.0.0/8 (Private)
    if (parts[0] === 10) return true;
    // 127.0.0.0/8 (Loopback)
    if (parts[0] === 127) return true;
    // 169.254.0.0/16 (Link-local / Cloud metadata service e.g. 169.254.169.254)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 172.16.0.0/12 (Private: 172.16.0.0 - 172.31.255.255)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16 (Private)
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 224.0.0.0/4 (Multicast)
    if (parts[0] >= 224 && parts[0] <= 239) return true;
    // 240.0.0.0/4 (Reserved)
    if (parts[0] >= 240) return true;
    // 255.255.255.255 (Broadcast)
    if (ip === "255.255.255.255") return true;

    return false;
  }

  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    // Loopback
    if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
    // Unspecified
    if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return true;
    // Link-local: fe80::/10 (fe80 - febf)
    if (/^fe[89ab]/i.test(normalized)) return true;
    // Unique local address: fc00::/7 (fc00 - fdff)
    if (/^f[cd]/i.test(normalized)) return true;
    // IPv4-mapped IPv6: ::ffff:a.b.c.d
    if (normalized.startsWith("::ffff:")) {
      const v4Part = normalized.replace("::ffff:", "");
      if (net.isIPv4(v4Part)) {
        return isPrivateIp(v4Part);
      }
    }
    return false;
  }

  return true;
}

export async function assertSafeWebhookUrl(urlString: string): Promise<void> {
  // Allow test / local dev override if explicitly set in environment
  if (process.env.ALLOW_PRIVATE_WEBHOOKS === "true") {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid webhook URL: ${urlString}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid webhook protocol: ${parsed.protocol}. Only http and https are permitted.`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost and standard loopback hostnames
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error(`SSRF security block: Target host "${hostname}" is a private or local domain.`);
  }

  // If host is an explicit IP literal
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`SSRF security block: Target IP "${hostname}" is private or link-local.`);
    }
    return;
  }

  // Resolve hostname through DNS and verify all returned addresses
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    if (!addresses || addresses.length === 0) {
      throw new Error(`Could not resolve hostname: ${hostname}`);
    }

    for (const record of addresses) {
      if (isPrivateIp(record.address)) {
        throw new Error(
          `SSRF security block: Target host "${hostname}" resolved to private or link-local address ${record.address}.`,
        );
      }
    }
  } catch (err: any) {
    if (err.message && err.message.startsWith("SSRF security block")) {
      throw err;
    }
    throw new Error(`SSRF DNS lookup failed for ${hostname}: ${err.message}`);
  }
}

// ============================================
// HMAC SIGNATURE SCHEME
// ============================================

export function signWebhookPayload(
  payloadString: string,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): { signature: string; timestamp: number } {
  const content = `${timestamp}.${payloadString}`;
  const hmac = crypto.createHmac("sha256", secret).update(content).digest("hex");
  return {
    signature: `v1=${hmac}`,
    timestamp,
  };
}

export function verifyWebhookSignature(
  payloadString: string,
  signatureHeader: string,
  timestampHeader: string | number,
  secret: string,
  toleranceSeconds: number = 300,
): boolean {
  if (!signatureHeader || !timestampHeader || !secret) return false;

  const timestamp = typeof timestampHeader === "string" ? parseInt(timestampHeader, 10) : timestampHeader;
  if (isNaN(timestamp)) return false;

  // Replay prevention: verify freshness within tolerance
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return false;
  }

  const expectedContent = `${timestamp}.${payloadString}`;
  const expectedHmac = `v1=${crypto.createHmac("sha256", secret).update(expectedContent).digest("hex")}`;

  try {
    const sigBuffer = Buffer.from(signatureHeader, "utf8");
    const expBuffer = Buffer.from(expectedHmac, "utf8");
    if (sigBuffer.length !== expBuffer.length) return false;
    return crypto.timingSafeEqual(sigBuffer, expBuffer);
  } catch {
    return false;
  }
}

// ============================================
// RATE LIMITER & SUBSCRIPTION MANAGER
// ============================================

class TokenBucketRateLimiter {
  private tokens: Map<string, { count: number; lastRefill: number }> = new Map();

  consume(subscriptionId: string, limitPerMinute: number): boolean {
    const now = Date.now();
    let bucket = this.tokens.get(subscriptionId);
    if (!bucket) {
      bucket = { count: limitPerMinute, lastRefill: now };
      this.tokens.set(subscriptionId, bucket);
    } else {
      const elapsed = now - bucket.lastRefill;
      const refill = Math.floor((elapsed / 60000) * limitPerMinute);
      if (refill > 0) {
        bucket.count = Math.min(limitPerMinute, bucket.count + refill);
        bucket.lastRefill = now;
      }
    }

    if (bucket.count > 0) {
      bucket.count--;
      return true;
    }
    return false;
  }
}

// ============================================
// PERSISTENT WEBHOOK SERVICE
// ============================================

export class PersistentWebhookService {
  private rateLimiter = new TokenBucketRateLimiter();
  private processing = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly maxRetries = 5;

  constructor() {
    // Periodically process queue every 2 seconds
    this.timer = setInterval(() => {
      this.processOutbox().catch((err) => {
        log("error", "webhook_outbox_timer_error", { error: err.message });
      });
    }, 2000);
  }

  public shutdown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Register subscription in persistent SQLite storage
  public async registerWebhook(
    url: string,
    eventTypes?: EventType[],
    daoIds?: string[],
    secret?: string,
    rateLimitPerMinute: number = 60,
  ): Promise<WebhookSubscription> {
    await assertSafeWebhookUrl(url);

    const id = crypto.randomBytes(16).toString("hex");
    const generatedSecret = secret || crypto.randomBytes(32).toString("hex");
    const eventTypesStr = (eventTypes || []).join(",");
    const daoIdsStr = (daoIds || []).join(",");
    const now = new Date().toISOString();

    const sub: WebhookSubscription = {
      id,
      url,
      secret: generatedSecret,
      eventTypes: new Set(eventTypes || []),
      daoIds: new Set(daoIds || []),
      active: true,
      rateLimitPerMinute,
      createdAt: now,
      updatedAt: now,
    };

    if (isDbInitialized()) {
      try {
        const db = getWriteDb();
        db.prepare(
          `INSERT INTO webhook_subscriptions (id, url, secret, event_types, dao_ids, active, rate_limit_per_minute, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        ).run(id, url, generatedSecret, eventTypesStr, daoIdsStr, rateLimitPerMinute, now, now);
      } catch (err: any) {
        log("error", "webhook_register_db_error", { error: err.message });
      }
    }

    log("info", "webhook_registered", { id, url });
    return sub;
  }

  public removeWebhook(id: string): boolean {
    if (isDbInitialized()) {
      try {
        const db = getWriteDb();
        db.prepare("DELETE FROM webhook_subscriptions WHERE id = ?").run(id);
      } catch (err: any) {
        log("error", "webhook_delete_db_error", { error: err.message });
        return false;
      }
    }
    log("info", "webhook_removed", { id });
    return true;
  }

  public listSubscriptions(): WebhookSubscription[] {
    if (!isDbInitialized()) return [];
    try {
      const db = getReadDb();
      const rows = db.prepare("SELECT * FROM webhook_subscriptions WHERE active = 1").all() as any[];
      return rows.map((r) => ({
        id: r.id,
        url: r.url,
        secret: r.secret,
        eventTypes: new Set(r.event_types ? r.event_types.split(",").filter(Boolean) : []),
        daoIds: new Set(r.dao_ids ? r.dao_ids.split(",").filter(Boolean) : []),
        active: Boolean(r.active),
        rateLimitPerMinute: r.rate_limit_per_minute || 60,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
    } catch (err: any) {
      log("error", "webhook_list_db_error", { error: err.message });
      return [];
    }
  }

  // Atomically enqueue event into persistent transactional outbox
  public async notifyWebhooks(event: SSEEvent): Promise<string> {
    const eventId = crypto.randomUUID();
    const payloadStr = JSON.stringify(event);
    const now = new Date().toISOString();

    if (isDbInitialized()) {
      try {
        const db = getWriteDb();
        db.prepare(
          `INSERT INTO webhook_outbox (event_id, event_type, dao_id, payload, status, retry_count, next_attempt_at, created_at)
           VALUES (?, ?, ?, ?, 'pending', 0, 0, ?)`,
        ).run(eventId, event.type, event.daoId || null, payloadStr, now);

        this.updateQueueDepthMetric();
      } catch (err: any) {
        log("error", "webhook_enqueue_error", { eventId, error: err.message });
      }
    }

    // Trigger asynchronous queue drain
    setImmediate(() => {
      this.processOutbox().catch(() => {});
    });

    return eventId;
  }

  // Outbox delivery worker
  public async processOutbox(): Promise<void> {
    if (this.processing || !isDbInitialized()) return;
    this.processing = true;

    try {
      const db = getWriteDb();
      const nowMs = Date.now();

      // Fetch pending items ready for delivery
      const items = db
        .prepare(
          `SELECT * FROM webhook_outbox
           WHERE status = 'pending' AND next_attempt_at <= ?
           ORDER BY id ASC LIMIT 20`,
        )
        .all(nowMs) as any[];

      if (items.length === 0) {
        this.updateQueueDepthMetric();
        return;
      }

      const subscriptions = this.listSubscriptions();

      for (const item of items) {
        let matchingSubscriptions = subscriptions.filter((sub) => {
          if (sub.daoIds.size > 0 && item.dao_id && !sub.daoIds.has(item.dao_id)) return false;
          if (sub.eventTypes.size > 0 && !sub.eventTypes.has(item.event_type)) return false;
          return true;
        });

        // Mark processing
        db.prepare("UPDATE webhook_outbox SET status = 'processing' WHERE id = ?").run(item.id);

        let anyFailed = false;
        let lastErrorMsg = "";

        if (matchingSubscriptions.length === 0) {
          // No subscribers for this event, mark delivered directly
          db.prepare("UPDATE webhook_outbox SET status = 'delivered', processed_at = ? WHERE id = ?").run(
            new Date().toISOString(),
            item.id,
          );
          continue;
        }

        for (const sub of matchingSubscriptions) {
          // Apply per-subscriber rate limiting
          if (!this.rateLimiter.consume(sub.id, sub.rateLimitPerMinute)) {
            anyFailed = true;
            lastErrorMsg = `Rate limit exceeded for subscriber ${sub.id}`;
            continue;
          }

          const attemptNum = item.retry_count + 1;
          const startTime = Date.now();
          const timestamp = Math.floor(startTime / 1000);
          const { signature } = signWebhookPayload(item.payload, sub.secret, timestamp);

          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);

            const res = await fetch(sub.url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-ZKVote-Signature": signature,
                "X-ZKVote-Timestamp": String(timestamp),
                "X-ZKVote-Event-Id": item.event_id,
                "X-ZKVote-Event-Type": item.event_type,
                "User-Agent": "ZKVote-Webhook-Delivery/1.0",
              },
              body: item.payload,
              signal: controller.signal,
            });

            clearTimeout(timeout);
            const durationSec = (Date.now() - startTime) / 1000;

            if (res.ok) {
              webhookAttemptsTotal.inc({ status: "success", event_type: item.event_type.toLowerCase() });
              webhookDeliveryDuration.observe({ status: "success" }, durationSec);

              this.recordDelivery(item.id, sub.id, attemptNum, res.status, "", undefined, Math.round(durationSec * 1000));
            } else {
              anyFailed = true;
              lastErrorMsg = `HTTP ${res.status} ${res.statusText}`;
              webhookAttemptsTotal.inc({ status: "failure", event_type: item.event_type.toLowerCase() });
              webhookDeliveryDuration.observe({ status: "failure" }, durationSec);

              this.recordDelivery(item.id, sub.id, attemptNum, res.status, "", lastErrorMsg, Math.round(durationSec * 1000));
            }
          } catch (fetchErr: any) {
            anyFailed = true;
            lastErrorMsg = fetchErr.message || "Network error";
            const durationSec = (Date.now() - startTime) / 1000;

            webhookAttemptsTotal.inc({ status: "failure", event_type: item.event_type.toLowerCase() });
            webhookDeliveryDuration.observe({ status: "failure" }, durationSec);

            this.recordDelivery(item.id, sub.id, attemptNum, 0, "", lastErrorMsg, Math.round(durationSec * 1000));
          }
        }

        if (!anyFailed) {
          db.prepare("UPDATE webhook_outbox SET status = 'delivered', processed_at = ? WHERE id = ?").run(
            new Date().toISOString(),
            item.id,
          );
        } else {
          const newRetryCount = item.retry_count + 1;
          if (newRetryCount >= this.maxRetries) {
            // Move to Dead-Letter Queue (DLQ)
            db.prepare(
              `UPDATE webhook_outbox
               SET status = 'dead_letter', retry_count = ?, last_error = ?, processed_at = ?
               WHERE id = ?`,
            ).run(newRetryCount, lastErrorMsg, new Date().toISOString(), item.id);

            webhookDeadLetterTotal.inc({ event_type: item.event_type.toLowerCase() });
            log("warn", "webhook_dead_letter", {
              eventId: item.event_id,
              eventType: item.event_type,
              error: lastErrorMsg,
            });
          } else {
            // Exponential backoff with jitter: min(60s, 1s * 2^attempt + jitter)
            const jitterMs = Math.floor(Math.random() * 500);
            const backoffMs = Math.min(60000, 1000 * Math.pow(2, newRetryCount - 1)) + jitterMs;
            const nextAttempt = Date.now() + backoffMs;

            db.prepare(
              `UPDATE webhook_outbox
               SET status = 'pending', retry_count = ?, next_attempt_at = ?, last_error = ?
               WHERE id = ?`,
            ).run(newRetryCount, nextAttempt, lastErrorMsg, item.id);
          }
        }
      }

      this.updateQueueDepthMetric();
    } catch (err: any) {
      log("error", "webhook_process_outbox_error", { error: err.message });
    } finally {
      this.processing = false;
    }
  }

  private recordDelivery(
    outboxId: number,
    subscriptionId: string,
    attempt: number,
    statusCode: number,
    responseBody: string,
    error: string | undefined,
    durationMs: number,
  ) {
    if (!isDbInitialized()) return;
    try {
      const db = getWriteDb();
      db.prepare(
        `INSERT INTO webhook_deliveries (outbox_id, subscription_id, attempt, status_code, response_body, error, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(outboxId, subscriptionId, attempt, statusCode, responseBody || null, error || null, durationMs, new Date().toISOString());
    } catch {}
  }

  // DLQ Replay: re-queues dead letters
  public replayDeadLetters(options: { daoId?: string; eventType?: string; limit?: number } = {}): number {
    if (!isDbInitialized()) return 0;
    try {
      const db = getWriteDb();
      let query = "UPDATE webhook_outbox SET status = 'pending', retry_count = 0, next_attempt_at = 0 WHERE status = 'dead_letter'";
      const params: any[] = [];

      if (options.daoId) {
        query += " AND dao_id = ?";
        params.push(options.daoId);
      }
      if (options.eventType) {
        query += " AND event_type = ?";
        params.push(options.eventType);
      }

      const res = db.prepare(query).run(...params);
      this.updateQueueDepthMetric();
      setImmediate(() => this.processOutbox().catch(() => {}));
      return res.changes;
    } catch (err: any) {
      log("error", "webhook_replay_error", { error: err.message });
      return 0;
    }
  }

  private updateQueueDepthMetric() {
    if (!isDbInitialized()) return;
    try {
      const db = getReadDb();
      const row = db.prepare("SELECT COUNT(*) as count FROM webhook_outbox WHERE status = 'pending'").get() as any;
      webhookQueueDepth.set(row?.count || 0);
    } catch {}
  }
}

export const webhookService = new PersistentWebhookService();
