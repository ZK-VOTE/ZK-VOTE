import fs from "node:fs";
import path from "node:path";

const out = "reports";
fs.mkdirSync(out, { recursive: true });
const jobs = {
  rustStress: process.env.RUST_STRESS_RESULT || "unknown",
  backendLoad: process.env.BACKEND_LOAD_RESULT || "unknown",
  relayerLifecycle: process.env.RELAYER_DRILL_RESULT || "unknown"
};
const drillFile = path.join(out, "artifacts/relayer-key-lifecycle.json");
let drill = null;
if (fs.existsSync(drillFile)) {
  try { drill = JSON.parse(fs.readFileSync(drillFile, "utf8")); } catch {}
}
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
  relayerLifecycle: drill,
  timeline: [
    { event: "rust-stress", result: jobs.rustStress },
    { event: "backend-load", result: jobs.backendLoad },
    { event: "relayer-lifecycle", result: jobs.relayerLifecycle },
    { event: "report-generated", at: new Date().toISOString() }
  ]
};
fs.writeFileSync(path.join(out, "nightly-stress-report.json"), JSON.stringify(report, null, 2) + "\n");
const md = [
  "# Nightly stress report",
  "",
  "- Result: " + report.result,
  "- Commit: " + (report.commit || "unknown"),
  "- Run: " + (report.runId || "local") + " (attempt " + report.runAttempt + ")",
  "- Generated: " + report.generatedAt,
  "",
  "## Job results",
  ...Object.entries(jobs).map(([name, value]) => "- " + name + ": " + value),
  "",
  "## Relayer drill",
  drill ? "- " + drill.result + ": " + drill.tests.passed + "/" + drill.tests.total + " passed" : "No drill report was downloaded.",
  "",
  "Machine-readable schema version: 1."
].join("\n");
fs.writeFileSync(path.join(out, "nightly-stress-report.md"), md + "\n");
