#!/usr/bin/env tsx
/**
 * Auth Token Management CLI
 *
 * Command-line utility for managing authentication tokens.
 * Usage:
 *   tsx src/token-manager.ts create --clientId <id> [--description <desc>] [--lifetimeMs <ms>]
 *   tsx src/token-manager.ts list [--clientId <id>] [--active-only]
 *   tsx src/token-manager.ts revoke --tokenId <id>
 *   tsx src/token-manager.ts rotate [--tokenId <id>]
 *   tsx src/token-manager.ts audit [--tokenId <id>] [--limit <n>]
 *   tsx src/token-manager.ts maintenance
 *   tsx src/token-manager.ts migrate-legacy
 *   tsx src/token-manager.ts config
 */

import { config, validateEnv } from "./config.js";
import { createLogger } from "./services/logger.js";
import * as db from "./services/db.js";
import {
  createNewToken,
  listTokens,
  listActiveTokens,
  revokeToken,
  rotateSingleToken,
  runTokenRotation,
  runMaintenanceTasks,
  getAuditEntries,
  listTokensForClient,
  getToken,
} from "./services/authTokens.js";
import { ensureLegacyTokenMigrated } from "./services/authScheduler.js";

const logger = createLogger("token-manager-cli");

type Command =
  | "create"
  | "list"
  | "revoke"
  | "rotate"
  | "audit"
  | "maintenance"
  | "migrate-legacy"
  | "config"
  | "help";

function parseArgs(): {
  command: Command;
  flags: Record<string, string | boolean | number>;
} {
  const args = process.argv.slice(2);
  const command = (args[0] as Command) || "help";
  const flags: Record<string, string | boolean | number> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = true;
      } else {
        const num = Number(next);
        flags[key] = Number.isFinite(num) && next !== "" ? num : next;
        i++;
      }
    }
  }

  return { command, flags };
}

function printHelp(): void {
  console.log(`
ZKVote Auth Token Manager

Usage: tsx src/token-manager.ts <command> [options]

Commands:
  create          Create a new authentication token
    --clientId      Client identifier (required)
    --description   Token description (optional)
    --lifetimeMs    Token lifetime in milliseconds (default: ${config.defaultTokenLifetimeMs})

  list            List all authentication tokens
    --clientId      Filter by client ID (optional)
    --active-only   Show only active tokens

  revoke          Revoke a specific token
    --tokenId       Token ID to revoke (required)

  rotate          Rotate tokens (create new, mark old as rotating)
    --tokenId       Rotate specific token only (optional, otherwise runs scheduled rotation)

  audit           View audit log entries
    --tokenId       Filter by token ID (optional)
    --clientId      Filter by client ID (optional)
    --limit         Max entries (default: 100)

  maintenance     Run auth maintenance tasks (expiration, cleanup, rotation)

  migrate-legacy  Migrate legacy RELAYER_AUTH_TOKEN from env to database

  config          Show current auth configuration

  help            Show this help message
`);
}

function formatToken(token: {
  id: string;
  clientId: string;
  description: string | null;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
  rotationGroupId: string | null;
  isLegacy: boolean;
}): string {
  return [
    `  ID:              ${token.id}`,
    `  Client:          ${token.clientId}`,
    `  Description:     ${token.description ?? "(none)"}`,
    `  Status:          ${token.status}${token.isLegacy ? " (LEGACY)" : ""}`,
    `  Created:         ${token.createdAt}`,
    `  Expires:         ${token.expiresAt ?? "(never)"}`,
    `  Revoked At:      ${token.revokedAt ?? "(not revoked)"}`,
    `  Last Used:       ${token.lastUsedAt ?? "(never)"}`,
    `  Use Count:       ${token.useCount}`,
    `  Rotation Group:  ${token.rotationGroupId ?? "(none)"}`,
  ].join("\n");
}

