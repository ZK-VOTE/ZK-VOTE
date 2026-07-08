/**
 * Encryption utilities for member alias management
 * Uses signature-derived keys for symmetric encryption
 */

import nacl from "tweetnacl";
import { encodeBase64, decodeBase64 } from "tweetnacl-util";

// Note: deriveKeyFromSignature was removed - use deriveKeyFromSignatureAsync instead

/**
 * Signature input type - can be various formats from different wallets
 */
type SignatureInput =
  | Uint8Array
  | number[]
  | string
  | { signedMessage: SignatureInput }
  | { signature: SignatureInput }
  | { data: SignatureInput }
  | Buffer
  | Record<string, number>;

/**
 * Derives a symmetric encryption key from a wallet signature (async version)
 */
async function deriveKeyFromSignatureAsync(
  signature: SignatureInput,
  daoId: number,
): Promise<Uint8Array> {
  // Convert signature to Uint8Array if it's not already
  let sigBytes: Uint8Array;

  if (signature instanceof Uint8Array) {
    sigBytes = signature;
  } else if (Array.isArray(signature)) {
    // Handle regular array of numbers
    sigBytes = new Uint8Array(signature);
  } else if (typeof signature === "string") {
    // Try hex first
    if (signature.match(/^[0-9a-fA-F]+$/)) {
      sigBytes = new Uint8Array(
        signature.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || [],
      );
    } else {
      // Assume base64
      try {
        const binaryString = atob(signature);
        sigBytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          sigBytes[i] = binaryString.charCodeAt(i);
        }
      } catch (err) {
        throw new Error(`Failed to decode base64 signature: ${err}`);
      }
    }
  } else if (typeof signature === "object" && signature !== null) {
    // Handle object that might have signature property or be array-like
    if (
      "signedMessage" in signature &&
      typeof signature.signedMessage !== "number"
    ) {
      // Stellar wallet format (Freighter, etc.)
      return deriveKeyFromSignatureAsync(signature.signedMessage, daoId);
    } else if (
      "signature" in signature &&
      typeof signature.signature !== "number"
    ) {
      return deriveKeyFromSignatureAsync(signature.signature, daoId);
    } else if ("data" in signature && typeof signature.data !== "number") {
      return deriveKeyFromSignatureAsync(signature.data, daoId);
    } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(signature)) {
      sigBytes = new Uint8Array(signature);
    } else {
      // Try to convert object to array
      try {
        sigBytes = new Uint8Array(Object.values(signature));
      } catch {
        throw new Error(
          `Invalid signature object format: ${JSON.stringify(signature).substring(0, 100)}`,
        );
      }
    }
  } else {
    throw new Error(`Invalid signature format - type: ${typeof signature}`);
  }

  const context = new TextEncoder().encode(`zkvote-aliases-${daoId}`);
  const combined = new Uint8Array(sigBytes.length + context.length);
  combined.set(sigBytes);
  combined.set(context, sigBytes.length);

  const hash = await crypto.subtle.digest("SHA-256", combined);
  return new Uint8Array(hash);
}

/**
 * Encrypts a plaintext string using a symmetric key
 * @param plaintext - The text to encrypt
 * @param key - 32-byte symmetric key
 * @returns Base64-encoded encrypted data (nonce + ciphertext)
 */
function encryptWithKey(plaintext: string, key: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const messageBytes = new TextEncoder().encode(plaintext);
  const ciphertext = nacl.secretbox(messageBytes, nonce, key);

  // Combine nonce + ciphertext
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce);
  combined.set(ciphertext, nonce.length);

  return encodeBase64(combined);
}

/**
 * Decrypts ciphertext using a symmetric key
 * @param ciphertext - Base64-encoded encrypted data
 * @param key - 32-byte symmetric key
 * @returns Decrypted plaintext, or null if decryption fails
 */
function decryptWithKey(ciphertext: string, key: Uint8Array): string | null {
  try {
    const combined = decodeBase64(ciphertext);
    const nonce = combined.slice(0, nacl.secretbox.nonceLength);
    const message = combined.slice(nacl.secretbox.nonceLength);

    const decrypted = nacl.secretbox.open(message, nonce, key);
    if (!decrypted) {
      return null;
    }

    return new TextDecoder().decode(decrypted);
  } catch (error) {
    console.error("Decryption failed:", error);
    return null;
  }
}

/**
 * Session storage key for encryption keys
 */
function getSessionKeyStorageKey(daoId: number): string {
  return `dao_encryption_key_${daoId}`;
}

/**
 * Gets the encryption key from session storage
 */
export function getEncryptionKeyFromSession(daoId: number): Uint8Array | null {
  const stored = sessionStorage.getItem(getSessionKeyStorageKey(daoId));
  if (!stored) return null;

  try {
    const decoded = decodeBase64(stored);
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Stores the encryption key in session storage
 */
export function storeEncryptionKeyInSession(
  daoId: number,
  key: Uint8Array,
): void {
  sessionStorage.setItem(getSessionKeyStorageKey(daoId), encodeBase64(key));
}

/**
 * Clears the encryption key from session storage
 */
export function clearEncryptionKeyFromSession(daoId: number): void {
  sessionStorage.removeItem(getSessionKeyStorageKey(daoId));
}

/**
 * Gets or derives an encryption key for a DAO
 * If key exists in session, returns it. Otherwise, prompts for signature.
 *
 * @param daoId - DAO ID
 * @param signMessage - Function to sign a message with the wallet
 * @returns Encryption key, or null if user cancels
 */
export async function getOrDeriveEncryptionKey(
  daoId: number,
  signMessage: (message: string) => Promise<string | Uint8Array>,
): Promise<Uint8Array | null> {
  // Check session storage first
  const sessionKey = getEncryptionKeyFromSession(daoId);
  if (sessionKey) {
    return sessionKey;
  }

  // Need to derive key from signature
  const message = `[ZKVote App - DO NOT SIGN ON OTHER SITES]

Action: Unlock member alias encryption key
DAO ID: ${daoId}
Purpose: This signature decrypts member nicknames for DAO admins.
Warning: Only sign this on the official ZKVote application.

By signing, you acknowledge that this reveals member aliases you've set for DAO ${daoId}.`;

  try {
    const signature = await signMessage(message);
    const key = await deriveKeyFromSignatureAsync(signature, daoId);

    // Store in session
    storeEncryptionKeyInSession(daoId, key);

    return key;
  } catch (error) {
    console.error("Failed to derive encryption key:", error);
    return null;
  }
}

/**
 * Encrypts an alias using the DAO's encryption key
 *
 * @param alias - Plain text alias
 * @param encryptionKey - 32-byte symmetric key
 * @returns Base64-encoded encrypted alias
 */
export function encryptAlias(alias: string, encryptionKey: Uint8Array): string {
  return encryptWithKey(alias, encryptionKey);
}

/**
 * Decrypts an alias using the DAO's encryption key
 *
 * @param encryptedAlias - Base64-encoded encrypted alias
 * @param encryptionKey - 32-byte symmetric key
 * @returns Decrypted alias, or null if decryption fails
 */
export function decryptAlias(
  encryptedAlias: string,
  encryptionKey: Uint8Array,
): string | null {
  return decryptWithKey(encryptedAlias, encryptionKey);
}
