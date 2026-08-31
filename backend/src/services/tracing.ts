/**
 * End-to-End W3C Trace Context for the relay pipeline (#321)
 *
 * A single trace follows a unit of work across every hop of the
 * anonymity-critical path: inbound HTTP request -> indexer poll -> database
 * write -> Soroban RPC call. Each hop opens a child span whose parent is the
 * ambient span carried in an `AsyncLocalStorage`, so callers never have to
 * thread a context argument through unrelated function signatures.
 *
 * Two properties matter more than completeness here:
 *
 *  1. Telemetry must never change program behaviour. Exporters are invoked
 *     defensively and their failures are swallowed.
 *  2. Spans must never leak anonymity-relevant material. Every attribute is
 *     passed through {@link redactSpanAttributes} before export, so nullifiers,
 *     Merkle roots, proofs and raw addresses become salted digests.
 *
 * @see https://www.w3.org/TR/trace-context/
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";

// ============================================
// TYPES
// ============================================

export type SpanAttributeValue = boolean | number | string;
export type SpanAttributes = Record<string, SpanAttributeValue>;

/** Minimal W3C span context: the identifiers needed to build a traceparent. */
export interface SpanContext {
  traceId: string;
  spanId: string;
  /** Always sampled — this pipeline is low volume and audit relevant. */
  traceFlags: "01";
}

export interface ExportedSpan extends SpanContext {
  name: string;
  parentSpanId?: string;
  traceparent: string;
  startedAt: string;
  durationMs: number;
  status: "ok" | "error";
  attributes: SpanAttributes;
  error?: string;
}

export interface SpanExporter {
  export(span: ExportedSpan): Promise<void> | void;
}

// ============================================
// TRACEPARENT PARSING / FORMATTING
// ============================================

const TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

/**
 * Parse a W3C `traceparent` header into a span context.
 *
 * Returns `null` when the header is absent or malformed, and also for the
 * all-zero trace/span IDs the spec declares invalid. Callers should start a
 * fresh trace in that case rather than propagating an unusable ID.
 */
export function parseTraceparent(
  header: string | undefined | null,
): SpanContext | null {
  if (!header) return null;
  const match = TRACEPARENT_RE.exec(header.trim());
  if (!match) return null;

  const traceId = match[2].toLowerCase();
  const spanId = match[3].toLowerCase();
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return null;

  return { traceId, spanId, traceFlags: "01" };
}

