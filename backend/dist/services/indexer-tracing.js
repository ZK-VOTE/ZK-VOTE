/** Lightweight W3C-compatible tracing for one complete indexer cycle. */
import { randomBytes } from "node:crypto";
const noopExporter = { export: () => undefined };
let activeExporter = noopExporter;
export function setIndexerSpanExporter(exporter) {
    activeExporter = exporter ?? noopExporter;
}
function randomHex(bytes) {
    return randomBytes(bytes).toString("hex");
}
async function exportSpan(span) {
    try {
        await activeExporter.export(span);
    }
    catch {
        // Telemetry must never make the indexer fail or replay a ledger range.
    }
}
export async function withIndexerSpan(name, parent, attributes, operation) {
    const context = {
        traceId: parent?.traceId ?? randomHex(16),
        spanId: randomHex(8),
        traceFlags: "01",
    };
    const startedAt = new Date();
    const startedNs = process.hrtime.bigint();
    let status = "ok";
    let errorMessage;
    try {
        return await operation(context);
    }
    catch (error) {
        status = "error";
        errorMessage = error instanceof Error ? error.message : String(error);
        throw error;
    }
    finally {
        const durationMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
        await exportSpan({
            ...context,
            name,
            parentSpanId: parent?.spanId,
            traceparent: `00-${context.traceId}-${context.spanId}-${context.traceFlags}`,
            startedAt: startedAt.toISOString(),
            durationMs,
            status,
            attributes,
            ...(errorMessage ? { error: errorMessage } : {}),
        });
    }
}
//# sourceMappingURL=indexer-tracing.js.map