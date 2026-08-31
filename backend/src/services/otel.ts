/**
 * Optional OpenTelemetry-compatible OTLP/HTTP exporter.
 *
 * The service deliberately has no hard dependency on an exporter or collector:
 * when OTEL_EXPORTER_OTLP_ENDPOINT is absent, spans are no-op. Export errors
 * are swallowed so telemetry can never affect request or indexer behavior.
 */

import { setIndexerSpanExporter, type ExportedIndexerSpan } from "./indexer-tracing.js";

import { config } from "../config.js";

const endpoint = config.otelExporterOtlpEndpoint?.replace(/\/$/, "");
const serviceName = config.otelServiceName;
const timeoutMs = config.otelExportTimeoutMs;

function toOtlpSpan(span: ExportedIndexerSpan) {
  const startUnixNano = BigInt(new Date(span.startedAt).getTime()) * 1_000_000n;
  const endUnixNano = startUnixNano + BigInt(Math.max(0, Math.round(span.durationMs * 1_000_000)));
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    kind: INTERNAL_SPAN_KIND_INTERNAL,
    startTimeUnixNano: String(startUnixNano),
    endTimeUnixNano: String(endUnixNano),
    attributes: Object.entries(span.attributes).map(([key, value]) => ({
      key,
      value: typeof value === "boolean" ? { boolValue: value } : typeof value === "number" ? { intValue: value } : { stringValue: value },
    })),
    status: span.status === "error" ? { code: 2, message: span.error } : { code: 1 },
  };
}

const INTERNAL_SPAN_KIND_INTERNAL = 1;

export function initializeTelemetry(): void {
  if (!endpoint || config.otelSdkDisabled) return;

  setIndexerSpanExporter({
    async export(span) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref();
      try {
        await fetch(`${endpoint}/v1/traces`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            resourceSpans: [{
              resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
              scopeSpans: [{ scope: { name: "zkvote" }, spans: [toOtlpSpan(span)] }],
            }],
          }),
          signal: controller.signal,
        });
      } catch {
        // Export availability must not affect application behavior.
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
