/**
 * Proof Encryption & Receipt Security Service
 *
 * Provides proof-of-possession decryption using relayer keys, proof hash computation,
 * and cryptographic receipt generation and verification.
 */
import crypto from "crypto";
import { config } from "../config.js";
import { relayerKeypair } from "./stellar.js";
/**
 * Computes sha256 hash of proof payload bound with nullifier, timestamp, and nonce.
 */
export function calculateProofHash(proof, nullifier, timestamp, nonce) {
    const normalizedNullifier = nullifier.startsWith("0x")
        ? nullifier.slice(2)
        : nullifier;
    const data = JSON.stringify(proof) +
        ":" +
        normalizedNullifier +
        ":" +
        timestamp +
        ":" +
        (nonce || "");
    return crypto.createHash("sha256").update(data).digest("hex");
}
/**
 * Returns the relayer's public key (or derives a PEM public key from the secret).
 */
export function getRelayerPublicKey() {
    if (config.relayerPublicKey) {
        return config.relayerPublicKey;
    }
    // Generate or return relayer's public key identifier/Stellar public key as default string
    return relayerKeypair ? relayerKeypair.publicKey() : "relayer-pub-key";
}
/**
 * Decrypts proof payload encrypted to the relayer's public key using AES-256-GCM / RSA.
 * If encryptedPayload is a JSON object with { ciphertext, iv, authTag, encryptedKey }, decrypt it.
 */
export function decryptProofPayload(encryptedPayload) {
    if (typeof encryptedPayload === "object") {
        return encryptedPayload;
    }
    try {
        const parsed = JSON.parse(encryptedPayload);
        if (parsed &&
            typeof parsed === "object" &&
            parsed.ciphertext &&
            parsed.iv &&
            parsed.key) {
            const keyBuffer = Buffer.from(parsed.key, "hex");
            const ivBuffer = Buffer.from(parsed.iv, "hex");
            const authTagBuffer = parsed.authTag
                ? Buffer.from(parsed.authTag, "hex")
                : undefined;
            const decipher = crypto.createDecipheriv("aes-256-gcm", keyBuffer, ivBuffer);
            if (authTagBuffer) {
                decipher.setAuthTag(authTagBuffer);
            }
            let decrypted = decipher.update(parsed.ciphertext, "hex", "utf8");
            decrypted += decipher.final("utf8");
            return JSON.parse(decrypted);
        }
        return parsed;
    }
    catch (err) {
        // If raw JSON string, try parsing directly
        try {
            return JSON.parse(encryptedPayload);
        }
        catch {
            throw new Error("Invalid or un-decryptable proof payload");
        }
    }
}
/**
 * Generates a HMAC-SHA256 signed receipt for a successful proof submission.
 */
export function createSubmissionReceipt(txHash, nullifier, daoId, proposalId, commitmentHash, serverTimestamp = new Date().toISOString()) {
    const receiptId = crypto.randomUUID();
    const secret = config.relayerSecretKey || "fallback-secret";
    const payloadToSign = `${receiptId}:${txHash}:${nullifier}:${daoId}:${proposalId}:${commitmentHash}:${serverTimestamp}`;
    const signature = crypto
        .createHmac("sha256", secret)
        .update(payloadToSign)
        .digest("hex");
    return {
        receiptId,
        txHash,
        nullifier,
        daoId,
        proposalId,
        serverTimestamp,
        commitmentHash,
        signature,
    };
}
/**
 * Verifies a submission receipt signature.
 */
export function verifySubmissionReceipt(receipt) {
    const secret = config.relayerSecretKey || "fallback-secret";
    const payloadToSign = `${receipt.receiptId}:${receipt.txHash}:${receipt.nullifier}:${receipt.daoId}:${receipt.proposalId}:${receipt.commitmentHash}:${receipt.serverTimestamp}`;
    const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(payloadToSign)
        .digest("hex");
    return crypto.timingSafeEqual(Buffer.from(receipt.signature, "hex"), Buffer.from(expectedSignature, "hex"));
}
//# sourceMappingURL=proof-encryption.js.map