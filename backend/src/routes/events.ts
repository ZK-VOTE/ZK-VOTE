import { Router, Request, Response } from "express";
import { sseService, EventType } from "../services/sse.js";
import { webhookService } from "../services/webhook.js";

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
