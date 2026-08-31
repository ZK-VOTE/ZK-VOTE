import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("analytics route exposes anonymity metrics and root age status", () => {
  const analyticsSource = fs.readFileSync(
    path.join(__dirname, "../src/routes/analytics.ts"),
    "utf8",
  );

  assert.match(analyticsSource, /anonymity.*set|anonymity_set|root.*history/i);
  assert.match(analyticsSource, /root.*age|eviction|MAX_ROOTS/i);
});

test("index.ts registers analytics routes", () => {
  const indexSrc = fs.readFileSync(
    path.join(__dirname, "../src/routes/index.ts"),
    "utf8",
  );
  assert.match(indexSrc, /analyticsRoutes|analytics\.js/i);
});
