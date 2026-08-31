/**
 * Database Backup and Point-in-Time Recovery Service
 *
 * Provides automated SQLite database backups using SQLite's backup API,
 * backup integrity verification, Point-in-Time Recovery (PITR),
 * continuous replication status reporting (Litestream), and external storage integration.
 *
 * Since #359 the service also supports ENCRYPTED snapshots: the online backup is
 * wrapped in an AES-256-GCM container (see backupCrypto.ts) using the key
 * managed by backupKeyManager.ts, so at-rest and off-site copies never contain
 * plaintext relay data. Encrypted backups are transparently verified (decrypt +
 * PRAGMA integrity_check) and restored (decrypt → PITR restore).
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import { fileURLToPath } from "url";
import { getDb, initDb, closeDb } from "./db.js";
import { log } from "./logger.js";
import { config } from "../config.js";
import {
  probeBackupFile,
  encryptBackupFile,
  decryptBackupFile,
  BackupCryptoError,
} from "./backupCrypto.js";
import {
  ensureBackupEncryptionKey,
  getCandidateBackupKeys,
  getBackupEncryptionState,
} from "./backupKeyManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BACKUP_DIR = path.join(__dirname, "..", "..", "data", "backups");
const LITESTREAM_CONFIG_PATH = path.join(
  __dirname,
  "..",
  "..",
  "litestream.yml",
);

export interface BackupResult {
  success: boolean;
  filePath?: string;
  fileName?: string;
  sizeBytes?: number;
  checksum?: string;
  durationMs?: number;
  uploadedToStorage?: boolean;
  encrypted?: boolean;
  keyId?: string;
  error?: string;
}

export interface RestoreResult {
  success: boolean;
  message: string;
  error?: string;
}

export interface VerificationResult {
  valid: boolean;
  integrityResult?: string;
  encrypted?: boolean;
  keyId?: string;
  error?: string;
}

export interface LitestreamStatus {
  enabled: boolean;
  configured: boolean;
  configPath: string;
  status: "active" | "inactive" | "unconfigured";
}

export interface BackupStatus {
  lastBackupAt: string | null;
  lastBackupStatus: "success" | "failed" | "none";
  lastBackupError: string | null;
  backupCount: number;
  backupDir: string;
  litestream: LitestreamStatus;
  scheduledIntervalMs: number | null;
  lastBackupEncrypted: boolean;
  encryption: {
    enabled: boolean;
    autoInit: boolean;
    currentKeyId: string | null;
    currentSource: string | null;
    keyFile: string | null;
    keyRingDir: string;
    totalKeys: number;
    archivedKeys: number;
    algorithm: string;
    kdf: string;
  };
}

// In-memory state for backup metrics and status
let lastBackupAt: string | null = null;
let lastBackupStatus: "success" | "failed" | "none" = "none";
let lastBackupError: string | null = null;
let lastBackupEncrypted = false;
let backupCount = 0;
let backupTimer: NodeJS.Timeout | null = null;

/**
 * Ensure the backup storage directory exists
 */
export function ensureBackupDir(): string {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  return BACKUP_DIR;
}

/**
 * Whether a given backup file is an encrypted container.
 */
export function isEncryptedBackup(backupFilePath: string): boolean {
  try {
    return probeBackupFile(backupFilePath).encrypted;
  } catch {
    return false;
  }
}

/**
 * Resolve whether a backup should be encrypted, based on the explicit option
 * or the configured default. Returns null when encryption is requested but no
 * key is available (callers should fail loudly rather than write plaintext).
 */
function resolveEncryption(options: { encrypted?: boolean }): {
  encrypted: boolean;
  error?: string;
} {
  const encrypted = options.encrypted ?? config.backupEncryptionEnabled;
  if (!encrypted) return { encrypted: false };

  const key = ensureBackupEncryptionKey();
  if (!key) {
    return {
      encrypted: true,
      error:
        "Encrypted backups requested but no backup encryption key is configured. " +
        "Set BACKUP_ENCRYPTION_KEY (or BACKUP_ENCRYPTION_KEY_FILE) or enable " +
        "BACKUP_ENCRYPTION_AUTO_INIT. Refusing to write a plaintext snapshot.",
    };
  }
  return { encrypted: true };
}

