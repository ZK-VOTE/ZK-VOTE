/**
 * Anchor Service — multi-anchor SEP-6/24/31 adapter for USDC/EURC inflow/outflow.
 *
 * One `AnchorClient` interface normalizes both Circle anchors: getTransaction,
 * deposit, withdraw and send. HTTP transport, URLs, logging and the callback
 * handler are injected (`initAnchor` / `createAnchorAdapter`) so tests never
 * touch the network. The legacy exports (`sep6Deposit`, `sep6Withdraw`,
 * `sep31Send`, `anchorFor`) remain as aliases over the default adapter.
 *
 * Callbacks are idempotent end-to-end: the adapter deduplicates on event id
 * before delegating to settlement reconciliation, which in turn deduplicates
 * on (anchor, externalTxId) and applies the state machine's conflict rule.
 */

import crypto from "node:crypto";
import type { LoggerPort } from "./interfaces.js";
import { log as moduleLog } from "./logger.js";
import {
  handleAnchorCallback as reconcileCallback,
  type AnchorCallbackEvent,
  type AnchorCallbackKind,
  type CallbackResult,
} from "./settlementReconciliation.js";

export type AnchorId = "USDC" | "EURC";

export interface AnchorTransaction {
  id: string;
  status: string;
  asset?: string;
  amount?: string;
  [key: string]: unknown;
}

/** Normalized client surface shared by every anchor. */
export interface AnchorClient {
  readonly id: AnchorId;
  readonly baseUrl: string;
  getTransaction(externalTxId: string): Promise<AnchorTransaction>;
  deposit(account: string, amount: string): Promise<AnchorTransaction>;
  withdraw(account: string, amount: string, dest: string): Promise<AnchorTransaction>;
  send(payload: Record<string, unknown>): Promise<AnchorTransaction>;
}

export interface AnchorAdapterDeps {
  urls?: Partial<Record<AnchorId, string>>;
  /** HTTP implementation (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  logger?: LoggerPort;
  /** Callback sink (defaults to settlement reconciliation). */
  onCallback?: (event: AnchorCallbackEvent) => Promise<CallbackResult> | CallbackResult;
}

export interface AnchorAdapter {
  client(anchor: AnchorId): AnchorClient;
  getTransaction(anchor: AnchorId, externalTxId: string): Promise<AnchorTransaction>;
  deposit(anchor: AnchorId, account: string, amount: string): Promise<AnchorTransaction>;
  withdraw(anchor: AnchorId, account: string, amount: string, dest: string): Promise<AnchorTransaction>;
  send(anchor: AnchorId, payload: Record<string, unknown>): Promise<AnchorTransaction>;
  /** Normalize a raw webhook body into a canonical callback event. */
  normalize(raw: Record<string, unknown>, anchor: AnchorId): AnchorCallbackEvent;
  /**
   * Deliver a callback once. Returns null when this adapter already saw the
   * event id (adapter-level idempotency), otherwise the reconciliation result.
   */
  processCallback(event: AnchorCallbackEvent): Promise<CallbackResult | null>;
  processedEventIds(): readonly string[];
}

const DEFAULT_URLS: Record<AnchorId, string> = {
  USDC: "https://anchor.circle.com",
  EURC: "https://anchor.eurc.circle.com",
};

const fallbackLogger: LoggerPort = {
  debug: (event, meta) => moduleLog("debug", event, meta),
  info: (event, meta) => moduleLog("info", event, meta),
  warn: (event, meta) => moduleLog("warn", event, meta),
  error: (event, meta) => moduleLog("error", event, meta),
  log: (level, event, meta) => moduleLog(level, event, meta),
};

function urlFor(anchor: AnchorId, urls?: Partial<Record<AnchorId, string>>): string {
  const envKey = anchor === "USDC" ? "ANCHOR_USDC_URL" : "ANCHOR_EURC_URL";
  return urls?.[anchor] ?? process.env[envKey] ?? DEFAULT_URLS[anchor];
}

/** Build one normalized anchor client over an injected fetch implementation. */
export function createAnchorClient(
  anchor: AnchorId,
  baseUrl: string,
  fetchImpl: typeof fetch,
  logger: LoggerPort,
): AnchorClient {
  const request = async (path: string, init?: RequestInit): Promise<AnchorTransaction> => {
    const response = await fetchImpl(`${baseUrl}${path}`, init);
    const body = (await response.json()) as AnchorTransaction;
    if (!response.ok) {
      const message = `anchor ${anchor} request failed (${response.status}): ${JSON.stringify(body).slice(0, 500)}`;
      logger.error("anchor_request_failed", { anchor, path, status: response.status });
      throw new Error(message);
    }
    return body;
  };

  return {
    id: anchor,
    baseUrl,
    getTransaction: (externalTxId) =>
      request(`/sep6/transaction?id=${encodeURIComponent(externalTxId)}`),
    deposit: (account, amount) =>
      request(
        `/sep6/deposit?asset=${anchor}&account=${encodeURIComponent(account)}&amount=${encodeURIComponent(amount)}`,
      ),
    withdraw: (account, amount, dest) =>
      request(
        `/sep6/withdraw?asset=${anchor}&account=${encodeURIComponent(account)}&amount=${encodeURIComponent(amount)}&dest=${encodeURIComponent(dest)}`,
      ),
    send: (payload) =>
      request("/sep31/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
  };
}

const CALLBACK_KINDS: Record<string, AnchorCallbackKind> = {
  anchor_confirmed: "anchor_confirmed",
  confirmed: "anchor_confirmed",
  sep6_confirmed: "anchor_confirmed",
  settled: "settled",
  settlement_confirmed: "settled",
  completed: "settled",
  complete: "settled",
  failed: "failed",
  error: "failed",
  rejected: "failed",
  disputed: "disputed",
  dispute: "disputed",
  chargeback: "disputed",
};

function pick(raw: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null) return raw[key];
  }
  return undefined;
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Convert an anchor webhook body (snake_case or camelCase) to the canonical
 * callback event. If no event id is supplied, a deterministic hash of the
 * body is used so byte-identical redeliveries are still deduplicated.
 */
