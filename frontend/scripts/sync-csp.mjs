import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(
  fs.readFileSync(path.join(root, "src/config/message-origin-policy.json"), "utf8"),
);
const nginxPath = path.join(root, "nginx.conf");
const nginx = fs.readFileSync(nginxPath, "utf8");
const frameSources = [...new Set(policy.flows.sep24)];
if (frameSources.some((origin) => {
  try {
    const parsed = new URL(origin);
    return parsed.protocol !== "https:" || parsed.origin !== origin;
  } catch {
    return true;
  }
})) {
  throw new Error("CSP frame origins must be canonical HTTPS origins");
}
const replacement = `frame-src ${frameSources.join(" ")};`;
const updated = nginx.replace(/frame-src [^;]+;/, replacement);
if (updated === nginx && !nginx.includes(replacement)) {
  throw new Error("Could not locate frame-src directive in nginx.conf");
}
if (process.argv.includes("--check")) {
  if (updated !== nginx) {
    console.error("nginx.conf frame-src is out of sync with message-origin-policy.json");
    process.exit(1);
  }
  console.log("nginx.conf frame-src matches the reviewed origin policy");
} else {
  fs.writeFileSync(nginxPath, updated);
  console.log("Updated nginx.conf frame-src from message-origin-policy.json");
}
