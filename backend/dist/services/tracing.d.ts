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
/**
 * Parse a W3C `traceparent` header into a span context.
 *
 * Returns `null` when the header is absent or malformed, and also for the
 * all-zero trace/span IDs the spec declares invalid. Callers should start a
 * fresh trace in that case rather than propagating an unusable ID.
 */
export declare function parseTraceparent(header: string | undefined | null): SpanContext | null;
/** Render a span context as a W3C `traceparent` header value. */
export declare function formatTraceparent(context: SpanContext): string;
/** Mint a child context under `parent`, or a brand new trace when null. */
export declare function createSpanContext(parent?: SpanContext | null): SpanContext;
/** Stable, non-reversible short digest used in place of a redacted value. */
export declare function digestValue(value: string): string;
/**
 * Replace anonymity-relevant attribute values with salted digests.
 *
 * The key is preserved so a trace stays navigable ("this span had a
 * nullifier") while the value stops being a correlation handle. Numbers and
 * booleans under a sensitive key are dropped to `"[redacted]"` because their
 * range is usually small enough to invert.
 */
export declare function redactSpanAttributes(attributes: SpanAttributes): SpanAttributes;
/**
 * Register a span exporter. Returns a disposer; tests use it to guarantee the
 * registry is left clean even when an assertion throws.
 */
export declare function registerSpanExporter(exporter: SpanExporter): () => void;
/** Drop every registered exporter (test helper). */
export declare function clearSpanExporters(): void;
/** Collects spans in memory. Intended for tests and local debugging. */
export declare class InMemorySpanExporter implements SpanExporter {
    readonly spans: ExportedSpan[];
    export(span: ExportedSpan): void;
    /** All spans belonging to one trace, in completion order. */
    byTrace(traceId: string): ExportedSpan[];
    find(name: string): ExportedSpan | undefined;
    reset(): void;
}
/** The span context of the innermost enclosing span, if any. */
export declare function getActiveSpanContext(): SpanContext | null;
/** The traceparent header value for the ambient context, if any. */
export declare function getActiveTraceparent(): string | undefined;
/**
 * Run `fn` with `context` installed as ambient. Used by the HTTP middleware,
 * which owns a span for the whole request rather than a single call.
 */
export declare function runWithSpanContext<T>(context: SpanContext, fn: () => T): T;
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
export declare function withSpan<T>(name: string, attributes: SpanAttributes, operation: (context: SpanContext) => Promise<T> | T, options?: SpanOptions): Promise<T>;
//# sourceMappingURL=tracing.d.ts.map