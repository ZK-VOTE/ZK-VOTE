// Metric cardinality governance (#749): label policy, budgets, the CI gate
// (including that it fails on a breach), attack-mint drills through the real
// instrumentation, and the metric → log → trace drill-down end to end.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import request from "supertest";
import type { Request, Response } from "express";
import { Counter, Gauge, Histogram, Registry } from "prom-client";

process.env.RELAYER_TEST_MODE = "true";
process.env.RELAYER_SECRET_KEY = "SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF";
process.env.RELAYER_AUTH_TOKEN = "cardinality-test-token";
process.env.VOTING_CONTRACT_ID = "C".padEnd(56, "A");
process.env.TREE_CONTRACT_ID = "C".padEnd(56, "B");
process.env.COMMENTS_CONTRACT_ID = "C".padEnd(56, "D");
process.env.SOROBAN_RPC_URL = "http://localhost";
process.env.NETWORK_PASSPHRASE = "Test";
process.env.CORS_ORIGIN = "http://localhost";
process.env.IPFS_ENABLED = "false";

const {
  OVERFLOW_VALUE,
  OTHER_VALUE,
  auditAlertRules,
  auditDashboard,
  auditRegistry,
  childBudget,
  runCardinalityGate,
} = await import("../src/services/metric-cardinality.js");
const {
  register,
  normalizeCoalesceKey,
  normalizeEndpoint,
  normalizeResourceType,
  auditRegistryCardinality,
  PROHIBITED_METRIC_LABELS,
} = await import("../src/services/metrics.js");
const { metricsMiddleware, routeFamily } = await import("../src/middleware/metrics.js");
const { SingleFlight } = await import("../src/utils/singleflight.js");
const { relayerKeyManager } = await import("../src/services/relayerKeyManager.js");
const { verifyRegistryCaller } = await import("../src/services/registry-pin.js");
const { DRILLDOWN_EVENT } = await import("../src/services/metric-drilldown.js");

const repo = path.resolve(import.meta.dirname, "..", "..");

type Labels = Record<string, string>;

/** Live children of a prom-client metric (its private hashMap), as label sets. */
function childLabels(metric: unknown): Labels[] {
  const map = (metric as { hashMap?: Record<string, { labels?: Labels }> }).hashMap ?? {};
  return Object.values(map).map((v) => v.labels ?? {});
}

function children(name: string): Labels[] {
  const metric = register.getSingleMetric(name);
  assert.ok(metric, `${name} registered`);
  return childLabels(metric);
}

let seq = 0;
const uniq = (base: string) => `zkvote_test_${base}_${++seq}`;

// ── Policy & audit ────────────────────────────────────────────────────────

test("normalizers map attacker-chosen inputs onto bounded values", () => {
  assert.equal(normalizeEndpoint("https://user:pw@rpc.example.com:8443/v1?apiKey=s3cret"), "rpc.example.com:8443");
  assert.equal(normalizeEndpoint("https://rpc.example.com/a"), normalizeEndpoint("https://rpc.example.com/b?k=1"));
  const resources = new Set<string>();
  for (let i = 0; i < 1000; i++) resources.add(normalizeResourceType(`dao/${i}`));
  for (let i = 0; i < 1000; i++) resources.add(normalizeResourceType(crypto.randomBytes(8).toString("hex")));
  assert.deepEqual([...resources].sort(), ["dao", "unknown"]);
  assert.equal(normalizeResourceType("registry"), "registry");
  const ops = new Set<string>();
  for (let i = 0; i < 1000; i++) ops.add(normalizeCoalesceKey(`proposal:${i}:${i}`));
  for (let i = 0; i < 1000; i++) ops.add(normalizeCoalesceKey(`x${i}:1`));
  assert.deepEqual([...ops].sort(), ["other", "proposal"]);
});

