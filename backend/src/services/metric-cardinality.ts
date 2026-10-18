/**
 * Metric Cardinality Governance (#749)
 *
 * Every spike adds telemetry, and the naive pattern labels metrics per DAO,
 * proposal, IP, key or tenant. Each of those is attacker-mintable: creating
 * DAOs, rotating keys or spraying paths/IPs mints Prometheus series, so
 * memory and churn spike exactly while an incident unfolds. This module is
 * the policy plus the enforcement:
 *
 *  1. Label policy. Every label name must be declared with a bound: an enum
 *     (closed set) or a cap (code- or operator-bounded, e.g. route
 *     templates, configured endpoints). Data-growth dimensions are banned
 *     outright (BANNED_LABELS) and go to logs/traces instead — see
 *     metric-drilldown.ts for the join.
 *  2. Per-metric budgets. Each metric has a ceiling on label combinations
 *     (children); the growth model multiplies by samples per child
 *     (histogram buckets) and checks a global sample budget.
 *  3. Runtime guard. prom-client's Counter/Gauge/Histogram/Summary methods
 *     are wrapped so a label value past its cap becomes "__overflow__" and a
 *     combination past the metric budget collapses to the all-overflow
 *     series. An attack can therefore saturate a budget but never exceed it;
 *     overflow is counted in zkvote_metric_cardinality_overflow_total.
 *  4. Audit + growth model. auditRegistry() reports, per metric, its label
 *     bounds, modeled ceiling, live child count and budget, and flags
 *     undeclared or banned labels; projections over DAO/proposal/IP/key
 *     growth are constant by construction. scripts/metrics-cardinality.ts
 *     runs it with an attack-mint drill in CI and fails on any breach.
 */

import { Counter, Gauge, Histogram, Summary, type Registry } from "prom-client";

// ============================================
// POLICY
// ============================================

export type LabelBound =
  | { kind: "enum"; values: readonly string[]; note?: string }
  | { kind: "capped"; max: number; note: string };

export const OVERFLOW_VALUE = "__overflow__";
export const OTHER_VALUE = "other";
const RESERVED_VALUES = new Set([OVERFLOW_VALUE, OTHER_VALUE]);

/**
 * Dimensions that grow with data or are chosen by callers. Never labels:
 * emit them on a metric_drilldown log record joined by trace id.
 */
export const BANNED_LABELS: Readonly<Record<string, string>> = Object.freeze({
  dao_id: "grows with DAOs",
  dao: "grows with DAOs",
  daoid: "grows with DAOs",
  proposal_id: "grows with proposals",
  proposal: "grows with proposals",
  proposalid: "grows with proposals",
  comment_id: "grows with comments",
  ip: "attacker-controlled",
  client_ip: "attacker-controlled",
  remote_addr: "attacker-controlled",
  tenant_id: "attacker-controlled",
  tenant: "attacker-controlled",
  user: "grows with users",
  user_id: "grows with users",
  member: "grows with members",
  address: "grows with accounts",
  account: "grows with accounts",
  wallet: "grows with accounts",
  public_key: "grows per key rotation",
  key_id: "grows per key rotation",
  key: "raw cache/lookup keys embed ids; use a bounded scope",
  url: "full URLs embed credentials and ids; use the origin as endpoint",
  path: "raw paths are attacker-chosen; use a route template",
  nullifier: "grows with votes (and is sensitive)",
  commitment: "grows with members (and is sensitive)",
  tx_hash: "unique per transaction",
  hash: "unique per object",
  cid: "unique per IPFS object",
  request_id: "unique per request",
  trace_id: "unique per request",
  span_id: "unique per request",
  session_id: "unique per session",
  job_id: "unique per job",
});

const capped = (max: number, note: string): LabelBound => ({
  kind: "capped",
  max,
  note,
});

