import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = JSON.parse(readFileSync(new URL("./proof-memory-fixtures.json", import.meta.url), "utf8"));
const doc = new URL("../docs/RUST_WASM_WITNESS_BENCHMARK.md", import.meta.url);
const start = "<!-- device-matrix:start -->";
const end = "<!-- device-matrix:end -->";
const cells = [
  "| Device profile | Browser RAM hint | Budget (85%) | Depth 18 | Depth 20 | Depth 25 |",
  "| --- | ---: | ---: | --- | --- | --- |",
];
for (const p of fixture.profiles) {
  const budget = Math.floor(p.deviceMemoryGb * 1024 * fixture.headroom);
  const cell = (depth) => budget >= fixture.depthPeakMib[String(depth)]
    ? (budget >= 4096 ? "main/Rust" : "worker/snarkjs")
    : "blocked";
  cells.push(`| ${p.device} | ${p.deviceMemoryGb} GiB | ${budget} MiB | ${cell(18)} | ${cell(20)} | ${cell(25)} |`);
}
const generated = `${start}\n${cells.join("\n")}\n${end}`;
const existing = readFileSync(doc, "utf8");
if (!existing.includes(start) || !existing.includes(end)) {
  throw new Error("Missing device matrix markers");
}
const actual = existing.replace(new RegExp(`${start}[\\s\\S]*?${end}`), generated);
if (process.argv.includes("--check")) {
  if (actual !== existing) throw new Error("Device matrix differs from fixtures; regenerate it.");
  console.log("Device matrix matches the source fixtures.");
} else {
  writeFileSync(doc, actual);
  console.log("Device matrix generated.");
}
