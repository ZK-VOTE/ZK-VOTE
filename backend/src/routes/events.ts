import { Router, Request, Response } from "express";
import { sseService, EventType } from "../services/sse.js";
import { webhookService } from "../services/webhook.js";
import { getTokenSnapshot } from "../services/token-snapshot.js";
import { getReadDb, isDbInitialized } from "../services/db.js";

export const eventsRoutes = Router();

// GET /events/stream
// Query params: daoIds (comma separated), eventTypes (comma separated), cursor (optional event ID)
eventsRoutes.get("/events/stream", (req: Request, res: Response) => {
  sseService.handleConnection(req, res);
});

// POST /events/webhook
// Body: { url: string, eventTypes?: string[], daoIds?: string[], secret?: string, rateLimit?: number }
eventsRoutes.post("/events/webhook", async (req: Request, res: Response) => {
  const { url, eventTypes, daoIds, secret, rateLimit } = req.body;

  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }

  try {
    const sub = await webhookService.registerWebhook(
      url,
      eventTypes as EventType[],
      daoIds,
      secret,
      rateLimit ? parseInt(String(rateLimit), 10) : 60,
    );

    res.status(201).json({
      id: sub.id,
      url: sub.url,
      secret: sub.secret,
      eventTypes: Array.from(sub.eventTypes),
      daoIds: Array.from(sub.daoIds),
      active: sub.active,
      rateLimitPerMinute: sub.rateLimitPerMinute,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Failed to register webhook" });
  }
});

// DELETE /events/webhook/:id
eventsRoutes.delete("/events/webhook/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const removed = webhookService.removeWebhook(id);
  if (!removed) {
    return res.status(404).json({ error: "Subscription not found" });
  }
  res.json({ success: true, id });
});

// GET /events/webhook/subscriptions
eventsRoutes.get("/events/webhook/subscriptions", (_req: Request, res: Response) => {
  const list = webhookService.listSubscriptions();
  res.json({
    subscriptions: list.map((s) => ({
      id: s.id,
      url: s.url,
      eventTypes: Array.from(s.eventTypes),
      daoIds: Array.from(s.daoIds),
      active: s.active,
      rateLimitPerMinute: s.rateLimitPerMinute,
      createdAt: s.createdAt,
    })),
  });
});

// POST /events/webhook/dlq/replay - Replay Dead Letter Queue items
eventsRoutes.post("/events/webhook/dlq/replay", (req: Request, res: Response) => {
  const { daoId, eventType, limit } = req.body || {};
  const replayed = webhookService.replayDeadLetters({
    daoId: daoId ? String(daoId) : undefined,
    eventType: eventType ? (eventType as EventType) : undefined,
    limit: limit ? parseInt(String(limit), 10) : undefined,
  });

  res.json({ success: true, replayed });
});

// GET /events/webhook/dlq - List Dead Letter Queue summary
eventsRoutes.get("/events/webhook/dlq", (_req: Request, res: Response) => {
  if (!isDbInitialized()) {
    return res.json({ deadLetters: [] });
  }
  try {
    const db = getReadDb();
    const rows = db
      .prepare(
        `SELECT id, event_id, event_type, dao_id, retry_count, last_error, created_at, processed_at
         FROM webhook_outbox
         WHERE status = 'dead_letter'
         ORDER BY id DESC LIMIT 100`,
      )
      .all();
    res.json({ deadLetters: rows });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to query dead letters", details: err.message });
  }
});

// GET /events/token-snapshot
// Query params: address (required), ledger (optional, defaults to latest indexed)
// Returns audited balance/delegate snapshot at the given ledger with a verification proof.
eventsRoutes.get("/events/token-snapshot", (req: Request, res: Response) => {
  const { address, ledger } = req.query;
  if (!address || typeof address !== "string") {
    return res.status(400).json({ error: "address is required" });
  }
  const atLedger = ledger !== undefined ? parseInt(String(ledger), 10) : Number.MAX_SAFE_INTEGER;
  if (isNaN(atLedger) || atLedger < 0) {
    return res.status(400).json({ error: "ledger must be a non-negative integer" });
  }
  try {
    const snapshot = getTokenSnapshot(address, atLedger);
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: "snapshot query failed", detail: (err as Error).message });
  }
});
