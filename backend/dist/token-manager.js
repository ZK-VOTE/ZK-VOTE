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
import { createNewToken, listTokens, listActiveTokens, revokeToken, rotateSingleToken, runTokenRotation, runMaintenanceTasks, getAuditEntries, listTokensForClient, getToken, } from "./services/authTokens.js";
import { ensureLegacyTokenMigrated } from "./services/authScheduler.js";
const logger = createLogger("token-manager-cli");
function parseArgs() {
    const args = process.argv.slice(2);
    const command = args[0] || "help";
    const flags = {};
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith("--")) {
            const key = arg.slice(2);
            const next = args[i + 1];
            if (!next || next.startsWith("--")) {
                flags[key] = true;
            }
            else {
                const num = Number(next);
                flags[key] = Number.isFinite(num) && next !== "" ? num : next;
                i++;
            }
        }
    }
    return { command, flags };
}
function printHelp() {
    console.info(`
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
function formatToken(token) {
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
async function cmdCreate(flags) {
    const clientId = flags.clientId;
    if (!clientId) {
        console.error("ERROR: --clientId is required for create command");
        process.exit(1);
    }
    const description = flags.description ?? null;
    const lifetimeMs = flags.lifetimeMs;
    const token = createNewToken({
        clientId: String(clientId),
        description,
        lifetimeMs,
    });
    console.info("\n=== NEW AUTH TOKEN CREATED ===");
    console.info("  IMPORTANT: Store this raw token securely. It cannot be retrieved later.");
    console.info("");
    console.info(`  Raw Token:  ${token.rawToken}`);
    console.info(`  Token ID:   ${token.id}`);
    console.info(`  Client ID:  ${token.clientId}`);
    console.info(`  Expires:    ${token.expiresAt ?? "(never)"}`);
    console.info(`  Description: ${token.description ?? "(none)"}`);
    console.info("");
    console.info("  Use this token in requests via header:");
    console.info(`    Authorization: Bearer ${token.rawToken}`);
    console.info(`    X-Relayer-Auth: ${token.rawToken}`);
    console.info(`    X-Client-Id: ${token.clientId} (optional but recommended)`);
    console.info("");
}
function cmdList(flags) {
    const clientId = flags.clientId;
    const activeOnly = flags["active-only"] === true;
    let tokens;
    if (clientId) {
        tokens = listTokensForClient(String(clientId));
    }
    else if (activeOnly) {
        tokens = listActiveTokens();
    }
    else {
        tokens = listTokens();
    }
    console.info(`\n=== AUTH TOKENS (${tokens.length} found) ===\n`);
    for (const token of tokens) {
        console.info(formatToken(token));
        console.info("");
    }
}
function cmdRevoke(flags) {
    const tokenId = flags.tokenId;
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
        console.info(`\nToken revoked successfully: ${tokenId}`);
        console.info(`  Client: ${token.clientId}`);
        console.info(`  Previous status: ${token.status}`);
    }
    else {
        console.error(`ERROR: Could not revoke token ${tokenId}`);
        console.error(`  Current status: ${token.status}`);
        process.exit(1);
    }
}
function cmdRotate(flags) {
    const tokenId = flags.tokenId;
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
        console.info("\n=== TOKEN ROTATED ===");
        console.info(`  Old Token ID: ${tokenId}`);
        console.info(`  New Token ID: ${newToken.id}`);
        console.info(`  Client: ${newToken.clientId}`);
        console.info(`  New Raw Token: ${newToken.rawToken}`);
        console.info(`  New Expires: ${newToken.expiresAt ?? "(never)"}`);
        console.info("");
        console.info(`  Transition period (both tokens valid): ${config.tokenRotationTransitionMs}ms (${Math.round(config.tokenRotationTransitionMs / 86400000)} days)`);
    }
    else {
        if (!config.tokenRotationEnabled) {
            console.warn("WARNING: Token rotation is disabled (TOKEN_ROTATION_ENABLED=false)");
        }
        const results = runTokenRotation();
        console.info(`\n=== SCHEDULED ROTATION ===`);
        console.info(`Rotated ${results.length} tokens.\n`);
        for (const r of results) {
            console.info(`  ${r.oldTokenId} -> ${r.newTokenId} (${r.clientId})`);
            console.info(`    New Token: ${r.rawToken}`);
            console.info("");
        }
    }
}
function cmdAudit(flags) {
    const tokenId = flags.tokenId;
    const clientId = flags.clientId;
    const limit = flags.limit || 100;
    const entries = getAuditEntries({
        tokenId: tokenId ? String(tokenId) : undefined,
        clientId: clientId ? String(clientId) : undefined,
        limit: Number(limit),
    });
    console.info(`\n=== AUTH AUDIT LOG (${entries.length} entries) ===\n`);
    for (const entry of entries) {
        const parts = [
            entry.createdAt,
            entry.success ? "SUCCESS" : "FAILURE",
            entry.action.padEnd(25),
        ];
        if (entry.tokenId)
            parts.push(`token=${entry.tokenId}`);
        if (entry.clientId)
            parts.push(`client=${entry.clientId}`);
        if (entry.method && entry.path)
            parts.push(`${entry.method} ${entry.path}`);
        if (entry.ipHash)
            parts.push(`ip=${entry.ipHash}`);
        if (entry.errorMessage)
            parts.push(`err=${entry.errorMessage}`);
        console.info("  " + parts.join(" | "));
    }
    console.info("");
}
function cmdMaintenance() {
    console.info("\n=== RUNNING AUTH MAINTENANCE ===");
    const result = runMaintenanceTasks();
    console.info("");
    console.info(`  Tokens expired:       ${result.expiredCount}`);
    console.info(`  Old tokens cleaned:   ${result.cleanedTokens}`);
    console.info(`  Audit entries cleaned:${result.cleanedAuditEntries}`);
    console.info(`  Tokens rotated:       ${result.rotatedCount}`);
    console.info("");
}
function cmdMigrateLegacy() {
    console.info("\n=== MIGRATING LEGACY TOKEN ===");
    if (!config.relayerAuthToken) {
        console.info("  No RELAYER_AUTH_TOKEN environment variable set. Nothing to migrate.");
    }
    else {
        ensureLegacyTokenMigrated();
        console.info("  Legacy token migration completed.");
        console.info("  Token stored in database with status 'active' as client 'legacy-client'.");
        console.info("  It is recommended to:");
        console.info("    1. Create new per-client tokens via 'create' command or API");
        console.info("    2. Distribute new tokens to clients");
        console.info("    3. Revoke the legacy token after transition period");
    }
    console.info("");
}
function cmdConfig() {
    console.info("\n=== AUTH CONFIGURATION ===");
    console.info(`  Token Rotation Enabled:   ${config.tokenRotationEnabled}`);
    console.info(`  Rotation Interval:        ${config.tokenRotationIntervalMs}ms (${Math.round(config.tokenRotationIntervalMs / 86400000)} days)`);
    console.info(`  Transition/Grace Period:  ${config.tokenRotationTransitionMs}ms (${Math.round(config.tokenRotationTransitionMs / 86400000)} days)`);
    console.info(`  Default Token Lifetime:   ${config.defaultTokenLifetimeMs}ms (${Math.round(config.defaultTokenLifetimeMs / 86400000)} days)`);
    console.info(`  Audit Logging Enabled:    ${config.tokenAuditLogEnabled}`);
    console.info(`  Legacy Token Set:         ${config.relayerAuthToken ? "yes" : "no"}`);
    console.info("");
}
async function main() {
    const { command, flags } = parseArgs();
    if (command === "help") {
        printHelp();
        return;
    }
    try {
        validateEnv();
    }
    catch (err) {
        console.error("Environment validation failed:", err.message);
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
    }
    catch (err) {
        logger.error("cli_error", {
            command,
            error: err.message,
            stack: err.stack,
        });
        console.error(`\nERROR: ${err.message}`);
        process.exit(1);
    }
}
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        console.error("Fatal error:", err);
        process.exit(1);
    });
}
//# sourceMappingURL=token-manager.js.map