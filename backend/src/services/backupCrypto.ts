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

import crypto from "crypto";
import fs from "fs";
import { pipeline } from "stream/promises";
import { log } from "./logger.js";

export const BACKUP_MAGIC = "ZKVE";
export const BACKUP_FORMAT_VERSION = 1;

const DEK_LENGTH = 32; // 256-bit data encryption key
const IV_LENGTH = 16; // AES-GCM IV (96-bit recommended, 12 bytes)
const TAG_LENGTH = 16;
export const PAYLOAD_ALGO = "aes-256-gcm";

// scrypt parameters for KEK derivation (memory-hard, GPU-resistant)
export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SALT_LENGTH = 16;

// Fixed preamble: magic(4) + version(1) + reserved(2) + headerLen(4) = 11 bytes
const PREAMBLE_LENGTH = 11;

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
    keyB64: string; // the wrapped DEK (AES-256-GCM ciphertext)
  };
  payload: {
    algo: string;
    ivB64: string;
    size: number; // ciphertext length in bytes (excludes the auth tag)
  };
}

export interface BackupFileInfo {
  encrypted: boolean;
  // populated only when encrypted
  keyId?: string;
  version?: number;
  algorithm?: string;
  payloadSize?: number;
}

export type BackupCryptoErrorCode =
  | "INVALID_MAGIC"
  | "UNSUPPORTED_VERSION"
  | "MALFORMED_HEADER"
  | "WRONG_KEY"
  | "CORRUPT_PAYLOAD"
  | "NOT_ENCRYPTED"
  | "IO_ERROR";

export class BackupCryptoError extends Error {
  constructor(
    public readonly code: BackupCryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BackupCryptoError";
  }
}

// ============================================
// KEY UTILITIES
// ============================================

/**
 * Generate a fresh backup encryption key (32 random bytes, base64-encoded).
 */
export function generateBackupKey(): string {
  return crypto.randomBytes(DEK_LENGTH).toString("base64");
}

/**
 * Derive a stable, non-secret identifier for a key from its fingerprint.
 * Used to label which key produced a backup, never to authenticate.
 */
export function deriveKeyId(key: string): string {
  return crypto
    .createHash("sha256")
    .update(key, "utf-8")
    .digest("hex")
    .slice(0, 16);
}

function deriveKek(key: string, salt: Buffer): Buffer {
  return crypto.scryptSync(key, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

// ============================================
// HEADER SERIALIZATION
// ============================================

function encodeHeader(header: EncryptedBackupHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf-8");
  const preamble = Buffer.alloc(PREAMBLE_LENGTH);
  preamble.write(BACKUP_MAGIC, 0, "ascii");
  preamble.writeUInt8(BACKUP_FORMAT_VERSION, 4);
  preamble.writeUInt32BE(json.length, 7);
  return Buffer.concat([preamble, json]);
}

export function readHeader(filePath: string): EncryptedBackupHeader {
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, "r");
  } catch (err) {
    throw new BackupCryptoError(
      "IO_ERROR",
      `Unable to open backup for reading: ${(err as Error).message}`,
    );
  }

  try {
    const preamble = Buffer.alloc(PREAMBLE_LENGTH);
    const read = fs.readSync(descriptor, preamble, 0, PREAMBLE_LENGTH, 0);
    if (read < PREAMBLE_LENGTH) {
      throw new BackupCryptoError(
        "MALFORMED_HEADER",
        "Backup is shorter than the container preamble",
      );
    }

    const magic = preamble.toString("ascii", 0, 4);
    if (magic !== BACKUP_MAGIC) {
      throw new BackupCryptoError(
        "INVALID_MAGIC",
        `Not an encrypted ZK-VOTE backup (magic "${magic}")`,
      );
    }

    const version = preamble.readUInt8(4);
    if (version !== BACKUP_FORMAT_VERSION) {
      throw new BackupCryptoError(
        "UNSUPPORTED_VERSION",
        `Unsupported encrypted backup version ${version}`,
      );
    }

    const headerLength = preamble.readUInt32BE(7);
    if (headerLength <= 0 || headerLength > 1024 * 1024) {
      throw new BackupCryptoError(
        "MALFORMED_HEADER",
        `Invalid header length ${headerLength}`,
      );
    }

    const headerBuf = Buffer.alloc(headerLength);
    const headerRead = fs.readSync(
      descriptor,
      headerBuf,
      0,
      headerLength,
      PREAMBLE_LENGTH,
    );
    if (headerRead < headerLength) {
      throw new BackupCryptoError(
        "MALFORMED_HEADER",
        "Truncated backup header",
      );
    }

    let header: EncryptedBackupHeader;
    try {
      header = JSON.parse(headerBuf.toString("utf-8")) as EncryptedBackupHeader;
    } catch (err) {
      throw new BackupCryptoError(
        "MALFORMED_HEADER",
        `Backup header is not valid JSON: ${(err as Error).message}`,
      );
    }

    if (
      !header.keyId ||
      !header.kdf?.saltB64 ||
      !header.dek?.ivB64 ||
      !header.dek?.tagB64 ||
      !header.dek?.keyB64 ||
      !header.payload?.ivB64 ||
      typeof header.payload?.size !== "number"
    ) {
      throw new BackupCryptoError(
        "MALFORMED_HEADER",
        "Backup header is missing required fields",
      );
    }

    return header;
  } finally {
    fs.closeSync(descriptor);
  }
}

