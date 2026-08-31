/**
 * Audit Log Service
 *
 * Append-only, hash-chained record of privileged/administrative actions,
 * separate from the general request/response logging in middleware/logging.ts.
 * Each row's hash covers its fields plus the previous row's hash, so tampering
 * with or removing a past entry breaks the chain — detectable via
 * verifyAuditChain().
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { insertAuditLog, getAuditLogs as dbGetAuditLogs, getAllAuditLogsOrdered, getUnarchivedAuditLogsOlderThan, markAuditLogsArchived, deleteAuditLogs, } from "./db.js";
import { redact, log } from "./logger.js";
import { config } from "../config.js";
/**
 * Hash an auth token to a short, non-reversible identifier for audit records.
 * The relayer currently has a single shared token (no per-user identity), so
 * this identifies "the caller presented a valid token", not a specific user —
 * documented in API.md.
 */
export function hashAuthToken(token) {
    if (!token)
        return null;
    return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}
export function hashClientIp(ip) {
    if (!ip)
        return null;
    return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
}
/**
 * Record one audit entry. Params are redacted using the same sensitive-field
 * list as the general logger, then size-capped to keep rows small.
 */
export function recordAuditLog(entry) {
    const redactedParams = entry.params ? redact(entry.params) : undefined;
    const paramsJson = redactedParams
        ? JSON.stringify(redactedParams).slice(0, 4000)
        : null;
    const row = insertAuditLog({
        timestamp: new Date().toISOString(),
        action: entry.action,
        endpoint: entry.endpoint,
        authTokenId: entry.authTokenId,
        ipHash: entry.ipHash,
        requestId: entry.requestId,
        params: paramsJson,
        statusCode: entry.statusCode,
    });
    log("info", "audit_log_recorded", {
        action: entry.action,
        endpoint: entry.endpoint,
        statusCode: entry.statusCode,
    });
    return row;
}
export function getAuditLogs(options = {}) {
    return dbGetAuditLogs(options);
}
function computeRowHash(row, prevHash) {
    return crypto
        .createHash("sha256")
        .update(JSON.stringify({
        timestamp: row.timestamp,
        action: row.action,
        endpoint: row.endpoint,
        authTokenId: row.auth_token_id,
        ipHash: row.ip_hash,
        requestId: row.request_id,
        params: row.params,
        statusCode: row.status_code,
        prevHash,
    }))
        .digest("hex");
}
/**
 * Recompute the hash chain across every stored row (archived or not) and
 * confirm each hash matches what its fields + the previous row's hash should
 * produce. Any past edit, deletion-without-archival, or reordering surfaces
 * here as the first mismatched id.
 */
export function verifyAuditChain() {
    const rows = getAllAuditLogsOrdered();
    let prevHash = "genesis";
    for (const row of rows) {
        if (row.prev_hash !== prevHash) {
            return {
                valid: false,
                checkedCount: rows.length,
                brokenAtId: row.id,
                reason: "prev_hash does not match the preceding row's hash",
            };
        }
        const expectedHash = computeRowHash(row, prevHash);
        if (expectedHash !== row.hash) {
            return {
                valid: false,
                checkedCount: rows.length,
                brokenAtId: row.id,
                reason: "stored hash does not match recomputed hash",
            };
        }
        prevHash = row.hash;
    }
    return { valid: true, checkedCount: rows.length };
}
/**
 * Format audit log rows as CEF (Common Event Format) lines, for ingestion
 * into standard SIEM tooling.
 */
export function formatAsCef(rows) {
    return rows
        .map((row) => {
        const ext = [
            `rt=${row.timestamp}`,
            `request=${row.endpoint}`,
            `suser=${row.auth_token_id ?? "unknown"}`,
            `src=${row.ip_hash ?? "unknown"}`,
            `outcome=${row.status_code ?? ""}`,
            `cs1Label=requestId`,
            `cs1=${row.request_id ?? ""}`,
            `cs2Label=hash`,
            `cs2=${row.hash}`,
        ].join(" ");
        // CEF:Version|Device Vendor|Device Product|Device Version|Signature ID|Name|Severity|Extension
        return `CEF:0|ZK-VOTE|backend|1.0|${row.action}|${row.action}|3|${ext}`;
    })
        .join("\n");
}
const ARCHIVE_DIR_DEFAULT = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", config.auditLogArchiveDir.replace(/^\.\//, ""));
function ensureArchiveDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}
/**
 * Rotation/archival: export unarchived rows older than the retention window
 * to a compressed, timestamped JSONL file, mark them archived_at, then delete
 * them from the hot table (the append-only trigger only permits deleting rows
 * that have already been archived — see db.ts).
 */
export function archiveOldAuditLogs(retentionDays = config.auditLogRetentionDays, archiveDir = ARCHIVE_DIR_DEFAULT) {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = getUnarchivedAuditLogsOlderThan(cutoff);
    if (rows.length === 0) {
        return { archivedCount: 0, filePath: null };
    }
    const dir = ensureArchiveDir(archiveDir);
    const fileName = `audit_log_${Date.now()}.jsonl.gz`;
    const filePath = path.join(dir, fileName);
    const jsonl = rows.map((r) => JSON.stringify(r)).join("\n");
    fs.writeFileSync(filePath, zlib.gzipSync(Buffer.from(jsonl, "utf-8")));
    const ids = rows.map((r) => r.id);
    const now = new Date().toISOString();
    markAuditLogsArchived(ids, now);
    deleteAuditLogs(ids);
    log("info", "audit_log_archived", {
        count: rows.length,
        filePath,
        retentionDays,
    });
    return { archivedCount: rows.length, filePath };
}
let rotationTimer = null;
export function startAuditLogRotation(intervalMs = config.auditLogRotationIntervalMs) {
    if (rotationTimer)
        clearInterval(rotationTimer);
    rotationTimer = setInterval(() => {
        try {
            archiveOldAuditLogs();
        }
        catch (err) {
            log("error", "audit_log_rotation_failed", {
                error: err.message,
            });
        }
    }, intervalMs);
    log("info", "audit_log_rotation_started", { intervalMs });
}
export function stopAuditLogRotation() {
    if (rotationTimer) {
        clearInterval(rotationTimer);
        rotationTimer = null;
        log("info", "audit_log_rotation_stopped");
    }
}
//# sourceMappingURL=audit.js.map