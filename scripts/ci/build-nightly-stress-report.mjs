import fs from "node:fs";
import path from "node:path";

const out = "reports";
const artifactRoot = path.join(out, "artifacts");
fs.mkdirSync(out, { recursive: true });
const jobs = {
  rustStress: process.env.RUST_STRESS_RESULT || "unknown",
  backendLoad: process.env.BACKEND_LOAD_RESULT || "unknown",
  relayerLifecycle: process.env.RELAYER_DRILL_RESULT || "unknown"
};
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
const files = walk(artifactRoot);
const drillFile = files.find((file) => file.endsWith("relayer-key-lifecycle.json"));
const benchmarkFile = files.find((file) => path.basename(file) === "benchmark-results.json");
const stressLogs = files.filter((file) => file.endsWith(".log"));
let drill = null, benchmark = null;
if (drillFile) { try { drill = JSON.parse(fs.readFileSync(drillFile, "utf8")); } catch {} }
if (benchmarkFile) { try { benchmark = JSON.parse(fs.readFileSync(benchmarkFile, "utf8")); } catch {} }
const passed = Object.values(jobs).every((value) => value === "success") &&
  (!drill || drill.result === "passed");
const report = {
  schemaVersion: 1,
  workflow: "nightly-stress",
  runId: process.env.GITHUB_RUN_ID || null,
  runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT || 1),
  commit: process.env.GITHUB_SHA || null,
  generatedAt: new Date().toISOString(),
  result: passed ? "passed" : "failed",
  slo: { passed, rule: "all stress, backend-load, and relayer-lifecycle jobs succeed" },
  jobs,
  metrics: {
    rustStressLogFiles: stressLogs.length,
    relayerLifecycleTests: drill ? drill.tests : null,
    backendBenchmark: benchmark
  },
  relayerLifecycle: drill,
  runbooks: [
    { path: "docs/ops/RELAYER_KEY_ROTATION.md", operatorSignoffRequiredForLiveDrill: true },
    { path: "docs/epics/EPIC-003-ELECTION-DAY-DRILL.md", operatorSignoffRequiredForGameDay: true }
  ],
  timeline: [
    { event: "rust-stress", result: jobs.rustStress },
    { event: "backend-load", result: jobs.backendLoad },
    { event: "relayer-lifecycle", result: jobs.relayerLifecycle },
    { event: "report-generated", at: new Date().toISOString() }
  ]
};
fs.writeFileSync(path.join(out, "nightly-stress-report.json"), JSON.stringify(report, null, 2) + "\n");
const md = [
  "# Nightly stress report", "",
  "- Result: " + report.result,
  "- Commit: " + (report.commit || "unknown"),
  "- Run: " + (report.runId || "local") + " (attempt " + report.runAttempt + ")",
  "- Generated: " + report.generatedAt, "",
  "## Job results",
  ...Object.entries(jobs).map(([name, value]) => "- " + name + ": " + value), "",
  "## Metrics",
  "- Rust stress log files: " + stressLogs.length,
  "- Relayer tests: " + (drill ? drill.tests.passed + "/" + drill.tests.total + " passed" : "not available"),
  "- Backend benchmark: " + (benchmark ? "attached as structured JSON in this report" : "not available"), "",
  "## Runbooks",
  "- docs/ops/RELAYER_KEY_ROTATION.md (live drill requires operator sign-off)",
  "- docs/epics/EPIC-003-ELECTION-DAY-DRILL.md (game day requires operator sign-off)", "",
  "Stable machine-readable schema version: 1."
].join("\n");
fs.writeFileSync(path.join(out, "nightly-stress-report.md"), md + "\n");
