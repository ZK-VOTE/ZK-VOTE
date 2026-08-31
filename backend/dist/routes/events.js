import { Router } from "express";
import { sseService } from "../services/sse.js";
import { webhookService } from "../services/webhook.js";
export const eventsRoutes = Router();
// GET /events/stream
// Query params: daoIds (comma separated), eventTypes (comma separated)
eventsRoutes.get("/events/stream", (req, res) => {
    sseService.handleConnection(req, res);
});
// POST /events/webhook
// Body: { url: string, eventTypes?: string[], daoIds?: string[] }
eventsRoutes.post("/events/webhook", (req, res) => {
    const { url, eventTypes, daoIds } = req.body;
    if (!url) {
        return res.status(400).json({ error: "url is required" });
    }
    const id = webhookService.registerWebhook(url, eventTypes, daoIds);
    res.status(201).json({ id });
});
//# sourceMappingURL=events.js.map