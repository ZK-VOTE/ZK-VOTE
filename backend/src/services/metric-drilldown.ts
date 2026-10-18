/**
 * Metric Drill-Down (#749)
 *
 * Metrics carry only bounded labels (metric-cardinality.ts), so "which DAO?"
 * is answered by logs, not by a per-DAO series. Every instrumented failure on
 * a high-cardinality dimension increments the aggregate metric AND emits one
 * `metric_drilldown` record with:
 *
 *   metric, labels      the exact series that moved (join key to the alert)
 *   context             dao_id, proposal_id, client hash, tenant, …
 *   traceId / ctx       request correlation (from the logging middleware)
 *   span_trace_id       W3C trace of the active span (from tracing.ts)
 *
 * Investigation path: alert on the bounded series → query logs for
 * event="metric_drilldown" AND metric=<name> AND labels=<series> in the
 * alert window → group by the context field (e.g. dao_id) → open the trace
 * by traceId. Drill-down records are exempt from log sampling so the path
 * never has holes.
 */

import type { Counter, Gauge, Histogram } from "prom-client";
import { log, type LogLevel } from "./logger.js";
import { getActiveSpanContext } from "./tracing.js";

export const DRILLDOWN_EVENT = "metric_drilldown";

export type DrilldownContext = Record<
  string,
  string | number | boolean | null | undefined
>;

export function recordDrilldown(
  metric: string,
  labels: Record<string, string | number>,
  context: DrilldownContext,
  level: LogLevel = "info",
): void {
  const span = getActiveSpanContext();
  log(level, DRILLDOWN_EVENT, {
    metric,
    labels,
    ...context,
    ...(span ? { span_trace_id: span.traceId } : {}),
  });
}

/** Increment a bounded counter and record the unbounded context beside it. */
export function incWithDrilldown<L extends string>(
  counter: Counter<L>,
  labels: Partial<Record<L, string | number>>,
  context: DrilldownContext,
  options: { value?: number; level?: LogLevel } = {},
): void {
  counter.inc(labels as any, options.value ?? 1);
  recordDrilldown(
    (counter as any).name,
    labels as Record<string, string | number>,
    context,
    options.level,
  );
}

/** Observe a bounded histogram and record the unbounded context beside it. */
export function observeWithDrilldown<L extends string>(
  histogram: Histogram<L> | Gauge<L>,
  labels: Partial<Record<L, string | number>>,
  value: number,
  context: DrilldownContext,
  level: LogLevel = "info",
): void {
  if ("observe" in histogram)
    (histogram as Histogram<L>).observe(labels as any, value);
  else (histogram as Gauge<L>).set(labels as any, value);
  recordDrilldown(
    (histogram as any).name,
    labels as Record<string, string | number>,
    { ...context, value },
    level,
  );
}
