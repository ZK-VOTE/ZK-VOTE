import { Router, Request, Response } from "express";
import { sseService, EventType } from "../services/sse.js";
import { webhookService } from "../services/webhook.js";
import { getTokenSnapshot } from "../services/token-snapshot.js";

export const eventsRoutes = Router();

// GET /events/stream
// Query params: daoIds (comma separated), eventTypes (comma separated)
eventsRoutes.get("/events/stream", (req: Request, res: Response) => {
  sseService.handleConnection(req, res);
});

// POST /events/webhook
// Body: { url: string, eventTypes?: string[], daoIds?: string[] }
eventsRoutes.post("/events/webhook", (req: Request, res: Response) => {
  const { url, eventTypes, daoIds } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }

  const id = webhookService.registerWebhook(url, eventTypes as EventType[], daoIds);
  res.status(201).json({ id });
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
