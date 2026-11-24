import fs from "node:fs";
import path from "node:path";

const tapPath = process.argv[2];
const jsonPath = process.argv[3];
if (!tapPath || !jsonPath) throw new Error("usage: build-relayer-drill-report.mjs <tap-file> <json-file>");
const tap = fs.existsSync(tapPath) ? fs.readFileSync(tapPath, "utf8") : "";
const passed = (tap.match(/^ok \d+ -/gm) || []).length;
const failed = (tap.match(/^not ok \d+ -/gm) || []).length;
const total = passed + failed;
const report = {
  schemaVersion: 1,
  drill: "relayer-key-lifecycle",
  generatedAt: new Date().toISOString(),
  result: total > 0 && failed === 0 ? "passed" : "failed",
  tests: { total, passed, failed },
  scenarios: [
    "funded standby selection and ranking",
    "hot swap and sequence fencing under synthetic concurrent load",
    "compromise revocation and fail-closed behavior",
    "safe-account-only compromise sweep and two-person approval",
    "revocation persistence and recovery"
  ],
  note: "Synthetic fake-ledger drill; a timed live-testnet exercise remains an operator responsibility."
};
fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
const md = [
  "# Relayer key lifecycle drill",
  "",
  "- Result: " + report.result,
  "- Generated: " + report.generatedAt,
  "- Tests: " + passed + "/" + total + " passed; " + failed + " failed",
  "",
  "## Scenarios",
  ...report.scenarios.map((item) => "- " + item),
  "",
  report.note
].join("\n");
fs.writeFileSync(jsonPath.replace(/\.json$/, ".md"), md + "\n");
if (report.result !== "passed") process.exitCode = 1;
