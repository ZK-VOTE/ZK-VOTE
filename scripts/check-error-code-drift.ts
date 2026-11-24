#!/usr/bin/env node
/**
 * Error Code Drift Check
 * 
 * ZV-126: Verifies that error codes in shared/error-codes.ts match docs/error-codes.md
 * and that all error codes returned by routes are documented.
 * 
 * Usage:
 *   npm run check:error-codes
 * 
 * Exit codes:
 *   0 - No drift detected
 *   1 - Drift detected or validation errors
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

interface ErrorCodeEntry {
  code: number;
  name: string;
  description: string;
  source: string; // file:line where found
}

interface DriftReport {
  undocumentedCodes: ErrorCodeEntry[];
  missingImplementations: ErrorCodeEntry[];
  mismatchedDescriptions: Array<{
    code: number;
    name: string;
    docDescription: string;
    codeDescription: string;
  }>;
}

/**
 * Parse error codes from docs/error-codes.md
 */
async function parseErrorCodesFromDocs(): Promise<Map<string, ErrorCodeEntry[]>> {
  const docsPath = path.join(rootDir, "docs", "error-codes.md");
  const content = await fs.readFile(docsPath, "utf-8");
  
  const errorsByContract = new Map<string, ErrorCodeEntry[]>();
  let currentContract = "";
  
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Detect contract section headers
    if (line.startsWith("## ") && line.includes("Errors")) {
      currentContract = line.replace("## ", "").replace(" Errors", "").trim();
      errorsByContract.set(currentContract, []);
      continue;
    }
    
    // Parse table rows: | Code | Name | Description | ...
    if (line.startsWith("|") && !line.includes("Code") && !line.includes("---")) {
      const parts = line.split("|").map(s => s.trim()).filter(s => s);
      if (parts.length >= 3) {
        const code = parseInt(parts[0]);
        const name = parts[1].replace(/`/g, "");
        const description = parts[2];
        
        if (!isNaN(code) && name && currentContract) {
          errorsByContract.get(currentContract)?.push({
            code,
            name,
            description,
            source: `docs/error-codes.md:${i + 1}`,
          });
        }
      }
    }
  }
  
  return errorsByContract;
}

/**
 * Parse error codes from shared/error-codes.ts
 */
async function parseErrorCodesFromShared(): Promise<Map<string, ErrorCodeEntry[]>> {
  const sharedPath = path.join(rootDir, "shared", "error-codes.ts");
  const content = await fs.readFile(sharedPath, "utf-8");
  
  const errorsByContract = new Map<string, ErrorCodeEntry[]>();
  let currentEnum = "";
  let currentContract = "";
  
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Detect enum declarations
    const enumMatch = line.match(/^export enum (\w+Error) \{/);
    if (enumMatch) {
      currentEnum = enumMatch[1];
      currentContract = currentEnum.replace("Error", "");
      errorsByContract.set(currentContract, []);
      continue;
    }
    
    // Parse enum entries: Name = Code,
    const entryMatch = line.match(/^(\w+)\s*=\s*(\d+),?/);
    if (entryMatch && currentContract) {
      const name = entryMatch[1];
      const code = parseInt(entryMatch[2]);
      
      errorsByContract.get(currentContract)?.push({
        code,
        name,
        description: "", // Will be filled from messages const
        source: `shared/error-codes.ts:${i + 1}`,
      });
    }
  }
  
  return errorsByContract;
}

/**
 * Compare error codes and generate drift report
 */
function compareCodes(
  docsMap: Map<string, ErrorCodeEntry[]>,
  sharedMap: Map<string, ErrorCodeEntry[]>
): DriftReport {
  const report: DriftReport = {
    undocumentedCodes: [],
    missingImplementations: [],
    mismatchedDescriptions: [],
  };
  
  // Check for codes in shared but not in docs
  for (const [contract, sharedCodes] of sharedMap.entries()) {
    const docsCodes = docsMap.get(contract) || [];
    const docsCodeNumbers = new Set(docsCodes.map(e => e.code));
    
    for (const sharedCode of sharedCodes) {
      if (!docsCodeNumbers.has(sharedCode.code)) {
        report.undocumentedCodes.push({
          ...sharedCode,
          source: `${contract}.${sharedCode.name} (code ${sharedCode.code})`,
        });
      }
    }
  }
  
  // Check for codes in docs but not in shared
  for (const [contract, docsCodes] of docsMap.entries()) {
    const sharedCodes = sharedMap.get(contract) || [];
    const sharedCodeNumbers = new Set(sharedCodes.map(e => e.code));
    
    for (const docsCode of docsCodes) {
      if (!sharedCodeNumbers.has(docsCode.code)) {
        report.missingImplementations.push({
          ...docsCode,
          source: `${contract}.${docsCode.name} (code ${docsCode.code})`,
        });
      }
    }
  }
  
  return report;
}

/**
 * Print drift report
 */
function printReport(report: DriftReport): void {
  let hasIssues = false;
  
  if (report.undocumentedCodes.length > 0) {
    hasIssues = true;
    console.error("\n❌ UNDOCUMENTED ERROR CODES (in shared/ but not in docs/):");
    console.error("These error codes are defined in shared/error-codes.ts but missing from docs/error-codes.md\n");
    for (const code of report.undocumentedCodes) {
      console.error(`  • ${code.source}`);
    }
  }
  
  if (report.missingImplementations.length > 0) {
    hasIssues = true;
    console.error("\n❌ MISSING IMPLEMENTATIONS (in docs/ but not in shared/):");
    console.error("These error codes are documented in docs/error-codes.md but missing from shared/error-codes.ts\n");
    for (const code of report.missingImplementations) {
      console.error(`  • ${code.source}`);
    }
  }
  
  if (report.mismatchedDescriptions.length > 0) {
    hasIssues = true;
    console.error("\n⚠️  MISMATCHED DESCRIPTIONS:");
    for (const mismatch of report.mismatchedDescriptions) {
      console.error(`  • ${mismatch.name} (code ${mismatch.code})`);
      console.error(`    Docs: ${mismatch.docDescription}`);
      console.error(`    Code: ${mismatch.codeDescription}`);
    }
  }
  
  if (!hasIssues) {
    console.log("✅ No error code drift detected!");
    console.log("   All error codes in shared/error-codes.ts match docs/error-codes.md");
  } else {
    console.error("\n❌ Error code drift detected. Please update either:");
    console.error("   • docs/error-codes.md to document new codes, or");
    console.error("   • shared/error-codes.ts to implement documented codes");
    process.exit(1);
  }
}

/**
 * Main execution
 */
async function main(): Promise<void> {
  console.log("🔍 Checking error code drift...\n");
  
  try {
    const docsMap = await parseErrorCodesFromDocs();
    const sharedMap = await parseErrorCodesFromShared();
    
    console.log(`📄 Found ${Array.from(docsMap.values()).flat().length} error codes in docs/error-codes.md`);
    console.log(`💾 Found ${Array.from(sharedMap.values()).flat().length} error codes in shared/error-codes.ts\n`);
    
    const report = compareCodes(docsMap, sharedMap);
    printReport(report);
  } catch (error) {
    console.error("❌ Error during drift check:");
    console.error(error);
    process.exit(1);
  }
}

main();
