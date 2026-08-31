/**
 * Encryption at Rest for Secrets
 *
 * Uses AES-256-GCM to encrypt secret values before storage
 * and decrypt them on retrieval. The encryption key is derived
 * from a master key using PBKDF2.
 */
import crypto from "crypto";
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 16;
const PBKDF2_ITERATIONS = 100_000;
const DIGEST = "sha256";
/**
 * Derive a 256-bit encryption key from a master passphrase
 */
function deriveKey(masterKey, salt) {
    return crypto.pbkdf2Sync(masterKey, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST);
}
/**
 * Encrypt a plaintext string using AES-256-GCM
 * Returns a JSON-safe string combining salt, iv, authTag, and ciphertext
 */
export function encrypt(plaintext, masterKey) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = deriveKey(masterKey, salt);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf-8"),
        cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const payload = {
        s: salt.toString("base64"),
        i: iv.toString("base64"),
        a: authTag.toString("base64"),
        c: encrypted.toString("base64"),
    };
    return JSON.stringify(payload);
}
/**
 * Decrypt a ciphertext string produced by encrypt()
 * Returns the original plaintext
 */
export function decrypt(ciphertext, masterKey) {
    const payload = JSON.parse(ciphertext);
    const salt = Buffer.from(payload.s, "base64");
    const iv = Buffer.from(payload.i, "base64");
    const authTag = Buffer.from(payload.a, "base64");
    const encrypted = Buffer.from(payload.c, "base64");
    const key = deriveKey(masterKey, salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
    ]);
    return decrypted.toString("utf-8");
}
/**
 * Generate a random master key suitable for encryption usage
 */
export function generateMasterKey() {
    return crypto.randomBytes(32).toString("base64");
}
/**
 * Check if a string is a valid encrypted payload
 */
export function isEncrypted(value) {
    try {
        const parsed = JSON.parse(value);
        return (typeof parsed === "object" &&
            "s" in parsed &&
            "i" in parsed &&
            "a" in parsed &&
            "c" in parsed);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=encryptor.js.map