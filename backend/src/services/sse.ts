import { Request, Response } from "express";
import { log } from "./logger.js";
import { getReadDb, isDbInitialized } from "./db.js";

// Event types
export type EventType =
  | "VOTE_CAST"
  | "PROPOSAL_UPDATED"
  | "DAO_UPDATED"
  | "ELECTION_STATUS"
  | "COMMENT_POSTED"
  | "HEARTBEAT";

export interface SSEEvent {
  id?: string | number;
  type: EventType;
  daoId?: string;
  data: any;
}

interface ClientConnection {
  id: string;
  res: Response;
  daoIds: Set<string>;
  eventTypes: Set<EventType>;
}

const MAX_CONNECTIONS_PER_IP = 100;

class SSEService {
  private clients: Map<string, ClientConnection> = new Map();
  private ipConnectionCounts: Map<string, number> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private eventCounter: number = Date.now();

  constructor() {
    this.startHeartbeat();
  }

  public handleConnection(req: Request, res: Response) {
    const ip = req.ip || req.socket.remoteAddress || "unknown";

    // Check limits
    const currentCount = this.ipConnectionCounts.get(ip) || 0;
    if (currentCount >= MAX_CONNECTIONS_PER_IP) {
      res.status(429).json({ error: "Too many connections from this IP" });
      return;
    }

    // CORS & Security Posture
    const origin = (req.headers.origin as string) || "";
    const configuredOrigins = process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim())
      : [
          "http://localhost:5173",
          "http://localhost:3000",
          "http://localhost:8080",
          "https://app.zkvote.net",
          "https://server.zkvote.net",
        ];

    let effectiveOrigin: string | null = null;
    if (origin) {
      if (configuredOrigins.includes(origin) || configuredOrigins.includes("*")) {
        effectiveOrigin = origin;
      }
    }

    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Vary": "Origin",
    };

    if (effectiveOrigin) {
      headers["Access-Control-Allow-Origin"] = effectiveOrigin;
      headers["Access-Control-Allow-Credentials"] = "true";
    }

    res.writeHead(200, headers);
    res.write("retry: 3000\n\n");

    const clientId = Math.random().toString(36).substring(2, 15);

    // Parse filters
    const daoIds = req.query.daoIds
      ? new Set((req.query.daoIds as string).split(","))
      : new Set<string>();
    const eventTypes = req.query.eventTypes
      ? new Set((req.query.eventTypes as string).split(",") as EventType[])
      : new Set<EventType>();

    // SSE Backfill using event cursor (Last-Event-ID header or ?cursor= / ?lastEventId=)
    const cursor = (req.headers["last-event-id"] || req.query.cursor || req.query.lastEventId) as string;
    if (cursor && isDbInitialized()) {
      try {
        const db = getReadDb();
        const cursorNum = parseInt(cursor, 10);
        if (!isNaN(cursorNum) && cursorNum >= 0) {
          const rows = db
            .prepare(
              `SELECT id, event_id, event_type, dao_id, payload, created_at
               FROM webhook_outbox
               WHERE id > ?
               ORDER BY id ASC LIMIT 200`,
            )
            .all(cursorNum) as any[];

          for (const row of rows) {
            if (daoIds.size > 0 && row.dao_id && !daoIds.has(row.dao_id)) continue;
            if (eventTypes.size > 0 && !eventTypes.has(row.event_type as EventType)) continue;

            res.write(`id: ${row.id}\nevent: ${row.event_type}\ndata: ${row.payload}\n\n`);
          }
        }
      } catch (err: any) {
        log("warn", "sse_backfill_failed", { clientId, cursor, error: err.message });
      }
    }

    const client: ClientConnection = {
      id: clientId,
      res,
      daoIds,
      eventTypes,
    };

    this.clients.set(clientId, client);
    this.ipConnectionCounts.set(ip, currentCount + 1);

    log("info", "sse_client_connected", { clientId, ip, currentCount: currentCount + 1 });

    req.on("close", () => {
      this.clients.delete(clientId);
      const count = this.ipConnectionCounts.get(ip) || 1;
      if (count <= 1) {
        this.ipConnectionCounts.delete(ip);
      } else {
        this.ipConnectionCounts.set(ip, count - 1);
      }
      log("info", "sse_client_disconnected", { clientId, ip });
    });
  }

  public broadcast(event: SSEEvent) {
    const eventId = event.id || ++this.eventCounter;
    const payload = `id: ${eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

    this.clients.forEach((client) => {
      if (client.daoIds.size > 0 && event.daoId && !client.daoIds.has(event.daoId)) {
        return;
      }
      if (client.eventTypes.size > 0 && !client.eventTypes.has(event.type)) {
        return;
      }

      client.res.write(payload);
    });
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.broadcast({ type: "HEARTBEAT", data: { timestamp: Date.now() } });
    }, 30000);
  }

  public stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
}

export const sseService = new SSEService();