export function normalizeAnchorCallback(
  raw: Record<string, unknown>,
  anchor: AnchorId,
): AnchorCallbackEvent {
  const rawKind = String(pick(raw, "kind", "type", "status", "event_type") ?? "confirmed").toLowerCase();
  const kind = CALLBACK_KINDS[rawKind] ?? "anchor_confirmed";
  const externalTxId = String(
    pick(raw, "external_tx_id", "externalTxId", "tx_id", "txid", "transaction_id", "id") ?? "",
  );
  const rawEventId = pick(raw, "event_id", "eventId", "id");
  const eventId =
    rawEventId !== undefined
      ? String(rawEventId)
      : crypto
          .createHash("sha256")
          .update(`${anchor}|${externalTxId}|${JSON.stringify(raw)}`)
          .digest("hex")
          .slice(0, 32);
  const rawObservedAt = pick(raw, "observed_at", "observedAt", "timestamp", "created_at");
  const observedAt =
    typeof rawObservedAt === "number"
      ? rawObservedAt
      : typeof rawObservedAt === "string"
        ? Date.parse(rawObservedAt)
        : Date.now();

  return {
    eventId,
    anchor,
    externalTxId,
    kind,
    asset: (pick(raw, "asset") as string | undefined) ?? anchor,
    grossMinor: raw.gross_minor === undefined ? undefined : finiteNumber(raw.gross_minor, 0),
    netMinor: raw.net_minor === undefined ? undefined : finiteNumber(raw.net_minor, 0),
    feeBreakdown: (pick(raw, "fee_breakdown", "feeBreakdown") as AnchorCallbackEvent["feeBreakdown"]) ?? undefined,
    ledgerVersion: finiteNumber(pick(raw, "ledger_version", "ledgerVersion", "ledger"), 0),
    observedAt: finiteNumber(observedAt, Date.now()),
    payload: raw,
  };
}

/** Create an isolated adapter (tests / composition root). */
export function createAnchorAdapter(deps: AnchorAdapterDeps = {}): AnchorAdapter {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const logger = deps.logger ?? fallbackLogger;
  const onCallback = deps.onCallback ?? reconcileCallback;
  const clients = new Map<AnchorId, AnchorClient>();
  const seenEventIds = new Set<string>();

  const client = (anchor: AnchorId): AnchorClient => {
    let existing = clients.get(anchor);
    if (!existing) {
      existing = createAnchorClient(anchor, urlFor(anchor, deps.urls), fetchImpl, logger);
      clients.set(anchor, existing);
    }
    return existing;
  };

  return {
    client,
    getTransaction: (anchor, externalTxId) => client(anchor).getTransaction(externalTxId),
    deposit: (anchor, account, amount) => client(anchor).deposit(account, amount),
    withdraw: (anchor, account, amount, dest) => client(anchor).withdraw(account, amount, dest),
    send: (anchor, payload) => client(anchor).send(payload),
    normalize: normalizeAnchorCallback,
    processCallback(event) {
      if (seenEventIds.has(event.eventId)) {
        logger.info("anchor_callback_duplicate", { eventId: event.eventId, anchor: event.anchor });
        return Promise.resolve(null);
      }
      seenEventIds.add(event.eventId);
      return Promise.resolve(onCallback(event));
    },
    processedEventIds: () => [...seenEventIds],
  };
}

// ===========================================================================
// Module-level default adapter + legacy aliases
// ===========================================================================

let defaultAdapter: AnchorAdapter | undefined;

/** Wire the default adapter's dependencies (composition root / tests). */
export function initAnchor(deps: AnchorAdapterDeps): void {
  defaultAdapter = createAnchorAdapter(deps);
}

function adapter(): AnchorAdapter {
  if (!defaultAdapter) defaultAdapter = createAnchorAdapter();
  return defaultAdapter;
}

/** Backwards-compatible alias: USDC/EURC SEP-6 deposit. */
export async function sep6Deposit(asset: AnchorId, account: string, amount: string) {
  return adapter().deposit(asset, account, amount);
}

/** Backwards-compatible alias: USDC/EURC SEP-6 withdrawal. */
export async function sep6Withdraw(asset: AnchorId, account: string, amount: string, dest: string) {
  return adapter().withdraw(asset, account, amount, dest);
}

/** Backwards-compatible alias: USDC/EURC SEP-31 send. */
export async function sep31Send(asset: AnchorId, payload: Record<string, unknown>) {
  return adapter().send(asset, payload);
}

/** Backwards-compatible alias for the anchor base URL. */
export function anchorFor(asset: AnchorId): string {
  return adapter().client(asset).baseUrl;
}

/** Deliver a raw anchor webhook through the default adapter (idempotent). */
export function processAnchorCallback(
  raw: Record<string, unknown>,
  anchor: AnchorId,
): Promise<CallbackResult | null> {
  const instance = adapter();
  return instance.processCallback(instance.normalize(raw, anchor));
}