/**
 * Perform an automated backup using better-sqlite3's online backup API.
 *
 * When encryption is enabled the plaintext snapshot is produced transiently
 * and immediately wrapped into an encrypted container; the plaintext file is
 * deleted before the function returns.
 */
export async function createBackup(
  options: {
    destinationDir?: string;
    backupName?: string;
    maxRetentionCount?: number;
    encrypted?: boolean;
  } = {},
): Promise<BackupResult> {
  const startTime = Date.now();
  const targetDir = options.destinationDir || ensureBackupDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = options.backupName || `zkvote-backup-${timestamp}`;

  const { encrypted, error: encryptionError } = resolveEncryption(options);
  if (encrypted && encryptionError) {
    lastBackupStatus = "failed";
    lastBackupError = encryptionError;
    lastBackupEncrypted = true;
    log("error", "db_backup_failed", { error: encryptionError });
    return { success: false, error: encryptionError, encrypted: true };
  }

  let finalName: string;
  if (baseName.endsWith(".enc.db")) {
    finalName = baseName;
  } else if (baseName.endsWith(".db")) {
    finalName = `${baseName.slice(0, -3)}${encrypted ? ".enc.db" : ".db"}`;
  } else {
    finalName = `${baseName}${encrypted ? ".enc.db" : ".db"}`;
  }
  const backupFilePath = path.join(targetDir, finalName);

  // Transient plaintext snapshot: produced by SQLite backup API, then either
  // kept as-is (unencrypted mode) or encrypted + deleted (encrypted mode).
  const plainSnapshotPath = encrypted
    ? path.join(targetDir, `${finalName}.plain`)
    : backupFilePath;

  let keyId: string | undefined;

  try {
    log("info", "db_backup_start", {
      fileName: finalName,
      targetDir,
      encrypted,
    });

    const activeDb = getDb();
    if (!activeDb) {
      throw new Error("Database instance is not initialized");
    }

    // Execute SQLite backup API (online backup consistent snapshot)
    await activeDb.backup(plainSnapshotPath);

    if (encrypted) {
      const key = ensureBackupEncryptionKey();
      if (!key) {
        throw new Error("Backup encryption key disappeared during backup");
      }
      keyId = key.keyId;
      await encryptBackupFile(plainSnapshotPath, backupFilePath, key.key);
      // The plaintext snapshot must never be left behind.
      fs.unlinkSync(plainSnapshotPath);
    }

    // Calculate file size and sha256 checksum of the on-disk artifact
    const stats = fs.statSync(backupFilePath);
    const fileBuffer = fs.readFileSync(backupFilePath);
    const checksum = crypto
      .createHash("sha256")
      .update(fileBuffer)
      .digest("hex");

    // Perform immediate backup verification (decrypts when encrypted)
    const verification = await verifyBackup(backupFilePath);
    if (!verification.valid) {
      // Remove corrupt backup file if integrity check fails
      if (fs.existsSync(backupFilePath)) {
        fs.unlinkSync(backupFilePath);
      }
      if (encrypted && fs.existsSync(plainSnapshotPath)) {
        fs.unlinkSync(plainSnapshotPath);
      }
      throw new Error(
        `Backup integrity check failed: ${verification.error || verification.integrityResult}`,
      );
    }

    // Attempt upload to external storage if S3 / cloud storage configured
    let uploadedToStorage = false;
    if (
      config.s3Bucket ||
      process.env.BACKUP_S3_BUCKET ||
      process.env.OBJECT_STORAGE_URL
    ) {
      uploadedToStorage = await uploadToExternalStorage(
        backupFilePath,
        finalName,
      );
    }

    // Apply retention policy (clean up old backups beyond max count)
    const maxRetention = options.maxRetentionCount || 10;
    pruneOldBackups(targetDir, maxRetention);

    const durationMs = Date.now() - startTime;
    lastBackupAt = new Date().toISOString();
    lastBackupStatus = "success";
    lastBackupError = null;
    lastBackupEncrypted = encrypted;
    backupCount++;

    log("info", "db_backup_complete", {
      fileName: finalName,
      sizeBytes: stats.size,
      checksum,
      durationMs,
      uploadedToStorage,
      encrypted,
      keyId,
    });

    return {
      success: true,
      filePath: backupFilePath,
      fileName: finalName,
      sizeBytes: stats.size,
      checksum,
      durationMs,
      uploadedToStorage,
      encrypted,
      keyId,
    };
  } catch (err) {
    const errorMsg = (err as Error).message;
    lastBackupStatus = "failed";
    lastBackupError = errorMsg;
    lastBackupEncrypted = encrypted;
    log("error", "db_backup_failed", { error: errorMsg, encrypted });

    // Clean up any transient plaintext snapshot on failure.
    try {
      if (encrypted && fs.existsSync(plainSnapshotPath)) {
        fs.unlinkSync(plainSnapshotPath);
      }
    } catch {
      /* best-effort cleanup */
    }

    return {
      success: false,
      error: errorMsg,
      durationMs: Date.now() - startTime,
      encrypted,
    };
  }
}

