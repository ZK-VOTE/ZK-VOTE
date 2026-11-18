import fs from "node:fs";
import { execFileSync } from "node:child_process";

const currentPath = "reports/nightly-stress-report.json";
const previousPath = "reports/previous/nightly-stress-report.json";
if (!fs.existsSync(currentPath) || !fs.existsSync(previousPath)) {
  console.log("No previous report; consecutive-run comparison deferred.");
  process.exit(0);
}
const current = JSON.parse(fs.readFileSync(currentPath, "utf8"));
const previous = JSON.parse(fs.readFileSync(previousPath, "utf8"));
if (current.slo.passed || previous.slo.passed) {
  console.log("No consecutive SLO regression detected.");
  process.exit(0);
}
const title = "Nightly stress SLO regression";
const existing = execFileSync("gh", ["issue", "list", "--state", "open", "--search", title, "--json", "number", "--jq", ".[0].number // empty"], { encoding: "utf8" }).trim();
const body = "Two consecutive nightly runs failed the stress/load/lifecycle SLO gate.\n\n" +
  "- Current run: " + current.runId + " (" + current.commit + ")\n" +
  "- Previous run: " + previous.runId + " (" + previous.commit + ")\n\n" +
  "See the archived nightly-stress-report artifacts on both runs for the machine-readable report and drill timeline.";
if (existing) {
  execFileSync("gh", ["issue", "comment", existing, "--body", body]);
  console.log("Updated existing regression issue #" + existing);
} else {
  execFileSync("gh", ["issue", "create", "--title", title, "--body", body, "--label", "bug"]);
  console.log("Opened a regression issue after consecutive failures.");
}
