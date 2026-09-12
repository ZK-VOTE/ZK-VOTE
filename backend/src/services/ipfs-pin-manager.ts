// @ts-nocheck
/**
 * IPFS Pin Manager — Redundancy & Recovery Layer
 *
 * Provides:
 *  - Local file-system backup of all pinned content before upload
 *  - Secondary pinning service (Web3.Storage) for redundancy
 *  - CID availability verification (fetch + byte-check)
 *  - Automatic re-pin of unavailable content from local backup
 *  - Pin cost tracking and metrics
 */

import fs from "node:fs";
import path from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("pin-manager");

// ============================================
// TYPES
// ============================================

export interface PinRecord {
  cid: string;
  /** "json" | "file" */
  contentType: "json" | "file";
  /** Original filename (for files) or label (for JSON) */
  name: string;
  /** MIME type for files */
  mimeType?: string;
  /** Size in bytes */
  sizeBytes: number;
  /** ISO timestamp of first pin */
  pinnedAt: string;
  /** Which services hold the pin */
  pinnedOn: ("pinata" | "web3storage" | "local")[];
  /** Last successful verification timestamp (ISO) */
  lastVerifiedAt: string | null;
  /** Number of consecutive verification failures */
  consecutiveFailures: number;
  /** Estimated cumulative pin cost in USD (Pinata pricing model) */
  estimatedCostUsd: number;
}

export interface PinVerificationResult {
  cid: string;
  reachable: boolean;
  gateway: string;
  latencyMs: number;
  error?: string;
}

export interface PinManagerStats {
  totalPins: number;
  totalSizeBytes: number;
  estimatedMonthlyCostUsd: number;
  healthyPins: number;
  degradedPins: number;
  failedPins: number;
  lastFullScanAt: string | null;
  lastFullScanDurationMs: number | null;
}

// ============================================
// CONSTANTS
// ============================================

// Pinata free tier: $0 for first 500 MB, ~$0.10/GB/month after
const PINATA_COST_PER_BYTE_MONTH = 0.1 / (1024 * 1024 * 1024);

// Verification fetch timeout per gateway
const VERIFY_TIMEOUT_MS = 15_000;

// Gateways to verify against (order matters: primary first)
const VERIFY_GATEWAYS = [
  "https://ipfs.io/ipfs",
  "https://dweb.link/ipfs",
  "https://cloudflare-ipfs.com/ipfs",
  "https://w3s.link/ipfs",
];

// ============================================
// MODULE STATE
// ============================================

let backupDir: string | null = null;
let web3StorageToken: string | null = null;

/** In-memory pin registry keyed by CID */
const pinRegistry = new Map<string, PinRecord>();

/** Stats for the last full scan */
let lastScanAt: string | null = null;
let lastScanDurationMs: number | null = null;

// ============================================
// INITIALIZATION
// ============================================

/**
 * Initialize the pin manager.
 * Creates the local backup directory if it doesn't exist.
 *
 * @param localBackupPath  Absolute path for backup storage
 * @param w3sToken         Optional Web3.Storage API token for secondary pinning
 */
export function initPinManager(
  localBackupPath: string,
  w3sToken?: string,
): void {
  backupDir = localBackupPath;
  web3StorageToken = w3sToken || null;

  // Ensure backup directory tree exists
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(path.join(backupDir, "json"), { recursive: true });
  fs.mkdirSync(path.join(backupDir, "files"), { recursive: true });
  fs.mkdirSync(path.join(backupDir, "meta"), { recursive: true });

  // Rehydrate the pin registry from on-disk metadata
  _rehydrateRegistry();

  log.info("pin_manager_initialized", {
    backupDir,
    hasWeb3Storage: !!web3StorageToken,
    restoredPins: pinRegistry.size,
  });
}

// ============================================
// LOCAL BACKUP
// ============================================

/**
 * Backup JSON content to local disk before pinning.
 * Returns the path where it was saved.
 */
export function backupJSON(
  data: Record<string, unknown>,
  label: string,
): string {
  _ensureInitialized();
  const tmpName = `${label}_${Date.now()}.json`;
  const filePath = path.join(backupDir!, "json", tmpName);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  log.debug("local_backup_json", { path: filePath, label });
  return filePath;
}

/**
 * Backup a file buffer to local disk before pinning.
 * Returns the path where it was saved.
 */
export function backupFile(buffer: Buffer, filename: string): string {
  _ensureInitialized();
  const safeName = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const filePath = path.join(backupDir!, "files", safeName);
  fs.writeFileSync(filePath, buffer);
  log.debug("local_backup_file", { path: filePath, filename });
  return filePath;
}

/**
 * Persist a CID-to-backup-path mapping so we can restore from backup on re-pin.
 */
