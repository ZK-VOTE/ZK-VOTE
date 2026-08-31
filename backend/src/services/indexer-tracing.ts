/**
 * Indexer-facing view of the shared relay tracing pipeline (#321).
 *
 * The indexer used to own a private span implementation. It now delegates to
 * `services/tracing.ts` so a poll cycle, the database writes it drives and the
 * Soroban RPC calls underneath all land in one trace with a single exporter
 * registry. The original surface is kept intact for existing call sites.
 */

import {
  registerSpanExporter,
  clearSpanExporters,
  withSpan,
  type ExportedSpan,
  type SpanAttributes,
  type SpanContext,
  type SpanExporter,
} from "./tracing.js";

export type { SpanAttributes };

/** @deprecated Use `SpanContext` from `services/tracing.js`. */
export type IndexerSpanContext = SpanContext;

/** @deprecated Use `ExportedSpan` from `services/tracing.js`. */
export type ExportedIndexerSpan = ExportedSpan;

/** @deprecated Use `SpanExporter` from `services/tracing.js`. */
export type IndexerSpanExporter = SpanExporter;

let disposeCurrent: (() => void) | null = null;

/**
 * Install a single indexer exporter, replacing any previous one.
 *
 * Retained for compatibility with the indexer's original one-exporter model.
 * New code should call `registerSpanExporter` directly, which composes.
 */
export function setIndexerSpanExporter(
  exporter: IndexerSpanExporter | null,
): void {
  disposeCurrent?.();
  disposeCurrent = null;
  if (exporter) disposeCurrent = registerSpanExporter(exporter);
}

/** Remove every exporter, including ones registered outside this module. */
export function resetIndexerSpanExporters(): void {
  disposeCurrent = null;
  clearSpanExporters();
}

/**
 * Open a span for one step of an indexer cycle.
 *
 * `parent` is explicit here — the indexer builds its span tree from a root
 * cycle span it holds directly — but a `null` parent still inherits any
 * ambient context, so a poll triggered from an HTTP request joins that trace.
 */
export async function withIndexerSpan<T>(
  name: string,
  parent: IndexerSpanContext | null,
  attributes: SpanAttributes,
  operation: (context: IndexerSpanContext) => Promise<T> | T,
): Promise<T> {
  return withSpan(name, attributes, operation, parent ? { parent } : {});
}
