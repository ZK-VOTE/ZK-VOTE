/**
 * Regression guard for ZV-109's physical->logical CSS migration.
 *
 * Statically scans every component for the physical directional Tailwind
 * utilities (ml-/mr-/pl-/pr-/left-/right-/text-left/text-right/
 * float-left/float-right/border-l/border-r) the audit removed, so a
 * future change can't silently reintroduce layout that doesn't flip for
 * RTL locales. Background-position/object-position/transform-origin
 * keywords (bg-left, object-right, origin-left, ...) describe visual
 * geometry rather than text directionality and are intentionally not
 * flagged — Tailwind has no logical equivalent for those, and forcing
 * one would be semantically wrong for direction-independent images.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const COMPONENTS_DIR = join(__dirname, "..", "components");

const FORBIDDEN_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "ml-*", pattern: /\bml-[a-zA-Z0-9.]+/ },
  { name: "mr-*", pattern: /\bmr-[a-zA-Z0-9.]+/ },
  { name: "pl-*", pattern: /\bpl-[a-zA-Z0-9.]+/ },
  { name: "pr-*", pattern: /\bpr-[a-zA-Z0-9.]+/ },
  { name: "left-*", pattern: /\bleft-[a-zA-Z0-9.]+/ },
  { name: "right-*", pattern: /\bright-[a-zA-Z0-9.]+/ },
  { name: "text-left", pattern: /\btext-left\b/ },
  { name: "text-right", pattern: /\btext-right\b/ },
  { name: "float-left", pattern: /\bfloat-left\b/ },
  { name: "float-right", pattern: /\bfloat-right\b/ },
  { name: "border-l", pattern: /\bborder-l\b/ },
  { name: "border-r", pattern: /\bborder-r\b/ },
];

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (/\.(tsx|ts)$/.test(entry) && !entry.endsWith(".test.tsx") && !entry.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("physical->logical CSS migration (ZV-109)", () => {
  const files = collectSourceFiles(COMPONENTS_DIR);

  it("found component files to scan", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((f) => [f] as const))(
    "%s has no physical directional utilities",
    (file) => {
      const source = readFileSync(file, "utf8");
      const offenders = FORBIDDEN_PATTERNS.filter(({ pattern }) =>
        pattern.test(source),
      ).map(({ name }) => name);
      expect(offenders).toEqual([]);
    },
  );
});
