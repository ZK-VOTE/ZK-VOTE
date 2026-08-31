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
import { log } from "./logger.js";
import { wsConnections, wsMessagesSent } from "./metrics.js";

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
    });

    wss.on("connection", (socket) => {
      wsConnections.inc();
      socket.on("close", () => wsConnections.dec());
      socket.on("error", () => {
        // Per-socket errors (e.g. client dropped mid-frame) are expected; the
        // `close` handler already decrements the gauge.
      });
    });

    log("info", "confirmation_ws_attached", {
      path: config.confirmationWsPath,
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