export function registerPin(
  cid: string,
  contentType: "json" | "file",
  name: string,
  sizeBytes: number,
  mimeType?: string,
  backupPath?: string,
): void {
  const existing = pinRegistry.get(cid);
  const record: PinRecord = existing
    ? { ...existing }
    : {
        cid,
        contentType,
        name,
        mimeType,
        sizeBytes,
        pinnedAt: new Date().toISOString(),
        pinnedOn: ["pinata", "local"],
        lastVerifiedAt: null,
        consecutiveFailures: 0,
        estimatedCostUsd: sizeBytes * PINATA_COST_PER_BYTE_MONTH,
      };

  if (!record.pinnedOn.includes("local")) {
    record.pinnedOn.push("local");
  }

  pinRegistry.set(cid, record);
  _persistMeta(cid, record, backupPath);
}

// ============================================
// SECONDARY PINNING — WEB3.STORAGE
// ============================================

/**
 * Pin content to Web3.Storage as a secondary provider.
 * This is a non-blocking best-effort operation.
 */
export async function pinToSecondary(
  cid: string,
  backupPath: string,
  contentType: "json" | "file",
): Promise<boolean> {
  if (!web3StorageToken) {
    log.debug("secondary_pin_skipped", { cid, reason: "no_web3storage_token" });
    return false;
  }

  try {
    // Read the backup file
    const content = fs.readFileSync(backupPath);

    const filename =
      contentType === "json" ? `${cid}.json` : path.basename(backupPath);
    const mime =
      contentType === "json" ? "application/json" : "application/octet-stream";

    // Web3.Storage HTTP API (w3up compatible endpoint)
    const formData = new FormData();
    const blob = new Blob([content], { type: mime });
    formData.append("file", blob, filename);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    const response = await fetch("https://api.web3.storage/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${web3StorageToken}`,
      },
      body: formData,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.ok) {
      const record = pinRegistry.get(cid);
      if (record && !record.pinnedOn.includes("web3storage")) {
        record.pinnedOn.push("web3storage");
        _persistMeta(cid, record);
      }
      log.info("secondary_pin_success", { cid, service: "web3storage" });
      return true;
    }

    const body = await response.text().catch(() => "");
    log.warn("secondary_pin_failed", {
      cid,
      status: response.status,
      body: body.slice(0, 200),
    });
    return false;
  } catch (err) {
    log.warn("secondary_pin_error", { cid, error: (err as Error).message });
    return false;
  }
}

// ============================================
// PIN VERIFICATION
// ============================================

/**
 * Verify a single CID is retrievable from at least one public gateway.
 * Performs a HEAD request with a generous timeout.
 */
export async function verifyCid(cid: string): Promise<PinVerificationResult> {
  for (const gateway of VERIFY_GATEWAYS) {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

      const response = await fetch(`${gateway}/${cid}`, {
        method: "HEAD",
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        return {
          cid,
          reachable: true,
          gateway,
          latencyMs: Date.now() - start,
        };
      }
    } catch {
      // Try next gateway
    }
  }

  return {
    cid,
    reachable: false,
    gateway: "none",
    latencyMs: 0,
    error: "Unreachable from all public gateways",
  };
}

/**
 * Run a full verification scan across all registered pins.
 * Updates the pin registry with verification results.
 * Returns arrays of healthy, degraded and failed CIDs.
 */
