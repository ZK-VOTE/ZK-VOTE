/**
 * Backup Encryption Key Management (Issue #359)
 *
 * Resolves the key(s) used to encrypt/decrypt relay DB snapshots:
 *
 *   - The CURRENT key (used for new backups) comes from, in priority order:
 *       1. the BACKUP_ENCRYPTION_KEY environment variable, or
 *       2. the first key in the BACKUP_ENCRYPTION_KEY_FILE (one base64 key per
 *          line; `#` starts a comment).
 *   - ARCHIVED keys (previous rotations) are kept in the key ring directory
 *     (BACKUP_KEY_RING_DIR) as `<keyId>.key` files and are only used for
 *     decryption / restore of older snapshots.
 *
 * Rotation model:
 *   - Each snapshot is encrypted with a fresh random DEK wrapped under the
 *     current KEK (see backupCrypto.ts), so rotating the KEK does not require
 *     re-encrypting existing backups.
 *   - On rotation the outgoing key is archived to the key ring, the new key is
 *     written to the current key file, and the change is recorded in the
 *     backup_keys table (when a DB is already open) plus the structured log.
 *
 * The passphrase is never embedded in a backup artifact. Losing it (and not
 * having archived it) makes those backups unrecoverable by design.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { log } from "./logger.js";
import { isDbInitialized, getDb } from "./db.js";
import { deriveKeyId, generateBackupKey } from "./backupCrypto.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const BACKUP_KEY_ALGORITHM = "aes-256-gcm";
export const BACKUP_KEY_KDF = "scrypt";

export interface BackupKeyEntry {
  keyId: string;
  key: string;
  source: string;
  current: boolean;
}

export interface BackupKeyState {
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
}

export interface BackupKeyRotationResult {
  oldKeyId: string;
  oldKeyArchivedPath: string;
  newKeyId: string;
  newKey: string;
  currentKeyFile: string;
}

export class BackupKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupKeyError";
  }
}

export function defaultKeyDir(): string {
  return path.join(__dirname, "..", "..", "data", "backup-keys");
}

export function defaultKeyFile(): string {
  return path.join(defaultKeyDir(), "current.key");
}

export function currentKeyFilePath(): string {
  return config.backupEncryptionKeyFile || defaultKeyFile();
}

export function keyRingDir(): string {
  return config.backupKeyRingDir || defaultKeyDir();
}

// ============================================
// KEY FILE I/O
// ============================================

/**
 * Parse a key file: one base64/UTF-8 key per line, `#` starts a comment,
 * blank lines ignored. The first entry is the current key.
 */
export function parseKeyFile(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function readKeyLines(filePath: string): string[] {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  return parseKeyFile(content);
}

function ensureSecureKeyFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { encoding: "utf-8" });
  // Keys are secrets: restrict to owner read/write after write.
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best-effort; some filesystems lack chmod */
  }
}

// ============================================
// KEY RESOLUTION
// ============================================

/** The current key from env or the current key file (or null). */
export function getCurrentBackupKey(): BackupKeyEntry | null {
  const envKey = config.backupEncryptionKey;
  if (envKey) {
    return {
      keyId: deriveKeyId(envKey),
      key: envKey,
      source: "env",
      current: true,
    };
  }

  const fileKeys = readKeyLines(currentKeyFilePath());
  if (fileKeys.length > 0) {
    return {
      keyId: deriveKeyId(fileKeys[0]),
      key: fileKeys[0],
      source: currentKeyFilePath(),
      current: true,
    };
  }

  return null;
}

/** All keys usable for decryption: current + archived ring keys (deduped). */
export function getCandidateBackupKeys(): BackupKeyEntry[] {
  const candidates = new Map<string, BackupKeyEntry>();

  const current = getCurrentBackupKey();
  if (current) candidates.set(current.keyId, current);

  // Additional lines in the current key file (e.g. keys stacked before a
  // redeploy) are also valid decryption candidates.
  const fileKeys = readKeyLines(currentKeyFilePath());
  for (const key of fileKeys) {
    const keyId = deriveKeyId(key);
    if (!candidates.has(keyId)) {
      candidates.set(keyId, {
        keyId,
        key,
        source: currentKeyFilePath(),
        current: false,
      });
    }
  }

  const ringDir = keyRingDir();
  if (fs.existsSync(ringDir)) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(ringDir, { withFileTypes: true });
    } catch {
      /* unreadable ring dir is not fatal for resolution */
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".key")) continue;
      const keys = readKeyLines(path.join(ringDir, entry.name));
      for (const key of keys) {
        const keyId = deriveKeyId(key);
        if (!candidates.has(keyId)) {
          candidates.set(keyId, {
            keyId,
            key,
            source: path.join(ringDir, entry.name),
            current: false,
          });
        }
      }
    }
  }

  return Array.from(candidates.values());
}

/**
 * Ensure a current key exists. When BACKUP_ENCRYPTION_AUTO_INIT is enabled and
 * no key is configured, generates one and persists it to the current key file
 * (logging clearly that this is not suitable for multi-replica deployments).
 */