// ============================================
// PREAMBLE / PROBE
// ============================================

/**
 * Detect whether a backup file is an encrypted container and, if so, return
 * metadata about it (keyId, algorithm, version). Plain SQLite files are
 * reported as unencrypted.
 */
export function probeBackupFile(filePath: string): BackupFileInfo {
  if (!fs.existsSync(filePath)) {
    throw new BackupCryptoError(
      "IO_ERROR",
      `Backup does not exist: ${filePath}`,
    );
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, "r");
  } catch (err) {
    throw new BackupCryptoError(
      "IO_ERROR",
      `Unable to open backup for probing: ${(err as Error).message}`,
    );
  }

  try {
    const magic = Buffer.alloc(4);
    const read = fs.readSync(descriptor, magic, 0, 4, 0);
    if (read < 4) {
      // Too small to be either SQLite or an encrypted container.
      return { encrypted: false };
    }

    if (magic.toString("ascii") === BACKUP_MAGIC) {
      const header = readHeader(filePath);
      return {
        encrypted: true,
        keyId: header.keyId,
        version: header.v,
        algorithm: header.payload.algo,
        payloadSize: header.payload.size,
      };
    }

    // A SQLite database always starts with this magic string; any other file is
    // treated as unencrypted (verification will fail downstream as appropriate).
    return { encrypted: false };
  } finally {
    fs.closeSync(descriptor);
  }
}

// ============================================
// ENCRYPT / DECRYPT
// ============================================

/**
 * Encrypt a plaintext file into an encrypted backup container.
 *
 * @param inputPath  Plaintext file to encrypt (e.g. a SQLite snapshot).
 * @param outputPath Where to write the encrypted container.
 * @param key        Operator passphrase / KEK (see generateBackupKey()).
 */
export async function encryptBackupFile(
  inputPath: string,
  outputPath: string,
  key: string,
): Promise<void> {
  if (!fs.existsSync(inputPath)) {
    throw new BackupCryptoError(
      "IO_ERROR",
      `Input file does not exist: ${inputPath}`,
    );
  }

  const salt = crypto.randomBytes(SALT_LENGTH);
  const kek = deriveKek(key, salt);

  // 1. Wrap a fresh per-backup DEK under the KEK.
  const dek = crypto.randomBytes(DEK_LENGTH);
  const dekIv = crypto.randomBytes(IV_LENGTH);
  const dekCipher = crypto.createCipheriv(PAYLOAD_ALGO, kek, dekIv);
  const wrappedDek = Buffer.concat([dekCipher.update(dek), dekCipher.final()]);
  const dekTag = dekCipher.getAuthTag();

  // 2. Stream the payload with the DEK.
  const payloadIv = crypto.randomBytes(IV_LENGTH);
  const stat = fs.statSync(inputPath);
  const payloadSize = stat.size;

  const header: EncryptedBackupHeader = {
    v: BACKUP_FORMAT_VERSION,
    keyId: deriveKeyId(key),
    kdf: {
      algo: "scrypt",
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      dkLen: SCRYPT_KEY_LENGTH,
      saltB64: salt.toString("base64"),
    },
    dek: {
      algo: PAYLOAD_ALGO,
      ivB64: dekIv.toString("base64"),
      tagB64: dekTag.toString("base64"),
      keyB64: wrappedDek.toString("base64"),
    },
    payload: {
      algo: PAYLOAD_ALGO,
      ivB64: payloadIv.toString("base64"),
      size: payloadSize,
    },
  };

  const headerBuf = encodeHeader(header);
  const cipher = crypto.createCipheriv(PAYLOAD_ALGO, dek, payloadIv);

  try {
    // Write header first, then stream ciphertext into the same file. The GCM
    // auth tag is produced on final() and appended explicitly (streaming with
    // `pipeline` does not emit it on all supported Node versions).
    fs.writeFileSync(outputPath, headerBuf);
    const out = fs.createWriteStream(outputPath, { flags: "a" });
    await pipeline(fs.createReadStream(inputPath), cipher, out);
    fs.appendFileSync(outputPath, cipher.getAuthTag());
  } catch (err) {
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch {
      /* best-effort cleanup */
    }
    throw new BackupCryptoError(
      "IO_ERROR",
      `Encryption failed: ${(err as Error).message}`,
    );
  }
}

