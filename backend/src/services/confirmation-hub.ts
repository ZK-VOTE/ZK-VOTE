/**
 * Confirmation WebSocket Hub (#172)
 *
 * Attaches a WebSocket server to the relayer's HTTP server and broadcasts
 * transaction-confirmation events to connected frontends as soon as the
 * confirmation worker resolves them. This replaces slow frontend polling:
 * a client opens a socket at `CONFIRMATION_WS_PATH`, and confirmation events
 * are pushed the moment they arrive.
 *
 * The hub is intentionally non-fatal: if attaching fails (e.g. `ws` is
 * unavailable or the server is not yet listening) it logs a warning and
 * the HTTP confirmation-status endpoint remains the fallback.
 */

import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket, type Server as WsServer } from "ws";
import { config } from "../config.js";
import { log, hashIp } from "./logger.js";
import { wsConnections, wsMessagesSent, wsAuthDuration, wsMessageDuration, wsRateLimitTotal } from "./metrics.js";
import { incWithDrilldown } from "./metric-drilldown.js";

let wss: WsServer | null = null;
let attachFailed = false;

/**
 * Attach the confirmation WebSocket server to an existing HTTP server.
 * Safe to call multiple times; a second call is a no-op while attached.
 */
export function attachConfirmationHub(httpServer: HttpServer): void {
  if (attachFailed || !config.confirmationWsEnabled) return;
  if (wss) return;

  try {
    wss = new WebSocketServer({
      server: httpServer,
      path: config.confirmationWsPath,
      // Apply rate limiting at the WebSocket level
      clientTracking: true,
      maxPayload: 1 * 1024 * 1024, // 1MB max payload
    });

    // Track connection attempts for rate limiting
    const connectionAttempts = new Map<string, number>();

    wss.on("connection", (socket, req) => {
      const ip = req.socket.remoteAddress || "unknown";
      const now = Date.now();

      // Simple rate limiting per IP
      const lastAttempt = connectionAttempts.get(ip);
      if (lastAttempt && now - lastAttempt < 2000) {
        // More than 1 connection per 2 seconds
        // Aggregate counter only; the client is on the drill-down record,
        // hashed (#749) — an IP label would let a botnet mint series.
        incWithDrilldown(wsRateLimitTotal, {}, { client: hashIp(ip) }, { level: "warn" });
        socket.close(1008, "Rate limit exceeded");
        return;
      }
      connectionAttempts.set(ip, now);

      // Clean up old entries
      if (connectionAttempts.size > 1000) {
        for (const [key, timestamp] of connectionAttempts.entries()) {
          if (now - timestamp > 60000) {
            connectionAttempts.delete(key);
          }
        }
      }

      const authStart = performance.now();
      wsConnections.inc();

      socket.on("close", () => {
        wsConnections.dec();
      });

      socket.on("error", () => {
        // Per-socket errors (e.g. client dropped mid-frame) are expected; the
        // `close` handler already decrements the gauge.
      });

      socket.on("message", (data) => {
        const msgStart = performance.now();
        // Process message...
        const msgDuration = performance.now() - msgStart;
        wsMessageDuration.observe(msgDuration);
      });

      const authDuration = performance.now() - authStart;
      wsAuthDuration.observe(authDuration);
    });

    log("info", "confirmation_ws_attached", {
      path: config.confirmationWsPath,
      rateLimitEnabled: true,
    });
  } catch (err) {
    attachFailed = true;
    log("warn", "confirmation_ws_attach_failed", {
      error: (err as Error).message,
    });
  }
}

/**
 * Broadcast a confirmation event to every connected client.
 * No-op when the hub is not attached or no clients are connected.
 */
export function broadcastConfirmationEvent(payload: unknown): void {
  if (!wss) return;
  const message = JSON.stringify(payload);
  let sent = 0;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
      sent++;
    }
  }
  if (sent > 0) wsMessagesSent.inc(sent);
}

/** Close the hub and terminate all connected clients (used on shutdown). */
export function closeConfirmationHub(): void {
  if (!wss) return;
  for (const client of wss.clients) {
    try {
      client.terminate();
    } catch {
      // already closed
    }
  }
  wss.close();
  wss = null;
  log("info", "confirmation_ws_closed");
}

export function getConfirmationHubStats(): {
  attached: boolean;
  connectedClients: number;
  path: string;
  enabled: boolean;
} {
  return {
    attached: wss !== null,
    connectedClients: wss ? wss.clients.size : 0,
    path: config.confirmationWsPath,
    enabled: config.confirmationWsEnabled,
  };
}
