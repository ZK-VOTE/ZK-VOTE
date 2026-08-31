/**
 * Encryption at Rest for Secrets
 *
 * Uses AES-256-GCM to encrypt secret values before storage
 * and decrypt them on retrieval. The encryption key is derived
 * from a master key using PBKDF2.
 */
/**
 * Encrypt a plaintext string using AES-256-GCM
 * Returns a JSON-safe string combining salt, iv, authTag, and ciphertext
 */
export declare function encrypt(plaintext: string, masterKey: string): string;
/**
 * Decrypt a ciphertext string produced by encrypt()
 * Returns the original plaintext
 */
export declare function decrypt(ciphertext: string, masterKey: string): string;
/**
 * Generate a random master key suitable for encryption usage
 */
export declare function generateMasterKey(): string;
/**
 * Check if a string is a valid encrypted payload
 */
export declare function isEncrypted(value: string): boolean;
//# sourceMappingURL=encryptor.d.ts.map