/** Bounds per label name. A label not listed here fails the audit. */
export const LABEL_POLICY: Readonly<Record<string, LabelBound>> = Object.freeze(
  {
    method: capped(
      40,
      "HTTP verbs and Soroban RPC method names (code-bounded)",
    ),
    route: capped(
      150,
      "Express route templates; unmatched paths → 'unmatched'",
    ),
    status: capped(64, "HTTP status codes and status words"),
    service: capped(32, "supervised background services"),
    breaker: capped(48, "registered circuit breakers"),
    channel: capped(16, "outbox channels"),
    component: capped(16, "reconciled components"),
    mismatch_type: capped(16, "reconciliation mismatch kinds"),
    batch_type: capped(16, "batch kinds"),
    reason: capped(48, "rejection / failure reasons (code-defined)"),
    trigger: capped(16, "rotation triggers"),
    result: capped(8, "operation results"),
    level: capped(8, "severity levels"),
    operation: capped(64, "DB / service operation names"),
    type: capped(32, "event or object types (code-defined)"),
    event_type: capped(64, "indexed contract event types"),
    pattern: capped(32, "abuse patterns"),
    confidence_level: capped(8, "abuse confidence buckets"),
    priority: capped(8, "request priority classes"),
    error_type: capped(48, "error classes"),
    escalation: capped(8, "remediation escalation levels"),
    field: capped(32, "KYC fields"),
    access_level: capped(8, "KYC access levels"),
    has_excess_fields: { kind: "enum", values: ["true", "false"] },
    target_resource: capped(32, "protected resource kinds"),
    endpoint: capped(32, "configured endpoint origins or route templates"),
    role: {
      kind: "enum",
      values: ["primary", "secondary", "standby", "deprecated"],
    },
    scope: capped(
      32,
      "single-flight key prefix (e.g. 'root'), never the full key",
    ),
    dependency: capped(16, "external dependencies"),
    op_class: capped(8, "endpoint operation classes"),
    outcome: capped(16, "operation outcomes"),
    tier: capped(4, "signing tiers"),
    phase: capped(8, "lifecycle phases"),
    kind: capped(8, "operation kinds"),
    // prom-client default process metrics.
    version: capped(2, "Node.js version string (constant per process)"),
    major: capped(2, "Node.js major version"),
    minor: capped(2, "Node.js minor version"),
    patch: capped(2, "Node.js patch version"),
    space: capped(16, "V8 heap spaces"),
    // Labels of the guard's own overflow counter.
    metric: capped(1024, "metric names (bounded by the registry)"),
    label: capped(64, "label names (bounded by this policy)"),
  },
);

/** Default ceiling on label combinations (children) per metric. */
export const DEFAULT_CHILD_BUDGET = 500;

/** Per-metric overrides for metrics whose bounded labels legitimately combine wider. */
export const METRIC_CHILD_BUDGETS: Readonly<Record<string, number>> =
  Object.freeze({
    zkvote_http_requests_total: 1500,
    zkvote_http_request_duration_seconds: 1500,
    zkvote_http_response_size_bytes: 1500,
    zkvote_http_request_size_bytes: 600,
    zkvote_http_requests_in_flight: 600,
    zkvote_metric_cardinality_overflow_total: 2000,
  });

/** Ceiling on total exposed samples across the registry (children × samples per child). */
export const GLOBAL_SAMPLE_BUDGET = 250_000;

const OVERFLOW_METRIC = "zkvote_metric_cardinality_overflow_total";

export function childBudget(metricName: string): number {
  return METRIC_CHILD_BUDGETS[metricName] ?? DEFAULT_CHILD_BUDGET;
}

function labelBound(label: string): LabelBound | undefined {
  return LABEL_POLICY[label];
}

function boundSize(bound: LabelBound | undefined): number {
  if (!bound) return Infinity;
  // +1: the reserved fallback value ("other" / "__overflow__").
  return bound.kind === "enum" ? bound.values.length + 1 : bound.max + 1;
}

// ============================================
// RUNTIME GUARD
// ============================================

interface GuardState {
  values: Map<string, Set<string>>; // label → seen values
  combos: Set<string>;
}

const state = new WeakMap<object, GuardState>();
let overflowCounter: Counter<"metric" | "label"> | null = null;