async function cmdCreate(flags: Record<string, string | boolean | number>): Promise<void> {
  const clientId = flags.clientId as string;
  if (!clientId) {
    console.error("ERROR: --clientId is required for create command");
    process.exit(1);
  }

  const description = (flags.description as string) ?? null;
  const lifetimeMs = flags.lifetimeMs as number | undefined;

  const token = createNewToken({
    clientId: String(clientId),
    description,
    lifetimeMs,
  });

  console.log("\n=== NEW AUTH TOKEN CREATED ===");
  console.log("  IMPORTANT: Store this raw token securely. It cannot be retrieved later.");
  console.log("");
  console.log(`  Raw Token:  ${token.rawToken}`);
  console.log(`  Token ID:   ${token.id}`);
  console.log(`  Client ID:  ${token.clientId}`);
  console.log(`  Expires:    ${token.expiresAt ?? "(never)"}`);
  console.log(`  Description: ${token.description ?? "(none)"}`);
  console.log("");
  console.log("  Use this token in requests via header:");
  console.log(`    Authorization: Bearer ${token.rawToken}`);
  console.log(`    X-Relayer-Auth: ${token.rawToken}`);
  console.log(`    X-Client-Id: ${token.clientId} (optional but recommended)`);
  console.log("");
}

function cmdList(flags: Record<string, string | boolean | number>): void {
  const clientId = flags.clientId as string | undefined;
  const activeOnly = flags["active-only"] === true;

  let tokens;
  if (clientId) {
    tokens = listTokensForClient(String(clientId));
  } else if (activeOnly) {
    tokens = listActiveTokens();
  } else {
    tokens = listTokens();
  }

  console.log(`\n=== AUTH TOKENS (${tokens.length} found) ===\n`);
  for (const token of tokens) {
    console.log(formatToken(token));
    console.log("");
  }
}

function cmdRevoke(flags: Record<string, string | boolean | number>): void {
  const tokenId = flags.tokenId as string;
  if (!tokenId) {
    console.error("ERROR: --tokenId is required for revoke command");
    process.exit(1);
  }

  const token = getToken(String(tokenId));
  if (!token) {
    console.error(`ERROR: Token not found: ${tokenId}`);
    process.exit(1);
  }

  const revoked = revokeToken(String(tokenId));
  if (revoked) {
    console.log(`\nToken revoked successfully: ${tokenId}`);
    console.log(`  Client: ${token.clientId}`);
    console.log(`  Previous status: ${token.status}`);
  } else {
    console.error(`ERROR: Could not revoke token ${tokenId}`);
    console.error(`  Current status: ${token.status}`);
    process.exit(1);
  }
}

