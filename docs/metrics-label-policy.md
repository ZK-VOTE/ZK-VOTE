# Metrics Label Policy (#749 / SPIKE-078)

Anyone who can create DAOs, proposals or keys, or open connections from new
IPs, can mint Prometheus series if any of those values reaches a label.
Memory use and series churn then spike exactly while the attack unfolds, so
monitoring fails during the incident it should catch. Cardinality governance
is therefore incident-response infrastructure, and every new spike's telemetry
must follow this policy.

Source of truth: `backend/src/services/metric-cardinality.ts`.

## Rules

1. **Bounded labels only.** Every label name has a declared bound in
   `LABEL_POLICY`, either an enum (closed set) or a cap (code-bounded, such as
   route templates or configured endpoint hosts). A label without an entry
   fails CI.
2. **Banned dimensions.** `BANNED_LABELS` (re-exported as
   `PROHIBITED_METRIC_LABELS` from `metrics.ts`) lists dimensions that grow
   with data or are chosen by callers: `dao_id`, `proposal_id`, `ip`,
   `tenant_id`, `target_resource`, `key_id`, `public_key`, `url`, `path`,
   `key`, `address`, `user_id`, `tx_hash`, `nullifier`, … They can never be
   labels. Put them on a drill-down log instead (see below).
3. **Normalise before labelling.** Use the helpers in `metrics.ts`:

   | Raw value | Helper | Label value |
   |---|---|---|
   | Single-flight key `root:42` | `normalizeCoalesceKey` | `operation="root"` |
   | RPC URL with credentials/query | `normalizeEndpoint` | `endpoint="host:port"` |
   | Resource id / path | `normalizeResourceType` | `resource_type="dao"` |
   | Request path before routing | `routeFamily` (middleware) | `route="/dao"` or `/other` |
   | Unmatched request path | metrics middleware | `route="unmatched"` |

4. **Aggregate, don't enumerate.** Per-key relayer gauges are now per role:
   the lowest balance and the oldest activation age in each role.

## Budgets and runtime guard

- Each metric has a child (label-combination) budget: 500 by default, with
  higher budgets for the HTTP metrics in `METRIC_CHILD_BUDGETS`. A global
  budget of 250,000 exposed samples also applies.
- prom-client is patched at import. A label value past its cap becomes
  `__overflow__`, and a combination past the metric budget collapses into one
  overflow series, counted in `zkvote_metric_cardinality_overflow_total`. An
  attack can saturate a budget but never exceed it. The
  `ZKVoteMetricCardinalityOverflow` alert fires when this happens.

## Audit and growth model

Run `npm run metrics:cardinality` in `backend/`. CI runs it in the
`Metric cardinality gate` step, which also uploads the report as an artifact.

| Scenario | DAOs | Proposals | IPs | Keys | Modeled samples |
|---|---|---|---|---|---|
| today | 50 | 500 | 1,000 | 3 | 64,946 |
| 10x | 500 | 5,000 | 10,000 | 10 | 64,946 |
| attack-mint | 1,000,000 | 10,000,000 | 5,000,000 | 10,000 | 64,946 |

The ceiling is flat because no label depends on a growth variable. If a
banned label slipped in, the report would show the scenario-sized blow-up for
that metric. In the attack-mint drill, 5,000 attacker-chosen values per label
go through every labelled metric, and the scrape stays at about 13,100
exposed samples, within the 250,000 budget.

The gate exits 1 on any of the following:

- a banned or undeclared label;
- a per-metric or global budget breach, statically or during the drill;
- an alert rule that selects or aggregates by a banned label;
- a Grafana dashboard whose template variable or panel query enumerates a
  banned label.

## Dashboards

The gate scans `backend/grafana/*.json` and `monitoring/grafana/*.json`. At the
time of writing no dashboard defines a template variable over an unbounded
label, and no panel query selects one. Any new variable must use a
`LABEL_POLICY` label.

## Drill-down: from an aggregate alert to one DAO

Per-entity detail lives in logs, which are joined to metrics by name and
labels and to traces by ID:

1. Instrumented code calls `incWithDrilldown(counter, boundedLabels, context)`
   (`metric-drilldown.ts`). This increments the bounded series and writes one
   `metric_drilldown` log record with `metric`, `labels`, the unbounded
   context (`dao_id`, `caller`, a hashed `client`, …), the request's
   `ctx`/`traceId` and the active `span_trace_id`.
2. `metric_drilldown` records are exempt from log sampling, so the path has
   no gaps.
3. The request logger opens the log-correlation context for every request,
   so nested logs carry the `traceId`.

Runbook:

1. An alert fires on a bounded series, for example
   `zkvote_root_fetch_failures_total{reason="rpc_error"}`.
2. Query the logs for `event="metric_drilldown"` with the matching `metric`
   and `labels.reason`, within the alert window.
3. Group by `dao_id` (or `client`, or `caller`) to find the affected entities.
4. Open a trace by `traceId` to find the failing call.

`tests/metrics-cardinality.test.ts` covers this end to end. It finds a single
DAO among noise, starting from the scraped series and going through the logs
to its trace.

Instrumented so far: root fetch failures, registry-pin rejections
(`unauthenticated_rejection_total` and `cross_tenant_denial_total`) and
WebSocket rate limits.

## Alerts re-expressed in bounded form

`monitoring/prometheus/zkvote-alerts.yml`, group `zkvote-cardinality`:
cardinality overflow, root fetch failures by reason, WebSocket rate-limit
spike (aggregate, no per-IP series), cross-tenant denials by
`resource_type`/`reason`, unpinned-registry rejections, and low standby
balance per role. Each alert's description gives the drill-down query.

## Adding telemetry

- Use only labels that are already in `LABEL_POLICY`, or add one with a real
  bound and a note explaining it.
- Anything per DAO, proposal, IP, key or tenant belongs in the `context` of
  `incWithDrilldown`, never in a label.
- Run `npm run metrics:cardinality` before opening a PR.
