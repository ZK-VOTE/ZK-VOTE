import { Request, Response } from "express";
import { log } from "./logger.js";

// Event types
export type EventType = "VOTE_CAST" | "PROPOSAL_UPDATED" | "DAO_UPDATED" | "ELECTION_STATUS" | "COMMENT_POSTED" | "HEARTBEAT";

export interface SSEEvent {
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

const MAX_CONNECTIONS_PER_IP = 100; // Limits

class SSEService {
  private clients: Map<string, ClientConnection> = new Map();
  private ipConnectionCounts: Map<string, number> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;

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

    // Set headers for SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    res.write("retry: 3000\n\n");

    const clientId = Math.random().toString(36).substring(2, 15);
    
    // Parse filters
    const daoIds = req.query.daoIds ? new Set((req.query.daoIds as string).split(",")) : new Set<string>();
    const eventTypes = req.query.eventTypes ? new Set((req.query.eventTypes as string).split(",") as EventType[]) : new Set<EventType>();

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
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    
    this.clients.forEach((client) => {
      // Check filters
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

  public stop() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    this.clients.forEach((client) => {
      client.res.end();
    });
    this.clients.clear();
    this.ipConnectionCounts.clear();
  }
}

export const sseService = new SSEService();