/**
 * Decrypt an encrypted backup into a temporary plaintext file. Returns the
 * temp path plus a cleanup function. Used by verification and restore paths.
 */
interface TempDecryptResult {
  tempDbPath: string;
  keyId: string;
  cleanup: () => void;
}

async function decryptBackupToTemp(
  backupFilePath: string,
): Promise<TempDecryptResult> {
  const info = probeBackupFile(backupFilePath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zkvote-backup-"));
  const tempDbPath = path.join(tempDir, "restore.db");

  const candidates = getCandidateBackupKeys();
  const matching = info.keyId
    ? candidates.filter((k) => k.keyId === info.keyId)
    : candidates;

  if (matching.length === 0) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new BackupCryptoError(
      "WRONG_KEY",
      `No backup encryption key available for snapshot key ${info.keyId ?? "unknown"} ` +
        "(check BACKUP_ENCRYPTION_KEY_FILE / key ring)",
    );
  }

  try {
    // Prefer the key whose id matches; fall back to trying all candidates for
    // resilience against key file reordering.
    const ordered = [...matching, ...candidates];
    let lastError: unknown = null;
    for (const candidate of ordered) {
      try {
        await decryptBackupFile(
          backupFilePath,
          tempDbPath,
          candidate.key,
          info.keyId,
        );
        return {
          tempDbPath,
          keyId: candidate.keyId,
          cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
        };
      } catch (err) {
        lastError = err;
        if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
      }
    }
    throw lastError;
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (err instanceof BackupCryptoError) throw err;
    throw new BackupCryptoError(
      "WRONG_KEY",
      `Failed to decrypt backup: ${(err as Error).message}`,
    );
  }
}

/**
 * Verify integrity of a backup file. Encrypted backups are decrypted to a
 * temporary file first and validated with PRAGMA integrity_check; the temp
 * plaintext is removed before returning.
 */
export async function verifyBackup(
  backupFilePath: string,
): Promise<VerificationResult> {
  if (!fs.existsSync(backupFilePath)) {
    return {
      valid: false,
      error: `Backup file does not exist: ${backupFilePath}`,
    };
  }

  let info;
  try {
    info = probeBackupFile(backupFilePath);
  } catch (err) {
    return { valid: false, error: (err as Error).message };
  }

  if (info.encrypted) {
    let temp: TempDecryptResult | null = null;
    try {
      temp = await decryptBackupToTemp(backupFilePath);
      const result = await checkIntegrity(temp.tempDbPath);
      return {
        valid: result.valid,
        integrityResult: result.integrityResult,
        encrypted: true,
        keyId: info.keyId,
        error: result.error,
      };
    } catch (err) {
      return {
        valid: false,
        encrypted: true,
        keyId: info.keyId,
        error: (err as Error).message,
      };
    } finally {
      if (temp) temp.cleanup();
    }
  }

  const result = await checkIntegrity(backupFilePath);
  return {
    valid: result.valid,
    integrityResult: result.integrityResult,
    encrypted: false,
    error: result.error,
  };
}

/**
 * Run PRAGMA integrity_check against a (plaintext) SQLite file.
 */
async function checkIntegrity(
  dbFilePath: string,
): Promise<{ valid: boolean; integrityResult?: string; error?: string }> {
  let tempDb: DatabaseType | null = null;
  try {
    tempDb = new Database(dbFilePath, { readonly: true });
    const row = tempDb.prepare("PRAGMA integrity_check").get() as
      | { integrity_check?: string }
      | undefined;
    const result = row ? Object.values(row)[0] : "failed";

    if (result === "ok") {
      return { valid: true, integrityResult: "ok" };
    } else {
      return {
        valid: false,
        integrityResult: String(result),
        error: `Integrity check failed: ${result}`,
      };
    }
  } catch (err) {
    return { valid: false, error: (err as Error).message };
  } finally {
    if (tempDb) {
      try {
        tempDb.close();
      } catch (_) {
        // best-effort close; nothing to recover
      }
    }
  }
}