function stateFor(metric: object): GuardState {
  let s = state.get(metric);
  if (!s) {
    s = { values: new Map(), combos: new Set() };
    state.set(metric, s);
  }
  return s;
}

function noteOverflow(metricName: string, label: string): void {
  if (!overflowCounter || metricName === OVERFLOW_METRIC) return;
  overflowCounter.inc({ metric: metricName, label });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Map a label set onto the metric's budget. Idempotent: an already
 * sanitized set maps to itself, so nested calls (startTimer → set) are safe.
 */
export function sanitizeLabels(
  metric: { name: string; labelNames?: readonly string[] },
  labels: Record<string, unknown>,
): Record<string, string | number> {
  if (metric.name === OVERFLOW_METRIC) return labels as Record<string, string>;
  const s = stateFor(metric);
  const out: Record<string, string | number> = {};

  for (const [name, raw] of Object.entries(labels)) {
    const value = String(raw);
    const bound = labelBound(name);
    if (RESERVED_VALUES.has(value)) {
      out[name] = value;
    } else if (bound?.kind === "enum") {
      out[name] = bound.values.includes(value) ? value : OTHER_VALUE;
    } else {
      // Capped, or undeclared (the audit fails those; at runtime cap tightly).
      const max = bound?.kind === "capped" ? bound.max : 16;
      let seen = s.values.get(name);
      if (!seen) s.values.set(name, (seen = new Set()));
      if (seen.has(value) || seen.size < max) {
        seen.add(value);
        out[name] = value;
      } else {
        out[name] = OVERFLOW_VALUE;
        noteOverflow(metric.name, name);
      }
    }
  }

  const names = metric.labelNames ?? Object.keys(out);
  const combo = names.map((n) => String(out[n] ?? "")).join("\u0001");
  if (!s.combos.has(combo)) {
    if (s.combos.size >= childBudget(metric.name)) {
      for (const n of Object.keys(out)) out[n] = OVERFLOW_VALUE;
      noteOverflow(metric.name, "__series__");
      s.combos.add(
        names.map((n) => (n in out ? OVERFLOW_VALUE : "")).join("\u0001"),
      );
    } else {
      s.combos.add(combo);
    }
  }
  return out;
}

type AnyFn = (...args: any[]) => any;

function wrapLabelsFirst(proto: any, method: string): void {
  const original: AnyFn | undefined = proto[method];
  if (typeof original !== "function" || (original as any).__cardinalityGuarded)
    return;
  const wrapped = function (this: any, ...args: any[]) {
    if (isPlainObject(args[0])) args[0] = sanitizeLabels(this, args[0]);
    return original.apply(this, args);
  };
  (wrapped as any).__cardinalityGuarded = true;
  (wrapped as any).__original = original;
  proto[method] = wrapped;
}

/** Exemplar variants take one `{ labels, value, exemplarLabels }` argument. */
function wrapExemplarMethod(proto: any, method: string): void {
  const original: AnyFn | undefined = proto[method];
  if (typeof original !== "function" || (original as any).__cardinalityGuarded)
    return;
  const wrapped = function (this: any, arg: any = {}) {
    if (isPlainObject(arg) && isPlainObject(arg.labels)) {
      arg = { ...arg, labels: sanitizeLabels(this, arg.labels) };
    }
    return original.call(this, arg);
  };
  (wrapped as any).__cardinalityGuarded = true;
  proto[method] = wrapped;
}

/** labels()/remove() take an object or positional values in labelNames order. */
function wrapLabelSelector(proto: any, method: string): void {
  const original: AnyFn | undefined = proto[method];
  if (typeof original !== "function" || (original as any).__cardinalityGuarded)
    return;
  const wrapped = function (this: any, ...args: any[]) {
    if (args.length === 1 && isPlainObject(args[0])) {
      return original.call(this, sanitizeLabels(this, args[0]));
    }
    if (args.length > 0 && Array.isArray(this.labelNames)) {
      const obj: Record<string, unknown> = {};
      this.labelNames.forEach((n: string, i: number) => {
        if (i < args.length) obj[n] = args[i];
      });
      return original.call(this, sanitizeLabels(this, obj));
    }
    return original.apply(this, args);
  };
  (wrapped as any).__cardinalityGuarded = true;
  proto[method] = wrapped;
}

let prototypesPatched = false;

/**
 * Patch prom-client prototypes once. Runs at import, before metrics.ts
 * constructs any metric. Counter and Histogram constructors assign
 * `this.inc` / `this.observe` from the (with|without)Exemplar prototype
 * methods, so those are the ones wrapped; their startTimer/labels paths go
 * through `this.observe` or the wrapped labels().
 */
export function patchPromClientPrototypes(): void {
  if (prototypesPatched) return;
  prototypesPatched = true;
  wrapLabelsFirst(Counter.prototype, "incWithoutExemplar");
  wrapExemplarMethod(Counter.prototype, "incWithExemplar");
  for (const method of ["set", "inc", "dec", "setToCurrentTime"]) {
    wrapLabelsFirst(Gauge.prototype, method);
  }
  wrapLabelsFirst(Histogram.prototype, "observeWithoutExemplar");
  wrapExemplarMethod(Histogram.prototype, "observeWithExemplar");
  wrapLabelsFirst(Histogram.prototype, "zero");
  wrapLabelsFirst(Summary.prototype, "observe");
  for (const proto of [
    Counter.prototype,
    Gauge.prototype,
    Histogram.prototype,
    Summary.prototype,
  ]) {
    wrapLabelSelector(proto, "labels");
    wrapLabelSelector(proto, "remove");
  }
}

patchPromClientPrototypes();

/**
 * Bind a registry to the guard: registers the overflow counter and repairs
 * any Counter constructed before the prototypes were patched (its `inc` is
 * an own property pointing at the unwrapped method).
 */
export function installCardinalityGuard(register: Registry): void {
  patchPromClientPrototypes();
  if (!register.getSingleMetric(OVERFLOW_METRIC)) {
    overflowCounter = new Counter({
      name: OVERFLOW_METRIC,
      help: "Label values or combinations collapsed to __overflow__ by the cardinality guard",
      labelNames: ["metric", "label"] as const,
      registers: [register],
    });
  } else {
    overflowCounter = register.getSingleMetric(OVERFLOW_METRIC) as Counter<
      "metric" | "label"
    >;
  }
  for (const metric of register.getMetricsAsArray() as any[]) {
    const own = (prop: string) =>
      Object.prototype.hasOwnProperty.call(metric, prop) &&
      !metric[prop].__cardinalityGuarded;
    if (metric instanceof Counter && own("inc")) {
      metric.inc = (metric as any).enableExemplars
        ? (Counter.prototype as any).incWithExemplar
        : (Counter.prototype as any).incWithoutExemplar;
    }
    if (metric instanceof Histogram && own("observe")) {
      metric.observe = (metric as any).enableExemplars
        ? (Histogram.prototype as any).observeWithExemplar
        : (Histogram.prototype as any).observeWithoutExemplar;
    }
  }
}

/** Forget runtime state for a metric (tests). */
export function resetGuardState(metric: object): void {
  state.delete(metric);
}

// ============================================
// AUDIT & GROWTH MODEL
// ============================================

export interface MetricAudit {
  name: string;
  type: string;
  labels: string[];
  /** Max children implied by label bounds alone. */
  labelProduct: number;
  /** Modeled ceiling: min(labelProduct, budget) + overflow series. */
  modeledChildren: number;
  samplesPerChild: number;
  modeledSamples: number;
  budget: number;
  currentChildren: number;
}

export interface AuditViolation {
  metric: string;
  rule:
    | "banned_label"
    | "undeclared_label"
    | "over_budget_live"
    | "global_budget"
    | "dashboard_unbounded_variable"
    | "alert_unbounded_label";
  detail: string;
}

export interface GrowthScenario {
  name: string;
  daos: number;
  proposals: number;
  ips: number;
  keys: number;
  tenants: number;
}

export const GROWTH_SCENARIOS: GrowthScenario[] = [
  { name: "today", daos: 50, proposals: 500, ips: 1_000, keys: 3, tenants: 5 },
  {
    name: "10x",
    daos: 500,
    proposals: 5_000,
    ips: 10_000,
    keys: 10,
    tenants: 50,
  },
  {
    name: "attack-mint",
    daos: 1_000_000,
    proposals: 10_000_000,
    ips: 5_000_000,
    keys: 10_000,
    tenants: 100_000,
  },
];

export interface CardinalityReport {
  metrics: MetricAudit[];
  violations: AuditViolation[];
  totals: {
    modeledSamples: number;
    currentChildren: number;
    globalBudget: number;
  };
  /** Modeled samples per scenario. Every label is bounded, so these are equal. */
  projections: Array<{ scenario: string; modeledSamples: number }>;
}

function samplesPerChild(metric: any): number {
  if (metric instanceof Histogram)
    return (metric as any).upperBounds.length + 1 + 2; // buckets + +Inf + sum + count
  if (metric instanceof Summary)
    return ((metric as any).percentiles?.length ?? 0) + 2;
  return 1;
}

function liveChildren(metric: any): number {
  const map = metric.hashMap;
  return map && typeof map === "object" ? Object.keys(map).length : 0;
}

export function auditRegistry(register: Registry): CardinalityReport {
  const metrics: MetricAudit[] = [];
  const violations: AuditViolation[] = [];

  for (const metric of register.getMetricsAsArray() as any[]) {
    const labels: string[] = [...(metric.labelNames ?? [])];
    for (const label of labels) {
      if (BANNED_LABELS[label.toLowerCase()]) {
        violations.push({
          metric: metric.name,
          rule: "banned_label",
          detail: `label "${label}" ${BANNED_LABELS[label.toLowerCase()]}; emit it on a metric_drilldown log instead`,
        });
      } else if (!LABEL_POLICY[label]) {
        violations.push({
          metric: metric.name,
          rule: "undeclared_label",
          detail: `label "${label}" has no bound in LABEL_POLICY`,
        });
      }
    }
    const labelProduct = labels.reduce(
      (p, l) => p * boundSize(labelBound(l)),
      1,
    );
    const budget = childBudget(metric.name);
    const modeledChildren =
      labels.length === 0 ? 1 : Math.min(labelProduct, budget) + 1;
    const spc = samplesPerChild(metric);
    const current = liveChildren(metric);
    if (current > budget + 1) {
      violations.push({
        metric: metric.name,
        rule: "over_budget_live",
        detail: `${current} live children > budget ${budget}`,
      });
    }
    metrics.push({
      name: metric.name,
      type: metric.constructor?.name ?? "unknown",
      labels,
      labelProduct,
      modeledChildren,
      samplesPerChild: spc,
      modeledSamples: modeledChildren * spc,
      budget,
      currentChildren: current,
    });
  }

  const modeledSamples = metrics.reduce((sum, m) => sum + m.modeledSamples, 0);
  if (modeledSamples > GLOBAL_SAMPLE_BUDGET) {
    violations.push({
      metric: "*",
      rule: "global_budget",
      detail: `modeled ${modeledSamples} samples > global budget ${GLOBAL_SAMPLE_BUDGET}`,
    });
  }
  return {
    metrics: metrics.sort((a, b) => b.modeledSamples - a.modeledSamples),
    violations,
    totals: {
      modeledSamples,
      currentChildren: metrics.reduce((sum, m) => sum + m.currentChildren, 0),
      globalBudget: GLOBAL_SAMPLE_BUDGET,
    },
    // No label depends on any growth variable, so the scenario only changes
    // the projection if a banned label slipped through — counted at scenario
    // size here so the report shows the blow-up.
    projections: GROWTH_SCENARIOS.map((scenario) => ({
      scenario: scenario.name,
      modeledSamples:
        modeledSamples +
        metrics.reduce((sum, m) => {
          const banned = m.labels.filter((l) => BANNED_LABELS[l.toLowerCase()]);
          return banned.length === 0
            ? sum
            : sum + scenarioGrowth(banned, scenario) * m.samplesPerChild;
        }, 0),
    })),
  };
}

function scenarioGrowth(labels: string[], s: GrowthScenario): number {
  const size = (l: string): number => {
    if (/dao/.test(l)) return s.daos;
    if (/proposal|comment/.test(l)) return s.proposals;
    if (/ip|addr/.test(l)) return s.ips;
    if (/key|public/.test(l)) return s.keys;
    if (/tenant/.test(l)) return s.tenants;
    return s.ips; // ids, hashes, urls, paths: assume attacker-scale
  };
  return labels.reduce((p, l) => p * size(l), 1);
}

const BANNED_PATTERN = new RegExp(
  `\\b(${Object.keys(BANNED_LABELS).join("|")})\\b\\s*(=~|!~|!=|=)|\\bby\\s*\\([^)]*\\b(${Object.keys(BANNED_LABELS).join("|")})\\b`,
  "i",
);

/** Alert rules may not select or aggregate by an unbounded label. */
export function auditAlertRules(
  yamlText: string,
  source = "alerts",
): AuditViolation[] {
  const violations: AuditViolation[] = [];
  const lines = yamlText.split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = line.match(/^\s*expr:\s*(.+)$/);
    if (m && BANNED_PATTERN.test(m[1])) {
      violations.push({
        metric: source,
        rule: "alert_unbounded_label",
        detail: `line ${i + 1}: ${m[1].trim()}`,
      });
    }
  });
  return violations;
}

