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
/**
 * Attach the confirmation WebSocket server to an existing HTTP server.
 * Safe to call multiple times; a second call is a no-op while attached.
 */
export declare function attachConfirmationHub(httpServer: HttpServer): void;
/**
 * Broadcast a confirmation event to every connected client.
 * No-op when the hub is not attached or no clients are connected.
 */
export declare function broadcastConfirmationEvent(payload: unknown): void;
/** Close the hub and terminate all connected clients (used on shutdown). */
export declare function closeConfirmationHub(): void;
export declare function getConfirmationHubStats(): {
    attached: boolean;
    connectedClients: number;
    path: string;
    enabled: boolean;
};
//# sourceMappingURL=confirmation-hub.d.ts.map