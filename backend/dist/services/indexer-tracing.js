/**
 * Indexer-facing view of the shared relay tracing pipeline (#321).
 *
 * The indexer used to own a private span implementation. It now delegates to
 * `services/tracing.ts` so a poll cycle, the database writes it drives and the
 * Soroban RPC calls underneath all land in one trace with a single exporter
 * registry. The original surface is kept intact for existing call sites.
 */
import { registerSpanExporter, clearSpanExporters, withSpan, } from "./tracing.js";
let disposeCurrent = null;
/**
 * Install a single indexer exporter, replacing any previous one.
 *
 * Retained for compatibility with the indexer's original one-exporter model.
 * New code should call `registerSpanExporter` directly, which composes.
 */
export function setIndexerSpanExporter(exporter) {
    disposeCurrent?.();
    disposeCurrent = null;
    if (exporter)
        disposeCurrent = registerSpanExporter(exporter);
}
/** Remove every exporter, including ones registered outside this module. */
export function resetIndexerSpanExporters() {
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
export async function withIndexerSpan(name, parent, attributes, operation) {
    return withSpan(name, attributes, operation, parent ? { parent } : {});
}
//# sourceMappingURL=indexer-tracing.js.map