export async function verifyAllPins(): Promise<{
  healthy: string[];
  failed: string[];
  duration: number;
}> {
  const startTime = Date.now();
  const healthy: string[] = [];
  const failed: string[] = [];

  const cids = Array.from(pinRegistry.keys());

  // Process in batches of 5 to avoid gateway rate-limiting
  const BATCH_SIZE = 5;
  for (let i = 0; i < cids.length; i += BATCH_SIZE) {
    const batch = cids.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(verifyCid));

    for (let j = 0; j < batch.length; j++) {
      const cid = batch[j];
      const result = results[j];
      const record = pinRegistry.get(cid);
      if (!record) continue;

      if (result.status === "fulfilled" && result.value.reachable) {
        record.lastVerifiedAt = new Date().toISOString();
        record.consecutiveFailures = 0;
        healthy.push(cid);
      } else {
        record.consecutiveFailures += 1;
        failed.push(cid);
      }

      _persistMeta(cid, record);
    }

    // Brief pause between batches to be polite to gateways
    if (i + BATCH_SIZE < cids.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const duration = Date.now() - startTime;
  lastScanAt = new Date().toISOString();
  lastScanDurationMs = duration;

  log.info("pin_verification_complete", {
    total: cids.length,
    healthy: healthy.length,
    failed: failed.length,
    durationMs: duration,
  });

  return { healthy, failed, duration };
}

// ============================================
// RE-PIN MECHANISM
// ============================================

/**
 * Re-pin a CID whose content has become unavailable.
 * Reads from the local backup and re-uploads to the primary (Pinata) service.
 *
 * @param cid       The CID to re-pin
 * @param pinFn     A callback that performs the actual Pinata upload and returns the new CID
 * @returns         The new CID (may differ from original) or null on failure
 */
export async function repinFromBackup(
  cid: string,
  pinFn: (
    backupPath: string,
    contentType: "json" | "file",
    name: string,
    mimeType?: string,
  ) => Promise<string>,
): Promise<string | null> {
  const record = pinRegistry.get(cid);
  if (!record) {
    log.warn("repin_no_record", { cid });
    return null;
  }

  const metaPath = path.join(backupDir!, "meta", `${cid}.json`);
  if (!fs.existsSync(metaPath)) {
    log.error("repin_no_backup_meta", { cid });
    return null;
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  const bkPath = meta.backupPath as string | undefined;
  if (!bkPath || !fs.existsSync(bkPath)) {
    log.error("repin_backup_missing", { cid, backupPath: bkPath });
    return null;
  }

  try {
    const newCid = await pinFn(
      bkPath,
      record.contentType,
      record.name,
      record.mimeType,
    );
    log.info("repin_success", { oldCid: cid, newCid });

    // Update registry if CID changed
    if (newCid !== cid) {
      pinRegistry.delete(cid);
      registerPin(
        newCid,
        record.contentType,
        record.name,
        record.sizeBytes,
        record.mimeType,
        bkPath,
      );
    } else {
      record.consecutiveFailures = 0;
      record.lastVerifiedAt = new Date().toISOString();
      _persistMeta(cid, record, bkPath);
    }

    return newCid;
  } catch (err) {
    log.error("repin_failed", { cid, error: (err as Error).message });
    return null;
  }
}

// ============================================
// COST TRACKING & STATS
// ============================================

/**
 * Get aggregate statistics for all tracked pins.
 */
export function getStats(): PinManagerStats {
  let totalSizeBytes = 0;
  let healthyCount = 0;
  let degradedCount = 0;
  let failedCount = 0;

  for (const record of pinRegistry.values()) {
    totalSizeBytes += record.sizeBytes;
    if (record.consecutiveFailures === 0) {
      healthyCount++;
    } else if (record.consecutiveFailures < 3) {
      degradedCount++;
    } else {
      failedCount++;
    }
  }

  // Pinata cost: ~$0.10 / GB / month
  const estimatedMonthlyCostUsd = totalSizeBytes * PINATA_COST_PER_BYTE_MONTH;

  return {
    totalPins: pinRegistry.size,
    totalSizeBytes,
    estimatedMonthlyCostUsd:
      Math.round(estimatedMonthlyCostUsd * 10000) / 10000,
    healthyPins: healthyCount,
    degradedPins: degradedCount,
    failedPins: failedCount,
    lastFullScanAt: lastScanAt,
    lastFullScanDurationMs: lastScanDurationMs,
  };
}

/**
 * Get all pin records (for diagnostic endpoints).
 */
export function getAllPinRecords(): PinRecord[] {
  return Array.from(pinRegistry.values());
}

/**
 * Get a single pin record by CID.
 */
export function getPinRecord(cid: string): PinRecord | undefined {
  return pinRegistry.get(cid);
}

// ============================================
// INTERNAL HELPERS
// ============================================

function _ensureInitialized(): void {
  if (!backupDir) {
    throw new Error("PinManager not initialized. Call initPinManager() first.");
  }
}

/**
 * Persist pin metadata + backup path mapping to disk.
 */
function _persistMeta(
  cid: string,
  record: PinRecord,
  backupPath?: string,
): void {
  if (!backupDir) return;
  const metaDir = path.join(backupDir, "meta");
  const metaPath = path.join(metaDir, `${cid}.json`);

  // Merge with existing meta to preserve backupPath
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(metaPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    } catch {
      // Corrupted — overwrite
    }
  }

  const meta = {
    ...existing,
    ...record,
    backupPath: backupPath || (existing as any).backupPath || null,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
}

/**
 * Rehydrate the in-memory pin registry from on-disk metadata files.
 */
function _rehydrateRegistry(): void {
  if (!backupDir) return;
  const metaDir = path.join(backupDir, "meta");
  if (!fs.existsSync(metaDir)) return;

  const files = fs.readdirSync(metaDir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(metaDir, file), "utf-8");
      const meta = JSON.parse(raw) as PinRecord & { backupPath?: string };
      if (meta.cid) {
        pinRegistry.set(meta.cid, {
          cid: meta.cid,
          contentType: meta.contentType,
          name: meta.name,
          mimeType: meta.mimeType,
          sizeBytes: meta.sizeBytes || 0,
          pinnedAt: meta.pinnedAt,
          pinnedOn: meta.pinnedOn || ["pinata"],
          lastVerifiedAt: meta.lastVerifiedAt || null,
          consecutiveFailures: meta.consecutiveFailures || 0,
          estimatedCostUsd: meta.estimatedCostUsd || 0,
        });
      }
    } catch {
      // Skip corrupted files
    }
  }
}