/** Dashboard template variables may not enumerate an unbounded label. */
export function auditDashboard(
  json: unknown,
  source = "dashboard",
): AuditViolation[] {
  const violations: AuditViolation[] = [];
  const root: any = json && typeof json === "object" ? json : {};
  const vars: any[] =
    root.templating?.list ?? root.dashboard?.templating?.list ?? [];
  for (const v of vars) {
    const query =
      typeof v.query === "string" ? v.query : (v.query?.query ?? "");
    const lv = /label_values\s*\(([^)]*)\)/.exec(query);
    const label = lv ? lv[1].split(",").pop()!.trim() : "";
    if (label && BANNED_LABELS[label.toLowerCase()]) {
      violations.push({
        metric: source,
        rule: "dashboard_unbounded_variable",
        detail: `variable "${v.name}" enumerates unbounded label "${label}"`,
      });
    }
  }
  const exprs = JSON.stringify(root).match(/"expr":"((?:[^"\\]|\\.)*)"/g) ?? [];
  for (const e of exprs) {
    if (BANNED_PATTERN.test(e.replace(/\\"/g, '"'))) {
      violations.push({
        metric: source,
        rule: "dashboard_unbounded_variable",
        detail: `panel query ${e}`,
      });
    }
  }
  return violations;
}

// ============================================
// ATTACK-MINT DRILL & CI GATE
// ============================================

export interface DrillResult {
  valuesPerLabel: number;
  perMetric: Array<{
    name: string;
    children: number;
    budget: number;
    withinBudget: boolean;
  }>;
  exposedSamples: number;
}

/** Count sample lines Prometheus would scrape from this registry. */
export async function countExposedSamples(register: Registry): Promise<number> {
  const text = await register.metrics();
  return text.split("\n").filter((l) => l && !l.startsWith("#")).length;
}

/**
 * Feed every labelled metric `valuesPerLabel` attacker-style values per label
 * (fresh DAO ids, IPs, keys, paths) through its normal API, then measure.
 * Mutates the registry: run it in a throwaway process or on a test registry.
 */
export async function runAttackMintDrill(
  register: Registry,
  valuesPerLabel = 5_000,
): Promise<DrillResult> {
  const metrics = (register.getMetricsAsArray() as any[]).filter(
    (m) => (m.labelNames ?? []).length > 0 && m.name !== OVERFLOW_METRIC,
  );
  for (const metric of metrics) {
    for (let i = 0; i < valuesPerLabel; i++) {
      const labels: Record<string, string> = {};
      for (const name of metric.labelNames as string[]) {
        labels[name] = `attack-${name}-${i}-${(i * 2654435761) >>> 0}`;
      }
      if (metric instanceof Counter) metric.inc(labels);
      else if (metric instanceof Gauge) metric.set(labels, i);
      else if (metric instanceof Histogram || metric instanceof Summary)
        metric.observe(labels, i % 7);
    }
  }
  return {
    valuesPerLabel,
    perMetric: metrics.map((m) => {
      const children = liveChildren(m);
      const budget = childBudget(m.name);
      return {
        name: m.name,
        children,
        budget,
        withinBudget: children <= budget + 1,
      };
    }),
    exposedSamples: await countExposedSamples(register),
  };
}

export interface GateInput {
  register: Registry;
  alertRules?: Array<{ source: string; text: string }>;
  dashboards?: Array<{ source: string; json: unknown }>;
  drillValuesPerLabel?: number;
}

export interface GateResult {
  exitCode: 0 | 1;
  report: CardinalityReport;
  drill: DrillResult | null;
  violations: AuditViolation[];
}

/** Static audit + alert/dashboard scan + attack-mint drill; exit 1 on any breach. */
export async function runCardinalityGate(
  input: GateInput,
): Promise<GateResult> {
  const report = auditRegistry(input.register);
  const violations = [...report.violations];
  for (const rules of input.alertRules ?? [])
    violations.push(...auditAlertRules(rules.text, rules.source));
  for (const dash of input.dashboards ?? [])
    violations.push(...auditDashboard(dash.json, dash.source));

  let drill: DrillResult | null = null;
  if (input.drillValuesPerLabel !== 0) {
    drill = await runAttackMintDrill(
      input.register,
      input.drillValuesPerLabel ?? 5_000,
    );
    for (const m of drill.perMetric) {
      if (!m.withinBudget) {
        violations.push({
          metric: m.name,
          rule: "over_budget_live",
          detail: `attack-mint drill: ${m.children} children > budget ${m.budget}`,
        });
      }
    }
    if (drill.exposedSamples > GLOBAL_SAMPLE_BUDGET) {
      violations.push({
        metric: "*",
        rule: "global_budget",
        detail: `attack-mint drill: ${drill.exposedSamples} exposed samples > ${GLOBAL_SAMPLE_BUDGET}`,
      });
    }
  }
  return { exitCode: violations.length > 0 ? 1 : 0, report, drill, violations };
}

/** Markdown summary for CI logs / job summary. */
export function formatGateReport(result: GateResult): string {
  const { report, drill, violations } = result;
  const lines = [
    `# Metric cardinality gate: ${result.exitCode === 0 ? "PASS" : "FAIL"}`,
    "",
    `Modeled samples: ${report.totals.modeledSamples} / budget ${report.totals.globalBudget}` +
      (drill
        ? ` · attack-mint drill (${drill.valuesPerLabel} values/label): ${drill.exposedSamples} exposed samples`
        : ""),
    "",
    "## Growth model",
    "| scenario | modeled samples |",
    "|---|---|",
    ...report.projections.map((p) => `| ${p.scenario} | ${p.modeledSamples} |`),
    "",
  ];
  if (violations.length) {
    lines.push("## Violations", "| metric | rule | detail |", "|---|---|---|");
    for (const v of violations)
      lines.push(`| ${v.metric} | ${v.rule} | ${v.detail} |`);
    lines.push("");
  }
  lines.push(
    "## Per-metric budgets (top 25 by modeled samples)",
    "| metric | type | labels | modeled children | samples/child | budget | live |",
    "|---|---|---|---|---|---|---|",
    ...report.metrics
      .slice(0, 25)
      .map(
        (m) =>
          `| ${m.name} | ${m.type} | ${m.labels.join(", ") || "—"} | ${m.modeledChildren} | ${m.samplesPerChild} | ${m.budget} | ${m.currentChildren} |`,
      ),
  );
  return lines.join("\n");
}