test("auditRegistryCardinality reports declared (not just observed) prohibited labels", async () => {
  const reg = new Registry();
  // Never incremented: an observed-values-only audit would miss it.
  new Counter({ name: uniq("idle_dao"), help: "x", labelNames: ["dao_id"], registers: [reg] });
  const result = await auditRegistryCardinality(reg);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((v) => v.reason.startsWith("banned_label") && v.labels?.includes("dao_id")));
  assert.ok(PROHIBITED_METRIC_LABELS.has("tenant_id") && PROHIBITED_METRIC_LABELS.has("ip"));
  assert.equal((await auditRegistryCardinality(register)).valid, true);
});

test("every metric in the app registry uses declared, bounded labels within budget", () => {
  const report = auditRegistry(register);
  assert.deepEqual(report.violations, [], JSON.stringify(report.violations, null, 2));
  assert.ok(report.totals.modeledSamples <= report.totals.globalBudget);
});

test("growth model: projections are flat from today to an attack-mint scenario", () => {
  const { projections } = auditRegistry(register);
  const values = new Set(projections.map((p) => p.modeledSamples));
  assert.equal(values.size, 1, JSON.stringify(projections));
});

test("growth model: a banned label shows its blow-up at attack scale", () => {
  const reg = new Registry();
  new Counter({ name: uniq("per_dao"), help: "x", labelNames: ["dao_id"], registers: [reg] });
  const { projections } = auditRegistry(reg);
  const attack = projections.find((p) => p.scenario === "attack-mint")!;
  const today = projections.find((p) => p.scenario === "today")!;
  assert.ok(attack.modeledSamples >= 1_000_000, JSON.stringify(projections));
  assert.ok(attack.modeledSamples > today.modeledSamples);
});

// ── CI gate fails on breach ───────────────────────────────────────────────

test("gate fails on a banned per-DAO label", async () => {
  const reg = new Registry();
  new Counter({ name: uniq("votes_by_dao"), help: "x", labelNames: ["dao_id", "status"], registers: [reg] });
  const result = await runCardinalityGate({ register: reg, drillValuesPerLabel: 0 });
  assert.equal(result.exitCode, 1);
  assert.ok(result.violations.some((v) => v.rule === "banned_label" && /dao_id/.test(v.detail)));
});

test("gate fails on an undeclared label", async () => {
  const reg = new Registry();
  new Gauge({ name: uniq("mystery"), help: "x", labelNames: ["flavour"], registers: [reg] });
  const result = await runCardinalityGate({ register: reg, drillValuesPerLabel: 0 });
  assert.equal(result.exitCode, 1);
  assert.ok(result.violations.some((v) => v.rule === "undeclared_label"));
});

test("gate fails when the modeled samples exceed the global budget", async () => {
  const reg = new Registry();
  // (49+1 + 150+1 children) × ~2,000 samples each ≈ 400k > 250k budget.
  const buckets = Array.from({ length: 2_000 }, (_, i) => i + 1);
  new Histogram({ name: uniq("wide"), help: "x", labelNames: ["reason"], buckets, registers: [reg] });
  new Histogram({ name: uniq("wide2"), help: "x", labelNames: ["route"], buckets, registers: [reg] });
  const result = await runCardinalityGate({ register: reg, drillValuesPerLabel: 0 });
  assert.equal(result.exitCode, 1);
  assert.ok(result.violations.some((v) => v.rule === "global_budget"));
});

test("gate fails on alert rules and dashboards that select unbounded labels", async () => {
  const result = await runCardinalityGate({
    register: new Registry(),
    drillValuesPerLabel: 0,
    alertRules: [{ source: "bad.yml", text: "      - alert: X\n        expr: sum by (dao_id) (rate(zkvote_x[5m])) > 1\n" }],
    dashboards: [
      {
        source: "bad.json",
        json: { templating: { list: [{ name: "dao", query: "label_values(zkvote_votes_total, dao_id)" }] } },
      },
    ],
  });
  assert.equal(result.exitCode, 1);
  assert.ok(result.violations.some((v) => v.rule === "alert_unbounded_label"));
  assert.ok(result.violations.some((v) => v.rule === "dashboard_unbounded_variable"));
});

