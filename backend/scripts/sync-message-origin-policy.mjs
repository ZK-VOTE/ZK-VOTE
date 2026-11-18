import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(root, "../frontend/src/config/message-origin-policy.json");
const target = path.join(root, "src/generated/message-origin-policy.json");
const expected = fs.readFileSync(source, "utf8");
const check = process.argv.includes("--check");
if (check) {
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== expected) {
    console.error("Backend origin policy is stale. Run npm run origins:sync and commit the generated file.");
    process.exit(1);
  }
  console.log("Backend and frontend origin policies match");
} else {
  fs.writeFileSync(target, expected);
  console.log("Synchronized backend origin policy");
}