/**
 * Restore database from a backup file (Point-in-Time Recovery).
 * Encrypted backups are decrypted to a temporary plaintext snapshot, verified,
 * and then restored; the temporary file is deleted afterwards.
 */
export async function restoreFromBackup(
  backupFilePath: string,
  targetDbPath?: string,
): Promise<RestoreResult> {
  let temp: TempDecryptResult | null = null;
  try {
    log("info", "db_restore_start", { backupFilePath, targetDbPath });

    let sourcePath = backupFilePath;
    let encrypted = false;

    // Step 1: detect encryption and decrypt to a temp snapshot if needed
    try {
      const info = probeBackupFile(backupFilePath);
      encrypted = info.encrypted;
      if (encrypted) {
        temp = await decryptBackupToTemp(backupFilePath);
        sourcePath = temp.tempDbPath;
      }
    } catch (err) {
      return {
        success: false,
        message: "Restore aborted: unable to decrypt backup",
        error: (err as Error).message,
      };
    }

    // Step 2: Verify backup integrity before restore
    const verification = await checkIntegrity(sourcePath);
    if (!verification.valid) {
      return {
        success: false,
        message: "Restore aborted due to invalid backup file integrity",
        error: verification.error || verification.integrityResult,
      };
    }

    const defaultDbPath = path.join(__dirname, "..", "..", "data", "zkvote.db");
    const destinationPath = targetDbPath || defaultDbPath;

    // Step 3: Close current database connections if open
    try {
      closeDb();
    } catch (err) {
      log("warn", "db_close_before_restore_warn", {
        error: (err as Error).message,
      });
    }

    // Remove old DB file and any WAL / SHM files
    if (fs.existsSync(destinationPath)) {
      fs.unlinkSync(destinationPath);
    }
    const walFile = `${destinationPath}-wal`;
    const shmFile = `${destinationPath}-shm`;
    if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
    if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);

    // Step 4: Copy backup file to destination path
    fs.copyFileSync(sourcePath, destinationPath);

    // Step 5: Re-initialize and verify the restored database
    const restoredDb = initDb(destinationPath);
    const restoredVerification = restoredDb.prepare("PRAGMA quick_check").get();

    log("info", "db_restore_complete", {
      destinationPath,
      encrypted,
      result: restoredVerification,
    });

    return {
      success: true,
      message: `Database successfully restored from ${path.basename(backupFilePath)}${encrypted ? " (decrypted)" : ""}`,
    };
  } catch (err) {
    const errorMsg = (err as Error).message;
    log("error", "db_restore_failed", { error: errorMsg });
    return {
      success: false,
      message: "Database restore failed",
      error: errorMsg,
    };
  } finally {
    if (temp) temp.cleanup();
  }
}

/**
 * Dry-run restore verification: restores the backup to a throwaway database and
 * reports whether integrity + content survive the round-trip. No production DB
 * is touched. Used by the backup CLI and disaster-recovery drills.
 */