test("repo alert rules and dashboards are bounded", () => {
  const alerts = fs.readFileSync(path.join(repo, "monitoring/prometheus/zkvote-alerts.yml"), "utf8");
  assert.deepEqual(auditAlertRules(alerts, "zkvote-alerts.yml"), []);
  for (const file of [
    path.join(repo, "backend/grafana/zkvote-backend-dashboard.json"),
    path.join(repo, "monitoring/grafana/zkvote-relayer.json"),
  ]) {
    assert.deepEqual(auditDashboard(JSON.parse(fs.readFileSync(file, "utf8")), file), []);
  }
  assert.ok(auditAlertRules('        expr: rate(zkvote_ws{ip="1.2.3.4"}[5m]) > 1', "x").length === 1);
});

test("gate passes on a well-formed registry under the attack-mint drill", async () => {
  const reg = new Registry();
  new Counter({ name: uniq("ok"), help: "x", labelNames: ["reason", "status"], registers: [reg] });
  new Histogram({ name: uniq("ok_h"), help: "x", labelNames: ["route"], registers: [reg] });
  const result = await runCardinalityGate({ register: reg, drillValuesPerLabel: 2_000 });
  assert.equal(result.exitCode, 0, JSON.stringify(result.violations));
  assert.ok(result.drill!.perMetric.every((m) => m.withinBudget));
});

// ── Runtime guard ─────────────────────────────────────────────────────────

test("guard: enum labels fall back to 'other'; capped labels overflow past their bound", () => {
  const reg = new Registry();
  const enumMetric = new Gauge({ name: uniq("enum"), help: "x", labelNames: ["role"], registers: [reg] });
  enumMetric.set({ role: "primary" }, 1);
  enumMetric.set({ role: "attacker-role" }, 1);
  const roles = childLabels(enumMetric).map((l) => l.role).sort();
  assert.deepEqual(roles, [OTHER_VALUE, "primary"].sort());

  const capped = new Counter({ name: uniq("capped"), help: "x", labelNames: ["tier"], registers: [reg] });
  for (let i = 0; i < 50; i++) capped.inc({ tier: `t${i}` });
  const tiers = childLabels(capped).map((l) => l.tier);
  assert.equal(tiers.length, 5, "tier is capped at 4 + overflow");
  assert.ok(tiers.includes(OVERFLOW_VALUE));
});

test("guard: label combinations stop at the per-metric budget", () => {
  const reg = new Registry();
  const name = uniq("combo");
  const metric = new Counter({ name, help: "x", labelNames: ["reason", "status"], registers: [reg] });
  for (let r = 0; r < 48; r++) for (let s = 0; s < 64; s++) metric.inc({ reason: `r${r}`, status: `s${s}` });
  const count = childLabels(metric).length;
  assert.equal(count, childBudget(name) + 1);
});

test("guard covers labels(), startTimer() and exemplar-free histogram paths", () => {
  const reg = new Registry();
  const h = new Histogram({ name: uniq("paths"), help: "x", labelNames: ["tier"], registers: [reg] });
  for (let i = 0; i < 30; i++) {
    h.labels(`a${i}`).observe(1);
    h.startTimer({ tier: `b${i}` })();
    h.labels({ tier: `c${i}` }).observe(2);
  }
  assert.ok(childLabels(h).length <= 5);
});

test("guard is idempotent on already-sanitised labels", () => {
  const reg = new Registry();
  const g = new Gauge({ name: uniq("idem"), help: "x", labelNames: ["tier"], registers: [reg] });
  for (let i = 0; i < 10; i++) g.set({ tier: `x${i}` }, 1);
  g.inc({ tier: OVERFLOW_VALUE });
  g.dec({ tier: OVERFLOW_VALUE });
  assert.equal(childLabels(g).length, 5);
});

// ── Attack-mint drills through real instrumentation ───────────────────────

