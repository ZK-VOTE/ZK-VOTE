#!/usr/bin/env tsx
/**
 * Metric cardinality CI gate (#749).
 *
 *   npm run metrics:cardinality [-- --values 5000] [--report path.md]
 *
 * Loads every module that registers metrics, then:
 *  1. audits labels against LABEL_POLICY / BANNED_LABELS and per-metric
 *     budgets, and prints the growth model;
 *  2. scans Prometheus alert rules and Grafana dashboards for selectors,
 *     aggregations or template variables over unbounded labels;
 *  3. runs the attack-mint drill: thousands of attacker-chosen values per
 *     label through every metric, then checks live children and exposed
 *     samples against the budgets.
 * Exits 1 on any violation. Writes the markdown report to --report and to
 * $GITHUB_STEP_SUMMARY when present.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register as globalRegistry } from "prom-client";

process.env.RELAYER_TEST_MODE ??= "true";

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(here, "..");
const repo = path.resolve(backend, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function listFiles(dir: string, ext: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => path.join(dir, f));
}

async function main(): Promise<void> {
  const { register } = await import("../src/services/metrics.js");
  // Modules that register their own metrics at import time.
  await import("../src/services/remediation.js");
  await import("../src/services/submit-queue.js");
  await import("../src/services/rpc-concurrency.js");
  const { runCardinalityGate, formatGateReport } = await import("../src/services/metric-cardinality.js");

  const alertRules = [
    ...listFiles(path.join(repo, "monitoring/prometheus"), ".yml"),
  ].map((file) => ({ source: path.relative(repo, file), text: fs.readFileSync(file, "utf8") }));
  const dashboards = [
    ...listFiles(path.join(backend, "grafana"), ".json"),
    ...listFiles(path.join(repo, "monitoring/grafana"), ".json"),
  ].map((file) => ({
    source: path.relative(repo, file),
    json: JSON.parse(fs.readFileSync(file, "utf8")),
  }));

  const values = Number(arg("values") ?? 5_000);
  const app = await runCardinalityGate({ register, alertRules, dashboards, drillValuesPerLabel: values });
  // prom-client's default registry (submit-queue, rpc-concurrency) is
  // guarded by the same prototypes; audit it too so nothing escapes.
  const global = await runCardinalityGate({ register: globalRegistry, drillValuesPerLabel: values });

  const report = [
    formatGateReport(app),
    "",
    "---",
    "",
    formatGateReport(global).replace("# Metric cardinality gate", "# Default registry"),
  ].join("\n");
  console.log(report);

  const out = arg("report");
  if (out) fs.writeFileSync(out, report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);

  process.exit(app.exitCode || global.exitCode ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