/** Render a span context as a W3C `traceparent` header value. */
export function formatTraceparent(context: SpanContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.traceFlags}`;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** Mint a child context under `parent`, or a brand new trace when null. */
export function createSpanContext(parent?: SpanContext | null): SpanContext {
  return {
    traceId: parent?.traceId ?? randomHex(16),
    spanId: randomHex(8),
    traceFlags: "01",
  };
}

// ============================================
// REDACTION
// ============================================

/**
 * Attribute names whose values identify a voter, a ballot, or a credential.
 * Matching is substring based and case insensitive so `vote_nullifier` and
 * `nullifierHash` are both covered.
 */
const SENSITIVE_ATTRIBUTE_PATTERNS = [
  "nullifier",
  "proof",
  "merkle_root",
  "merkleroot",
  "commitment",
  "secret",
  "password",
  "passphrase",
  "authorization",
  "cookie",
  "session",
  "token",
  "apikey",
  "api_key",
  "privkey",
  "private_key",
  "ciphertext",
  "plaintext",
  "alias",
  "share",
  "ip",
  "email",
];

/**
 * Values that look like raw cryptographic material even under an innocuous
 * key — long hex strings, Stellar public keys — are digested too.
 */
const LONG_HEX_RE = /^(0x)?[0-9a-f]{32,}$/i;
const STELLAR_ADDRESS_RE = /^[GC][A-Z2-7]{55}$/;

/** Process-lifetime salt so digests cannot be dictionary-matched offline. */
const REDACTION_SALT = randomBytes(16);

/** Stable, non-reversible short digest used in place of a redacted value. */
export function digestValue(value: string): string {
  return createHash("sha256")
    .update(REDACTION_SALT)
    .update(value)
    .digest("hex")
    .slice(0, 16);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_ATTRIBUTE_PATTERNS.some((pattern) =>
    normalized.includes(pattern.replace(/[^a-z0-9]/g, "")),
  );
}

/**
 * Replace anonymity-relevant attribute values with salted digests.
 *
 * The key is preserved so a trace stays navigable ("this span had a
 * nullifier") while the value stops being a correlation handle. Numbers and
 * booleans under a sensitive key are dropped to `"[redacted]"` because their
 * range is usually small enough to invert.
 */
export function redactSpanAttributes(
  attributes: SpanAttributes,
): SpanAttributes {
  const redacted: SpanAttributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (isSensitiveKey(key)) {
      redacted[key] =
        typeof value === "string" ? `sha256:${digestValue(value)}` : "[redacted]";
      continue;
    }

    if (
      typeof value === "string" &&
      (LONG_HEX_RE.test(value) || STELLAR_ADDRESS_RE.test(value))
    ) {
      redacted[key] = `sha256:${digestValue(value)}`;
      continue;
    }

    redacted[key] = value;
  }

  return redacted;
}

// ============================================
// EXPORTER REGISTRY
// ============================================

const exporters = new Set<SpanExporter>();

/**
 * Register a span exporter. Returns a disposer; tests use it to guarantee the
 * registry is left clean even when an assertion throws.
 */
export function registerSpanExporter(exporter: SpanExporter): () => void {
  exporters.add(exporter);
  return () => {
    exporters.delete(exporter);
  };
}

/** Drop every registered exporter (test helper). */
export function clearSpanExporters(): void {
  exporters.clear();
}

/** Collects spans in memory. Intended for tests and local debugging. */
export class InMemorySpanExporter implements SpanExporter {
  readonly spans: ExportedSpan[] = [];

  export(span: ExportedSpan): void {
    this.spans.push(span);
  }

  /** All spans belonging to one trace, in completion order. */
  byTrace(traceId: string): ExportedSpan[] {
    return this.spans.filter((span) => span.traceId === traceId);
  }

  find(name: string): ExportedSpan | undefined {
    return this.spans.find((span) => span.name === name);
  }

  reset(): void {
    this.spans.length = 0;
  }
}

async function exportSpan(span: ExportedSpan): Promise<void> {
  for (const exporter of exporters) {
    try {
      await exporter.export(span);
    } catch {
      // Telemetry must never make the pipeline fail or replay a ledger range.
    }
  }
}

// ============================================
// AMBIENT CONTEXT
// ============================================

const contextStorage = new AsyncLocalStorage<SpanContext>();

/** The span context of the innermost enclosing span, if any. */
export function getActiveSpanContext(): SpanContext | null {
  return contextStorage.getStore() ?? null;
}

/** The traceparent header value for the ambient context, if any. */
export function getActiveTraceparent(): string | undefined {
  const context = getActiveSpanContext();
  return context ? formatTraceparent(context) : undefined;
}

/**
 * Run `fn` with `context` installed as ambient. Used by the HTTP middleware,
 * which owns a span for the whole request rather than a single call.
 */
export function runWithSpanContext<T>(context: SpanContext, fn: () => T): T {
  return contextStorage.run(context, fn);
}

// ============================================
// SPANS
// ============================================

export interface SpanOptions {
  /** Explicit parent. Defaults to the ambient context. */
  parent?: SpanContext | null;
}

/**
 * Run `operation` inside a span and export it when it settles.
 *
 * The span's context becomes ambient for the duration of `operation`, so any
 * nested `withSpan` — a database write inside a poll cycle, an RPC call inside
 * that write — is automatically parented without argument threading.
 *
 * The operation's own result and thrown errors pass through untouched; the
 * span only observes them.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  operation: (context: SpanContext) => Promise<T> | T,
  options: SpanOptions = {},
): Promise<T> {
  const parent =
    options.parent === undefined ? getActiveSpanContext() : options.parent;
  const context = createSpanContext(parent);

  const startedAt = new Date();
  const startedNs = process.hrtime.bigint();
  let status: ExportedSpan["status"] = "ok";
  let errorMessage: string | undefined;

  try {
    return await runWithSpanContext(context, () => operation(context));
  } catch (error) {
    status = "error";
    errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const durationMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
    await exportSpan({
      ...context,
      name,
      parentSpanId: parent?.spanId,
      traceparent: formatTraceparent(context),
      startedAt: startedAt.toISOString(),
      durationMs,
      status,
      attributes: redactSpanAttributes(attributes),
      ...(errorMessage ? { error: errorMessage } : {}),
    });
  }
}