function fakeExchange(urlPath: string, routePath?: string) {
  const handlers: Record<string, Array<() => void>> = {};
  const req = {
    method: "GET",
    path: urlPath,
    headers: {},
    route: routePath ? { path: routePath } : undefined,
  } as unknown as Request;
  const res = {
    statusCode: routePath ? 200 : 404,
    on: (ev: string, cb: () => void) => ((handlers[ev] ??= []).push(cb), res),
    getHeader: () => undefined,
    end: () => {
      (handlers.close ?? []).forEach((cb) => cb());
      return res;
    },
  } as unknown as Response;
  return { req, res };
}

test("attack-mint drill: 5,000 scanned paths and per-DAO URLs do not mint HTTP series", () => {
  for (let i = 0; i < 2_500; i++) {
    const scan = fakeExchange(`/wp-admin-${crypto.randomBytes(4).toString("hex")}/x${i}`);
    metricsMiddleware(scan.req, scan.res, () => {});
    scan.res.end();
    const dao = fakeExchange(`/dao/${i}/proposals`, "/dao/:daoId/proposals");
    metricsMiddleware(dao.req, dao.res, () => {});
    dao.res.end();
  }
  const routes = new Set(children("zkvote_http_requests_total").map((l) => l.route));
  assert.ok(routes.has("unmatched"));
  assert.ok(![...routes].some((r) => /wp-admin|\/dao\/\d/.test(r)), [...routes].join(","));
  const inflight = new Set(children("zkvote_http_requests_in_flight").map((l) => l.route));
  assert.ok(inflight.has("/other"));
  assert.ok(![...inflight].some((r) => /wp-admin/.test(r)));
  assert.equal(routeFamily("/dao/42/proposals"), "/dao");
});

test("attack-mint drill: one single-flight key per DAO yields one operation series", async () => {
  const sf = new SingleFlight();
  for (let i = 0; i < 3_000; i++) await sf.do(`root:${i}`, async () => i);
  const scopes = new Set(children("zkvote_coalescing_misses_total").map((l) => l.operation));
  assert.ok(scopes.has("root"));
  assert.ok(scopes.size <= 3, [...scopes].join(","));
  assert.equal(normalizeCoalesceKey("root:42"), "root");
  assert.equal(normalizeCoalesceKey("daos"), "daos");
  assert.equal(normalizeCoalesceKey("attacker-prefix:1"), "other");
});

test("attack-mint drill: generating 300 relayer keys keeps key metrics per role", async () => {
  relayerKeyManager.initialize({ testMode: true });
  for (let i = 0; i < 300; i++) {
    const key = relayerKeyManager.generateKey("standby");
    await relayerKeyManager.checkBalance(key.id);
  }
  for (const name of ["zkvote_relayer_key_balance_xlm", "zkvote_relayer_key_age_seconds"]) {
    const labels = children(name);
    assert.ok(labels.length <= 5, `${name}: ${labels.length} series`);
    assert.ok(labels.every((l) => !("key_id" in l)));
  }
});

test("attack-mint drill: 3,000 DAOs probing an unpinned registry share one series", () => {
  for (let i = 0; i < 3_000; i++) {
    assert.throws(() => verifyRegistryCaller(100_000 + i, "C".padEnd(56, "Z")));
  }
  assert.equal(children("zkvote_unauthenticated_rejection_total").length, 1);
});

// ── Drill-down end to end ─────────────────────────────────────────────────
//
// Real request logger (trace context), real metrics middleware, real
// instrumented service (registry-pin) and the scraped exposition. Only the
// route glue is test-local, because the full app entry point does not load
// on main today (unrelated broken imports).