function cmdRotate(flags: Record<string, string | boolean | number>): void {
  const tokenId = flags.tokenId as string | undefined;

  if (tokenId) {
    const oldToken = getToken(String(tokenId));
    if (!oldToken) {
      console.error(`ERROR: Token not found: ${tokenId}`);
      process.exit(1);
    }

    const newToken = rotateSingleToken(oldToken);
    if (!newToken) {
      console.error(`ERROR: Could not rotate token ${tokenId} (must be active)`);
      process.exit(1);
    }

    console.log("\n=== TOKEN ROTATED ===");
    console.log(`  Old Token ID: ${tokenId}`);
    console.log(`  New Token ID: ${newToken.id}`);
    console.log(`  Client: ${newToken.clientId}`);
    console.log(`  New Raw Token: ${newToken.rawToken}`);
    console.log(`  New Expires: ${newToken.expiresAt ?? "(never)"}`);
    console.log("");
    console.log(`  Transition period (both tokens valid): ${config.tokenRotationTransitionMs}ms (${Math.round(config.tokenRotationTransitionMs / 86400000)} days)`);
  } else {
    if (!config.tokenRotationEnabled) {
      console.warn("WARNING: Token rotation is disabled (TOKEN_ROTATION_ENABLED=false)");
    }

    const results = runTokenRotation();
    console.log(`\n=== SCHEDULED ROTATION ===");
    console.log(`Rotated ${results.length} tokens.\n`);

    for (const r of results) {
      console.log(`  ${r.oldTokenId} -> ${r.newTokenId} (${r.clientId})`);
      console.log(`    New Token: ${r.rawToken}`);
      console.log("");
    }
  }
}

function cmdAudit(flags: Record<string, string | boolean | number>): void {
  const tokenId = flags.tokenId as string | undefined;
  const clientId = flags.clientId as string | undefined;
  const limit = (flags.limit as number) || 100;

  const entries = getAuditEntries({
    tokenId: tokenId ? String(tokenId) : undefined,
    clientId: clientId ? String(clientId) : undefined,
    limit: Number(limit),
  });

  console.log(`\n=== AUTH AUDIT LOG (${entries.length} entries) ===\n`);
  for (const entry of entries) {
    const parts = [
      entry.createdAt,
      entry.success ? "SUCCESS" : "FAILURE",
      entry.action.padEnd(25),
    ];
    if (entry.tokenId) parts.push(`token=${entry.tokenId}`);
    if (entry.clientId) parts.push(`client=${entry.clientId}`);
    if (entry.method && entry.path) parts.push(`${entry.method} ${entry.path}`);
    if (entry.ipHash) parts.push(`ip=${entry.ipHash}`);
    if (entry.errorMessage) parts.push(`err=${entry.errorMessage}`);
    console.log("  " + parts.join(" | "));
  }
  console.log("");
}

function cmdMaintenance(): void {
  console.log("\n=== RUNNING AUTH MAINTENANCE ===");
  const result = runMaintenanceTasks();
  console.log("");
  console.log(`  Tokens expired:       ${result.expiredCount}`);
  console.log(`  Old tokens cleaned:   ${result.cleanedTokens}`);
  console.log(`  Audit entries cleaned:${result.cleanedAuditEntries}`);
  console.log(`  Tokens rotated:       ${result.rotatedCount}`);
  console.log("");
}

function cmdMigrateLegacy(): void {
  console.log("\n=== MIGRATING LEGACY TOKEN ===");
  if (!config.relayerAuthToken) {
    console.log("  No RELAYER_AUTH_TOKEN environment variable set. Nothing to migrate.");
  } else {
    ensureLegacyTokenMigrated();
    console.log("  Legacy token migration completed.");
    console.log("  Token stored in database with status 'active' as client 'legacy-client'.");
    console.log("  It is recommended to:");
    console.log("    1. Create new per-client tokens via 'create' command or API");
    console.log("    2. Distribute new tokens to clients");
    console.log("    3. Revoke the legacy token after transition period");
  }
  console.log("");
}

function cmdConfig(): void {
  console.log("\n=== AUTH CONFIGURATION ===");
  console.log(`  Token Rotation Enabled:   ${config.tokenRotationEnabled}`);
  console.log(`  Rotation Interval:        ${config.tokenRotationIntervalMs}ms (${Math.round(config.tokenRotationIntervalMs / 86400000)} days)`);
  console.log(`  Transition/Grace Period:  ${config.tokenRotationTransitionMs}ms (${Math.round(config.tokenRotationTransitionMs / 86400000)} days)`);
  console.log(`  Default Token Lifetime:   ${config.defaultTokenLifetimeMs}ms (${Math.round(config.defaultTokenLifetimeMs / 86400000)} days)`);
  console.log(`  Audit Logging Enabled:    ${config.tokenAuditLogEnabled}`);
  console.log(`  Legacy Token Set:         ${config.relayerAuthToken ? "yes" : "no"}`);
  console.log("");
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs();

  if (command === "help") {
    printHelp();
    return;
  }

  try {
    validateEnv();
  } catch (err) {
    console.error("Environment validation failed:", (err as Error).message);
    process.exit(1);
  }

  db.initDb();
  ensureLegacyTokenMigrated();

  try {
    switch (command) {
      case "create":
        await cmdCreate(flags);
        break;
      case "list":
        cmdList(flags);
        break;
      case "revoke":
        cmdRevoke(flags);
        break;
      case "rotate":
        cmdRotate(flags);
        break;
      case "audit":
        cmdAudit(flags);
        break;
      case "maintenance":
        cmdMaintenance();
        break;
      case "migrate-legacy":
        cmdMigrateLegacy();
        break;
      case "config":
        cmdConfig();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    logger.error("cli_error", {
      command,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    console.error(`\nERROR: ${(err as Error).message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