/**
 * Decrypt an encrypted backup container back into a plaintext file.
 *
 * @param inputPath  Encrypted container to decrypt.
 * @param outputPath Where to write the decrypted plaintext (SQLite file).
 * @param key        The KEK used to wrap the DEK.
 * @param keyId      Optional; when provided it verifies the key matches what the
 *                   header expects before attempting decryption (fast fail).
 */
export async function decryptBackupFile(
  inputPath: string,
  outputPath: string,
  key: string,
  keyId?: string,
): Promise<void> {
  const header = readHeader(inputPath);

  if (keyId !== undefined && keyId !== header.keyId) {
    throw new BackupCryptoError(
      "WRONG_KEY",
      `Key ${deriveKeyId(key)} does not match backup key ${header.keyId}`,
    );
  }

  const salt = Buffer.from(header.kdf.saltB64, "base64");
  const kek = deriveKek(key, salt);

  const dekWrapped = {
    iv: Buffer.from(header.dek.ivB64, "base64"),
    tag: Buffer.from(header.dek.tagB64, "base64"),
    encrypted: Buffer.from(header.dek.keyB64, "base64"),
  };

  // Unwrap the DEK.
  let dek: Buffer;
  try {
    const decipher = crypto.createDecipheriv(PAYLOAD_ALGO, kek, dekWrapped.iv);
    decipher.setAuthTag(dekWrapped.tag);
    dek = Buffer.concat([
      decipher.update(dekWrapped.encrypted),
      decipher.final(),
    ]);
  } catch {
    throw new BackupCryptoError(
      "WRONG_KEY",
      "Failed to unwrap the backup data key (wrong key or corrupted header)",
    );
  }

  // Locate the GCM auth tag at the very end of the payload.
  const payloadOffset =
    PREAMBLE_LENGTH + Buffer.byteLength(JSON.stringify(header), "utf-8");
  const fileSize = fs.statSync(inputPath).size;
  if (payloadOffset + header.payload.size + TAG_LENGTH !== fileSize) {
    throw new BackupCryptoError(
      "CORRUPT_PAYLOAD",
      `Backup size mismatch (expected ${payloadOffset + header.payload.size + TAG_LENGTH}, got ${fileSize})`,
    );
  }

  let descriptor: number;
  try {
    descriptor = fs.openSync(inputPath, "r");
  } catch (err) {
    throw new BackupCryptoError(
      "IO_ERROR",
      `Unable to open backup for decryption: ${(err as Error).message}`,
    );
  }

  try {
    const tag = Buffer.alloc(TAG_LENGTH);
    fs.readSync(
      descriptor,
      tag,
      0,
      TAG_LENGTH,
      payloadOffset + header.payload.size,
    );

    const payloadIv = Buffer.from(header.payload.ivB64, "base64");
    const decipher = crypto.createDecipheriv(PAYLOAD_ALGO, dek, payloadIv);
    decipher.setAuthTag(tag);

    const source = fs.createReadStream(inputPath, {
      start: payloadOffset,
      end: payloadOffset + header.payload.size - 1,
    });

    try {
      await pipeline(source, decipher, fs.createWriteStream(outputPath));
    } catch {
      try {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      } catch {
        /* best-effort cleanup */
      }
      throw new BackupCryptoError(
        "WRONG_KEY",
        "Authentication failed while decrypting backup (wrong key or corrupt payload)",
      );
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Best-effort structured log for crypto events; keeps a single audit trail.
 */
export function logBackupCryptoEvent(
  level: "info" | "warn" | "error",
  event: string,
  meta: { keyId?: string; fileName?: string; error?: string } = {},
): void {
  log(level, event, meta);
}
