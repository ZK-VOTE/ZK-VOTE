/** Lightweight W3C-compatible tracing for one complete indexer cycle. */
export type SpanAttributes = Record<string, boolean | number | string>;
export interface IndexerSpanContext {
    traceId: string;
    spanId: string;
    traceFlags: "01";
}
export interface ExportedIndexerSpan extends IndexerSpanContext {
    name: string;
    parentSpanId?: string;
    traceparent: string;
    startedAt: string;
    durationMs: number;
    status: "ok" | "error";
    attributes: SpanAttributes;
    error?: string;
}
export interface IndexerSpanExporter {
    export(span: ExportedIndexerSpan): Promise<void> | void;
}
export declare function setIndexerSpanExporter(exporter: IndexerSpanExporter | null): void;
export declare function withIndexerSpan<T>(name: string, parent: IndexerSpanContext | null, attributes: SpanAttributes, operation: (context: IndexerSpanContext) => Promise<T> | T): Promise<T>;
//# sourceMappingURL=indexer-tracing.d.ts.map