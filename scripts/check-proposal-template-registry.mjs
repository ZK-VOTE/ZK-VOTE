import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const canonical = read("../shared/proposal-template-registry.json");
const snapshots = [
  "../frontend/src/lib/proposal-template-registry.json",
  "../backend/src/validation/proposal-template-registry.json",
];
const data = JSON.parse(canonical);
if (data.schemaVersion !== 1 || !Array.isArray(data.templates)) {
  throw new Error("Unsupported proposal-template registry schema");
}
const ids = new Set();
for (const item of data.templates) {
  if (ids.has(item.id) || !/^[a-z0-9-]+$/.test(item.id)) {
    throw new Error(`Duplicate or unsafe template ID: ${item.id}`);
  }
  ids.add(item.id);
  if (!Number.isInteger(item.version) || item.version <= 0 ||
      !["fixed", "trailing"].includes(item.voteMode) ||
      !Number.isInteger(item.deadlineSeconds) || item.deadlineSeconds <= 0) {
    throw new Error(`Invalid template parameters: ${item.id}`);
  }
  for (const lang of ["en", "ar"]) {
    for (const field of ["name", "description", "titlePlaceholder", "bodyScaffold"]) {
      if (typeof item[field]?.[lang] !== "string" || !item[field][lang]) {
        throw new Error(`Missing translation ${item.id}.${field}.${lang}`);
      }
    }
    if (Buffer.byteLength(item.titlePlaceholder[lang].normalize("NFC"), "utf8") > 100 ||
        item.bodyScaffold[lang].length > 100000 ||
        /[\u200B-\u200D\u202A-\u202E\u2066-\u2069\uFEFF]/.test(item.titlePlaceholder[lang])) {
      throw new Error(`Template violates server-side title/body/bidi limits: ${item.id}`);
    }
  }
}
for (const path of snapshots) {
  if (process.argv.includes("--write")) {
    writeFileSync(new URL(path, import.meta.url), canonical);
  } else if (read(path) !== canonical) {
    throw new Error(`Proposal template registry drift detected: ${path}`);
  }
}
console.log(`Validated ${data.templates.length} templates and matched frontend/backend snapshots.`);
