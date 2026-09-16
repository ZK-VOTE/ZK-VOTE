/**
 * Encrypted Backup Container (Issue #359)
 *
 * Encrypts SQLite relay DB snapshots before they are written to disk or pushed
 * to object storage, so disaster-recovery copies never leak plaintext data
 * (complements the layered relay security model described in THREAT_MODEL.md).
 *
 * Container format (magic "ZKVE", version 1):
 *
 *   offset   size  field
 *   0        4     magic "ZKVE"
 *   4        1     format version (1)
 *   5        2     reserved (0x0000)
 *   7        4     header length (uint32 BE)
 *   11       h     header JSON (see EncryptedBackupHeader)
 *   11+h     n     AES-256-GCM ciphertext (streamed)
 *   ...           16-byte GCM authentication tag appended by the cipher stream
 *
 * Envelope encryption:
 *   - Each backup gets a fresh random 256-bit Data Encryption Key (DEK).
 *   - The DEK is wrapped (AES-256-GCM) under a Key Encryption Key (KEK) derived
 *     from an operator-provided passphrase via scrypt (a memory-hard KDF).
 *   - The header records a stable keyId (fingerprint of the passphrase), the KDF
 *     salt, the DEK wrapping parameters, and the payload IV. The passphrase is
 *     never stored anywhere in the backup artifact.
 *
 * Rotation:
 *   - Because every backup carries its own wrapped DEK, rotating the KEK just
 *     changes which key will be used for future snapshots. Snapshots taken under
 *     an older key remain decryptable while the old key is retained in the key
 *     ring (see backupKeyManager.ts).
 */
export declare const BACKUP_MAGIC = "ZKVE";
export declare const BACKUP_FORMAT_VERSION = 1;
export declare const PAYLOAD_ALGO = "aes-256-gcm";
export declare const SCRYPT_N = 16384;
export declare const SCRYPT_R = 8;
export declare const SCRYPT_P = 1;
export interface EncryptedBackupHeader {
    v: number;
    keyId: string;
    kdf: {
        algo: "scrypt";
        N: number;
        r: number;
        p: number;
        dkLen: number;
        saltB64: string;
    };
    dek: {
        algo: string;
        ivB64: string;
        tagB64: string;
        keyB64: string;
    };
    payload: {
        algo: string;
        ivB64: string;
        size: number;
    };
}
export interface BackupFileInfo {
    encrypted: boolean;
    keyId?: string;
    version?: number;
    algorithm?: string;
    payloadSize?: number;
}
export type BackupCryptoErrorCode = "INVALID_MAGIC" | "UNSUPPORTED_VERSION" | "MALFORMED_HEADER" | "WRONG_KEY" | "CORRUPT_PAYLOAD" | "NOT_ENCRYPTED" | "IO_ERROR";
export declare class BackupCryptoError extends Error {
    readonly code: BackupCryptoErrorCode;
    constructor(code: BackupCryptoErrorCode, message: string);
}
/**
 * Generate a fresh backup encryption key (32 random bytes, base64-encoded).
 */
export declare function generateBackupKey(): string;
/**
 * Derive a stable, non-secret identifier for a key from its fingerprint.
 * Used to label which key produced a backup, never to authenticate.
 */
export declare function deriveKeyId(key: string): string;
export declare function readHeader(filePath: string): EncryptedBackupHeader;
/**
 * Detect whether a backup file is an encrypted container and, if so, return
 * metadata about it (keyId, algorithm, version). Plain SQLite files are
 * reported as unencrypted.
 */
export declare function probeBackupFile(filePath: string): BackupFileInfo;
/**
 * Encrypt a plaintext file into an encrypted backup container.
 *
 * @param inputPath  Plaintext file to encrypt (e.g. a SQLite snapshot).
 * @param outputPath Where to write the encrypted container.
 * @param key        Operator passphrase / KEK (see generateBackupKey()).
 */
export declare function encryptBackupFile(inputPath: string, outputPath: string, key: string): Promise<void>;
/**
 * Decrypt an encrypted backup container back into a plaintext file.
 *
 * @param inputPath  Encrypted container to decrypt.
 * @param outputPath Where to write the decrypted plaintext (SQLite file).
 * @param key        The KEK used to wrap the DEK.
 * @param keyId      Optional; when provided it verifies the key matches what the
 *                   header expects before attempting decryption (fast fail).
 */
export declare function decryptBackupFile(inputPath: string, outputPath: string, key: string, keyId?: string): Promise<void>;
/**
 * Best-effort structured log for crypto events; keeps a single audit trail.
 */
export declare function logBackupCryptoEvent(level: "info" | "warn" | "error", event: string, meta?: {
    keyId?: string;
    fileName?: string;
    error?: string;
}): void;
//# sourceMappingURL=backupCrypto.d.ts.map