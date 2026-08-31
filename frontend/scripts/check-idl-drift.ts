/**
 * IDL Drift Guard
 *
 * Checks that all exported symbols from the generated stellar-sdk contract
 * bindings are re-exported in `src/generated/contract-types.ts`.
 *
 * Run:  npm run check:idl-drift
 * Exit: 0 = in sync, 1 = drift detected
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Config: contract binding files to inspect
// ---------------------------------------------------------------------------

interface ContractConfig {
  /** Human-readable name used in diagnostics */
  name: string;
  /** Path to the generated binding source file (relative to ROOT) */
  bindingPath: string;
  /**
   * Partial path fragment used to identify the corresponding import statements
   * in the generated barrel file.  We match lines containing this string.
   */
  importFragment: string;
}

const CONTRACTS: ContractConfig[] = [
  {
    name: "dao-registry",
    bindingPath: "src/contracts/dao-registry/src/index.ts",
    importFragment: "contracts/dao-registry",
  },
  {
    name: "membership-sbt",
    bindingPath: "src/contracts/membership-sbt/src/index.ts",
    importFragment: "contracts/membership-sbt",
  },
  {
    name: "membership-tree",
    bindingPath: "src/contracts/membership-tree/src/index.ts",
    importFragment: "contracts/membership-tree",
  },
  {
    name: "voting",
    bindingPath: "src/contracts/voting/src/index.ts",
    importFragment: "contracts/voting",
  },
  {
    name: "comments",
    bindingPath: "src/contracts/comments/src/index.ts",
    importFragment: "contracts/comments",
  },
];

/** Path to the generated re-export barrel */
const GENERATED_FILE = "src/generated/contract-types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract explicitly exported names from a TypeScript source file using
 * simple regex heuristics.  We look for:
 *   export (type )? { ... }
 *   export (const|type|interface|enum|class|function) <name>
 *
 * This is intentionally conservative — we only surface names that are
 * *explicitly* exported (not via `export *`).
 */
function extractExports(src: string): Set<string> {
  const names = new Set<string>();

  // export { Foo, Bar as Baz, ... }  (with optional `type` keyword)
  const namedExportRe = /export\s+(?:type\s+)?\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = namedExportRe.exec(src)) !== null) {
    const inner = m[1];
    for (const entry of inner.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      // "Foo as Bar" → exported as "Bar"; "Foo" → exported as "Foo"
      const asMatch = /\bas\s+(\w+)/.exec(trimmed);
      const localMatch = /^(\w+)/.exec(trimmed);
      if (asMatch) {
        names.add(asMatch[1]);
      } else if (localMatch) {
        names.add(localMatch[1]);
      }
    }
  }

  // export const / type / interface / enum / class / function Foo
  const declarationRe =
    /^export\s+(?:type\s+|const\s+|interface\s+|enum\s+|class\s+|function\s+|abstract\s+class\s+)(\w+)/gm;
  while ((m = declarationRe.exec(src)) !== null) {
    names.add(m[1]);
  }

  return names;
}

/**
 * For a given binding import fragment, extract the set of local names that the
 * generated barrel imports FROM that specific binding source.
 *
 * Handles both single-line and multi-line export blocks:
 *   export { Foo, Bar as Baz } from '../contracts/voting/src/index.js';
 *   export type {
 *     DataKey as VotingDataKey,
 *     VoteMode,
 *   } from '../contracts/voting/src/index.js';
 *
 * Returns the *original* (local) names (before `as`).
 */
function extractImportedFromBinding(
  generatedSrc: string,
  importFragment: string,
): Set<string> {
  const imported = new Set<string>();

  // Use a regex that captures the names block AND the from path in one match.
  // The `[^}]+` inside braces handles multi-line content because `.` by default
  // doesn't match newlines but `[^}]` does.
  const exportFromRe =
    /export\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = exportFromRe.exec(generatedSrc)) !== null) {
    const namesBlock = m[1];
    const fromPath = m[2];

    // Only process exports that come from this specific binding source
    if (!fromPath.includes(importFragment)) continue;

    for (const entry of namesBlock.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      // "Foo as Bar" → local (original) name is "Foo"
      // "Foo"        → local name is "Foo"
      const localMatch = /^(\w+)/.exec(trimmed);
      if (localMatch) {
        imported.add(localMatch[1]);
      }
    }
  }

  return imported;
}

/**
 * Symbols we deliberately omit from the drift check.
 * These are either internal implementation details, re-exported
 * wildcard namespaces, or symbols expected to be absent in the
 * generated barrel file.
 */
const IGNORED_SYMBOLS = new Set([
  // Wildcard re-exports from stellar-sdk are not individually trackable
  "networks",
  // Class Client is not re-exported (only types & errors are needed)
  "Client",
]);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const generatedSrc = fs.readFileSync(
    path.join(ROOT, GENERATED_FILE),
    "utf8",
  );

  let driftFound = false;

  for (const contract of CONTRACTS) {
    const bindingSrc = fs.readFileSync(
      path.join(ROOT, contract.bindingPath),
      "utf8",
    );
    const bindingExports = extractExports(bindingSrc);
    const importedFromBinding = extractImportedFromBinding(
      generatedSrc,
      contract.importFragment,
    );

    const missing: string[] = [];
    for (const sym of bindingExports) {
      if (IGNORED_SYMBOLS.has(sym)) continue;
      if (!importedFromBinding.has(sym)) {
        missing.push(sym);
      }
    }

    if (missing.length > 0) {
      console.error(
        `\n[IDL drift] Contract '${contract.name}' has symbols not re-exported in ${GENERATED_FILE}:`,
      );
      for (const sym of missing) {
        console.error(`  - ${sym}`);
      }
      driftFound = true;
    } else {
      console.log(`[IDL drift] ✓ ${contract.name} — all exports covered`);
    }
  }

  if (driftFound) {
    console.error(
      "\n❌ IDL drift detected. Update src/generated/contract-types.ts to include the missing symbols.",
    );
    process.exit(1);
  }

  console.log(
    `\n✅ No IDL drift detected. ${GENERATED_FILE} is in sync with contract bindings.`,
  );
}

main();
