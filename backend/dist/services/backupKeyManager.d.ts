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
export declare const BACKUP_KEY_ALGORITHM = "aes-256-gcm";
export declare const BACKUP_KEY_KDF = "scrypt";
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
export declare class BackupKeyError extends Error {
    constructor(message: string);
}
export declare function defaultKeyDir(): string;
export declare function defaultKeyFile(): string;
export declare function currentKeyFilePath(): string;
export declare function keyRingDir(): string;
/**
 * Parse a key file: one base64/UTF-8 key per line, `#` starts a comment,
 * blank lines ignored. The first entry is the current key.
 */
export declare function parseKeyFile(content: string): string[];
/** The current key from env or the current key file (or null). */
export declare function getCurrentBackupKey(): BackupKeyEntry | null;
/** All keys usable for decryption: current + archived ring keys (deduped). */
export declare function getCandidateBackupKeys(): BackupKeyEntry[];
/**
 * Ensure a current key exists. When BACKUP_ENCRYPTION_AUTO_INIT is enabled and
 * no key is configured, generates one and persists it to the current key file
 * (logging clearly that this is not suitable for multi-replica deployments).
 */
export declare function ensureBackupEncryptionKey(): BackupKeyEntry | null;
export declare function getBackupEncryptionState(): BackupKeyState;
export declare function logKeyEvent(level: "info" | "warn" | "error", event: string, meta: Record<string, unknown>): void;
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
export declare function rotateBackupEncryptionKey(options?: {
    outputFile?: string;
}): BackupKeyRotationResult;
//# sourceMappingURL=backupKeyManager.d.ts.map