export async function verifyRestore(
  backupFilePath: string,
): Promise<RestoreResult> {
  let temp: TempDecryptResult | null = null;
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "zkvote-restore-test-"),
  );
  const targetPath = path.join(tempDir, "restored.db");

  try {
    log("info", "db_restore_drill_start", { backupFilePath });

    let sourcePath = backupFilePath;
    let encrypted = false;
    try {
      const info = probeBackupFile(backupFilePath);
      encrypted = info.encrypted;
      if (encrypted) {
        temp = await decryptBackupToTemp(backupFilePath);
        sourcePath = temp.tempDbPath;
      }
    } catch (err) {
      return {
        success: false,
        message: "Restore drill aborted: unable to decrypt backup",
        error: (err as Error).message,
      };
    }

    // Simulate the restore steps against a throwaway file.
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    fs.copyFileSync(sourcePath, targetPath);

    const check = await checkIntegrity(targetPath);
    if (!check.valid) {
      return {
        success: false,
        message: "Restore drill failed integrity check",
        error: check.error || check.integrityResult,
      };
    }

    // Verify the restored file is a readable SQLite DB with expected schema.
    let tableCount = 0;
    try {
      const db = new Database(targetPath, { readonly: true });
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      tableCount = tables.length;
      db.close();
    } catch (err) {
      return {
        success: false,
        message: "Restore drill failed: restored file is not a valid database",
        error: (err as Error).message,
      };
    }

    log("info", "db_restore_drill_complete", {
      backupFilePath,
      encrypted,
      integrity: "ok",
      tableCount,
    });

    return {
      success: true,
      message: `Restore drill passed: integrity ok, ${tableCount} tables, ${encrypted ? "decrypted" : "plaintext"}`,
    };
  } catch (err) {
    return {
      success: false,
      message: "Restore drill failed",
      error: (err as Error).message,
    };
  } finally {
    if (temp) temp.cleanup();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Mockable external storage upload handler (S3/GCS)
 */
async function uploadToExternalStorage(
  filePath: string,
  fileName: string,
): Promise<boolean> {
  try {
    const bucket =
      config.s3Bucket || process.env.BACKUP_S3_BUCKET || "zkvote-backups";
    log("info", "db_backup_external_upload_simulated", {
      bucket,
      fileName,
      encrypted: isEncryptedBackup(filePath),
      size: fs.statSync(filePath).size,
    });
    return true;
  } catch (err) {
    log("warn", "db_backup_external_upload_failed", {
      error: (err as Error).message,
    });
    return false;
  }
}

/**
 * Prune old local backup files beyond retention count.
 * Handles both plaintext (`*.db`) and encrypted (`*.enc.db`) artifacts.
 */
export function pruneOldBackups(dirPath: string, maxCount: number): void {
  try {
    if (!fs.existsSync(dirPath)) return;
    const files = fs
      .readdirSync(dirPath)
      .filter(
        (f) =>
          f.startsWith("zkvote-backup-") &&
          (f.endsWith(".db") || f.endsWith(".enc.db")),
      )
      .map((f) => {
        const fullPath = path.join(dirPath, f);
        return {
          name: f,
          path: fullPath,
          mtime: fs.statSync(fullPath).mtimeMs,
        };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first

    if (files.length > maxCount) {
      const toDelete = files.slice(maxCount);
      for (const item of toDelete) {
        fs.unlinkSync(item.path);
        log("info", "db_backup_pruned_old", { fileName: item.name });
      }
    }
  } catch (err) {
    log("warn", "db_backup_prune_error", { error: (err as Error).message });
  }
}

/**
 * Check Litestream continuous replication status
 */
export function getLitestreamStatus(): LitestreamStatus {
  const configured = fs.existsSync(LITESTREAM_CONFIG_PATH);
  const enabled =
    configured &&
    (process.env.LITESTREAM_ENABLED === "true" ||
      process.env.NODE_ENV === "production");

  return {
    enabled,
    configured,
    configPath: LITESTREAM_CONFIG_PATH,
    status: enabled ? "active" : configured ? "inactive" : "unconfigured",
  };
}

/**
 * Return current backup health status and statistics
 */
export function getBackupStatus(): BackupStatus {
  return {
    lastBackupAt,
    lastBackupStatus,
    lastBackupError,
    backupCount,
    backupDir: BACKUP_DIR,
    litestream: getLitestreamStatus(),
    scheduledIntervalMs: backupTimer
      ? config.backupIntervalMs || 86400000
      : null,
    lastBackupEncrypted,
    encryption: getBackupEncryptionState(),
  };
}

/**
 * Start automated scheduled database backups
 */
export function startScheduledBackups(
  intervalMs: number = config.backupIntervalMs || 86400000,
): void {
  if (backupTimer) {
    clearInterval(backupTimer);
  }

  // Trigger initial backup asynchronously
  createBackup().catch((err) => {
    log("error", "initial_scheduled_backup_failed", {
      error: (err as Error).message,
    });
  });

  backupTimer = setInterval(() => {
    createBackup().catch((err) => {
      log("error", "periodic_scheduled_backup_failed", {
        error: (err as Error).message,
      });
    });
  }, intervalMs);

  log("info", "scheduled_backups_started", {
    intervalMs,
    encrypted: config.backupEncryptionEnabled,
  });
}

/**
 * Stop scheduled database backups
 */
export function stopScheduledBackups(): void {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
    log("info", "scheduled_backups_stopped");
  }
}
