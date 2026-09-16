/**
 * Optional OpenTelemetry-compatible OTLP/HTTP exporter.
 *
 * The service deliberately has no hard dependency on an exporter or collector:
 * when OTEL_EXPORTER_OTLP_ENDPOINT is absent, spans are no-op. Export errors
 * are swallowed so telemetry can never affect request or indexer behavior.
 */
export declare function initializeTelemetry(): void;
//# sourceMappingURL=otel.d.ts.map