export function ensureBackupEncryptionKey(): BackupKeyEntry | null {
  const existing = getCurrentBackupKey();
  if (existing) return existing;

  if (!config.backupEncryptionAutoInit) return null;

  const newKey = generateBackupKey();
  const keyFile = currentKeyFilePath();
  ensureSecureKeyFile(
    keyFile,
    `# ZKVOTE backup encryption key (v1)\n${newKey}\n`,
  );
  const entry = {
    keyId: deriveKeyId(newKey),
    key: newKey,
    source: keyFile,
    current: true,
  };
  log("warn", "backup_encryption_key_autogenerated", {
    keyId: entry.keyId,
    keyFile,
    reason:
      "BACKUP_ENCRYPTION_AUTO_INIT=true and no key configured. Copy this key into " +
      "BACKUP_ENCRYPTION_KEY / secrets before relying on backups for DR.",
  });
  return entry;
}

// ============================================
// STATE / AUDIT
// ============================================

export function getBackupEncryptionState(): BackupKeyState {
  const current = getCurrentBackupKey();
  const candidates = getCandidateBackupKeys();
  const ringDir = keyRingDir();
  const currentFileName = path.basename(currentKeyFilePath());
  let archivedKeys = 0;
  if (fs.existsSync(ringDir)) {
    try {
      archivedKeys = fs
        .readdirSync(ringDir, { withFileTypes: true })
        .filter(
          (e) =>
            e.isFile() && e.name.endsWith(".key") && e.name !== currentFileName,
        ).length;
    } catch {
      /* ignore */
    }
  }

  return {
    enabled: config.backupEncryptionEnabled,
    autoInit: config.backupEncryptionAutoInit,
    currentKeyId: current?.keyId ?? null,
    currentSource: current?.source ?? null,
    keyFile: fs.existsSync(currentKeyFilePath()) ? currentKeyFilePath() : null,
    keyRingDir: ringDir,
    totalKeys: candidates.length,
    archivedKeys,
    algorithm: BACKUP_KEY_ALGORITHM,
    kdf: BACKUP_KEY_KDF,
  };
}

// ============================================
// AUDIT / PERSISTENCE
// ============================================

/**
 * Record a key lifecycle event in the backup_keys table. Best-effort: only
 * writes when a database is already open and the migration is applied, and
 * never triggers a DB bootstrap on its own.
 */
function recordKeyEvent(params: {
  keyId: string;
  action: "created" | "rotated-in" | "archived" | "imported";
  source: string;
  rotatedFrom?: string;
}): void {
  const action = params.action;
  const source = params.source;
  const keyId = params.keyId;
  const rotatedFrom = params.rotatedFrom;

  try {
    if (!isDbInitialized()) return;

    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO backup_keys
         (key_id, created_at, source, current, rotated_from, event_type)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      keyId,
      new Date().toISOString(),
      source,
      "current",
      rotatedFrom ?? null,
      action,
    );
  } catch {
    // The table may not exist yet (migration pending) — metadata is optional.
  }
}

export function logKeyEvent(
  level: "info" | "warn" | "error",
  event: string,
  meta: Record<string, unknown>,
): void {
  log(level, event, meta);
}

// ============================================
// ROTATION
// ============================================

/**
 * Rotate the backup encryption key:
 *   - archives the current key into the key ring so old backups stay decryptable,
 *   - generates a new current key and writes it to `options.outputFile` or the
 *     configured current key file,
 *   - records the rotation for audit.
 *
 * When the current key comes from the BACKUP_ENCRYPTION_KEY env var, the new
 * key cannot be persisted in place; pass `outputFile` (or set
 * BACKUP_ENCRYPTION_KEY_FILE) so the new key is written to disk.
 */
export function rotateBackupEncryptionKey(
  options: {
    outputFile?: string;
  } = {},
): BackupKeyRotationResult {
  const current = getCurrentBackupKey();
  if (!current) {
    throw new BackupKeyError(
      "No backup encryption key is configured. Generate one first " +
        "(backup-key-manager.ts generate) or set BACKUP_ENCRYPTION_KEY.",
    );
  }
  if (current.source === "env") {
    log("warn", "backup_key_rotation_requires_output_file", {
      reason:
        "Current key comes from BACKUP_ENCRYPTION_KEY (env). The new key is " +
        "written to the requested output file; deploy it into the env/secrets.",
    });
  }

  const ringDir = keyRingDir();
  fs.mkdirSync(ringDir, { recursive: true });
  const archivedPath = path.join(ringDir, `${current.keyId}.key`);
  if (!fs.existsSync(archivedPath)) {
    ensureSecureKeyFile(
      archivedPath,
      `# ZKVOTE archived backup encryption key (${current.keyId})\n${current.key}\n`,
    );
  }
  recordKeyEvent({
    keyId: current.keyId,
    action: "archived",
    source: current.source,
    rotatedFrom: undefined,
  });

  const newKey = generateBackupKey();
  const newKeyId = deriveKeyId(newKey);
  const outputFile = options.outputFile || currentKeyFilePath();
  ensureSecureKeyFile(
    outputFile,
    `# ZKVOTE backup encryption key (v1)\n${newKey}\n`,
  );
  recordKeyEvent({
    keyId: newKeyId,
    action: "rotated-in",
    source: outputFile,
    rotatedFrom: current.keyId,
  });

  log("info", "backup_encryption_key_rotated", {
    oldKeyId: current.keyId,
    newKeyId,
    archivedPath,
    keyFile: outputFile,
  });

  return {
    oldKeyId: current.keyId,
    oldKeyArchivedPath: archivedPath,
    newKeyId,
    newKey,
    currentKeyFile: outputFile,
  };
}