test("drill-down: bounded alert series → metric_drilldown logs → single DAO → trace", async () => {
  const express = (await import("express")).default;
  const { requestLogger } = await import("../src/middleware/logging.js");

  const app = express();
  app.use(requestLogger);
  app.use(metricsMiddleware);
  app.get("/registry/:daoId/verify", (req, res) => {
    try {
      verifyRegistryCaller(Number(req.params.daoId), "C".padEnd(56, "Z"));
      res.json({ ok: true });
    } catch (err) {
      res.status(403).json({ error: (err as Error).message });
    }
  });
  app.get("/metrics", async (_req, res) => {
    res.type(register.contentType).send(await register.metrics());
  });

  const SERIES = 'zkvote_unauthenticated_rejection_total{endpoint="registry",reason="registry_not_pinned"}';
  const valueOf = (text: string) =>
    Number(text.split("\n").find((l) => l.startsWith(SERIES))?.split(" ").pop() ?? 0);
  const beforeValue = valueOf((await request(app).get("/metrics")).text);

  // 20 failures for DAO 42 hidden among 10 other DAOs.
  const sent: Array<{ dao: number; traceId: string }> = [];
  for (let i = 0; i < 30; i++) {
    sent.push({ dao: i < 20 ? 42 : 7_000 + i, traceId: crypto.randomBytes(16).toString("hex") });
  }

  const captured: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  try {
    for (const { dao, traceId } of sent) {
      const res = await request(app)
        .get(`/registry/${dao}/verify`)
        .set("traceparent", `00-${traceId}-${crypto.randomBytes(8).toString("hex")}-01`);
      assert.equal(res.status, 403);
    }
  } finally {
    console.log = originalLog;
  }

  // 1. The aggregate series moved, with bounded labels only.
  const scrape = await request(app).get("/metrics");
  assert.equal(valueOf(scrape.text) - beforeValue, 30);
  assert.ok(!/\b(dao|dao_id|tenant_id|ip|key_id|url)="/.test(scrape.text), "no unbounded label in the exposition");
  // The request series carries the route template, not /registry/42/verify.
  assert.ok(scrape.text.includes('route="/registry/:daoId/verify"'));
  assert.ok(!scrape.text.includes("/registry/42/"));

  // 2. Alert fidelity: the re-expressed rule (sum by endpoint, reason over
  //    10m > 10) fires on this series alone.
  assert.ok(valueOf(scrape.text) - beforeValue > 10);

  // 3. Drill-down: same metric + labels in the logs → group by DAO.
  const ours = new Set(sent.map((s) => s.traceId));
  const records = captured
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(
      (r) =>
        r?.event === DRILLDOWN_EVENT &&
        r.metric === "zkvote_unauthenticated_rejection_total" &&
        r.labels?.reason === "registry_not_pinned" &&
        ours.has(r.traceId),
    );
  assert.equal(records.length, sent.length);
  const byDao = new Map<string, number>();
  for (const r of records) byDao.set(String(r.dao_id), (byDao.get(String(r.dao_id)) ?? 0) + 1);
  const [topDao, topCount] = [...byDao.entries()].sort((a, b) => b[1] - a[1])[0];
  assert.equal(topDao, "42");
  assert.equal(topCount, 20);

  // 4. Every record joins to the trace of the request that produced it,
  //    through both the log context and the active span.
  const traceToDao = new Map(sent.map((s) => [s.traceId, String(s.dao)]));
  for (const r of records) {
    assert.equal(traceToDao.get(r.traceId), String(r.dao_id));
    assert.equal(r.span_trace_id, r.traceId);
  }
});

test("drill-down records are never dropped by log sampling", async () => {
  const { setLogSampleRate, getLogSampleRate } = await import("../src/services/logger.js");
  const { recordDrilldown } = await import("../src/services/metric-drilldown.js");
  const previous = getLogSampleRate();
  const captured: string[] = [];
  const originalLog = console.log;
  setLogSampleRate(0);
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  try {
    recordDrilldown("zkvote_x_total", { reason: "r" }, { dao_id: 9 });
  } finally {
    console.log = originalLog;
    setLogSampleRate(previous);
  }
  assert.equal(captured.filter((l) => l.includes(DRILLDOWN_EVENT)).length, 1);
});
