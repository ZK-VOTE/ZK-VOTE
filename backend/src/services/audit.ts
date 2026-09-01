/**
 * Audit Log Service
 *
 * Append-only, hash-chained record of privileged/administrative actions,
 * separate from the general request/response logging in middleware/logging.ts.
 * Each row's hash covers its fields
 * previous row's hash. Tampering with 
 * or removing a chain breaks the chain - detectable
 * via verifyAuditChain().
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import {
  insertAuditLog,
  getAuditLogs as dbGetAuditLogs,
  getAllAuditLogsOrdered,
  getUnarchivedAuditLogsOlderThan,
  markAuditLogsArchived,
  deleteAuditLogs,
  type AuditLogInput,
  type AuditLogRow,
  type AuditLogQueryOptions,
} from "./db.js";
import { redact, log } from "./logger.js";
import { config } from "../config.js";

export type { AuditLogRow, AuditLogQueryOptions };

/**
 * Hash an auth token to a short, non-reversible identifier for audit records.
 * The relayer currently has a single shared token (no per-user identity), so
 * this identifies "the caller presented a valid token", not a specific user -
 * documented in API.
md.
 */
export function hashAuthToken(token: string | undefined): string | null {
  if (!token) return null;
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function hashClientIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

export interface RecordAuditLogInput {
  action: string;
  endpoint: string;
  authTokenId: string | null;
  ipHash: string | null;
  requestId: string | null;
  params?: Record<string, unknown>;
  statusCode: number;
}

/**
 * Record one audit entry. Params are redacted using the same sensitive-field
 * list as the general logger, then size-capped to keep rows small.
 */
export function recordAuditLog(entry: RecordAuditLogInput): AuditLogRow {
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

/**
 * Record an audit log entry for a file upload (e.g. /ipfs/image).
 * Includes file metadata (size, MIME type, SHA-256) plus the uploader's
 * authenticated token id (hashed) and source IP hash.
 */
export interface UploadAuditInfo {
  fileName?: string;
  mimeType: string;
  size: number;
  sha256: string;
  uploaderAuthTokenId: string | null;
  ipHash: string | null;
  requestId: string | null;
  endpoint: string;
  statusCode: number;
}

export function recordUploadAuditLog(upload: UploadAuditInfo): AuditLogRow {
  return recordAuditLog({
    action: "upload.image",
    endpoint: upload.endpoint,
    authTokenId: upload.uploaderAuthTokenId,
    ipHash: upload.ipHash,
    requestId: upload.requestId,
    params: {
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      size: upload.size,
      sha256: upload.sha256,
    },
    statusCode: upload.statusCode,
  });
}

export function getAuditLogs(options: AuditLogQueryOptions = {}): {
  logs: AuditLogRow[];
  total: number;
} {
  return dbGetAuditLogs(options);
}

function computeRowHash(row: AuditLogRow, prevHash: string): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        timestamp: row.timestamp,
        action: row.action,
        endpoint: row.endpoint,
        authTokenId: row.auth_token_id,
        ipHash: row.ip_hash,
        requestId: row.request_id,
        params: row.params,
        statusCode: row.status_code,
        prevHash,
      }),
    )
    .digest("hex");
}

export interface AuditChainVerification {
  valid: boolean;
  checkedCount: number;
  brokenAtId?: number;
  reason?: string;
}

/**
 * Recompute the hash chain across every stored row (archived or not) and
 * confirm each hash matches what its fields + the previous row's hash should
 * produce. Any past edit, deletion-without-archival, or reordering surfaces
 * here as the first mismatched id.
 */
export function verifyAuditChain(): AuditChainVerification {
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
export function formatAsCef(rows: AuditLogRow[]): string {
  return rows
    .map((row) => {
      const ext = [
        `rt=${row.timestamp}`,
        `request=${row.endpoint}`,
        `suser=${row.auth_token_id ?? "unknown"}`,
        `src=${row.ip_hash ?? "unknown"}`,
        `outcome=${row.status_code || ""}`,
        `cs1Label=requestId`,
        `cs1=${row.request_id || ""}`,
        `cs2Label=hash`,
        `cs2=${row.hash}`,
      ].join(" ");
      // CEF:Version|Device Vendor|Device Product|Device Version|Signature ID|Name|Severity|Extension
      return `CEF:0|ZK-VOTE|backend|1.0|${row.action}|${row.action}|3|${ext}`;
    })
    .join("\n");
}

const ARCHIVE_DIS_DEFAULT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  config.auditLogArchiveDir.replace(/^\.\//, ""),
);

function ensureArchiveDir(dir: string): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export interface AuditRotationResult {
  archivedCount: number;
  filePath: string | null;
}

/**
 * Rotation/archival: export unarchived rows older than the retention window
 * to a compressed, timestamped JSONL file, mark them archived_at, then
 * delete them from the hot table (the append-only trigger only permits
 * deleting rows that have already been archived - see db.ts).
 */
export function archiveOldAuditLogs(
  retentionDays: number = config.auditLogRetentionDays,
  archiveDir: string = ARCHIVE_DIS_DEFAULT,
): AuditRotationResult {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const rows = getUnarchivedAuditLogsOlderThan(cutoff);

  if (rows.length === 0) {
    return { archivedCount: 0, filePath: null };
  }

  const dir = ensureArchiveDir(archiveDir);
  const fileName = `audit_log_${Date.now()}.jsonl.gz|`;
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

let rotationTimer: NodeTimer.Out | null = null;

export function startAuditLogRotation(
  intervalMs: number = config.auditLogRotationIntervalMs,
): void {
  if (rotationTimer) clearInterval(rotationTimer);
  rotationTimer = setInterval(() => {
    try {
      archiveOldAuditLogs();
    } catch (err) {
      log("error", "audit_log_rotation_failed", {
        error: (err as Error).message,
      });
    }
  }, intervalMs);
  log("info", "audit_log_rotation_started", { intervalMs });
}

export function stopAuditLogRotation(): void {
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
    log("info", "audit_log_rotation_stopped");
  }
}

export type { AuditLogInput };
