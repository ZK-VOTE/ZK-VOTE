/**
 * Proof Encryption & Receipt Security Service
 *
 * Provides proof-of-possession decryption using relayer keys, proof hash computation,
 * and cryptographic receipt generation and verification.
 */
export interface ProofSubmissionReceipt {
    receiptId: string;
    txHash: string;
    nullifier: string;
    daoId: number;
    proposalId: number;
    serverTimestamp: string;
    commitmentHash: string;
    signature: string;
}
/**
 * Computes sha256 hash of proof payload bound with nullifier, timestamp, and nonce.
 */
export declare function calculateProofHash(proof: unknown, nullifier: string, timestamp: number, nonce?: string): string;
/**
 * Returns the relayer's public key (or derives a PEM public key from the secret).
 */
export declare function getRelayerPublicKey(): string;
/**
 * Decrypts proof payload encrypted to the relayer's public key using AES-256-GCM / RSA.
 * If encryptedPayload is a JSON object with { ciphertext, iv, authTag, encryptedKey }, decrypt it.
 */
export declare function decryptProofPayload(encryptedPayload: string | object): any;
/**
 * Generates a HMAC-SHA256 signed receipt for a successful proof submission.
 */
export declare function createSubmissionReceipt(txHash: string, nullifier: string, daoId: number, proposalId: number, commitmentHash: string, serverTimestamp?: string): ProofSubmissionReceipt;
/**
 * Verifies a submission receipt signature.
 */
export declare function verifySubmissionReceipt(receipt: ProofSubmissionReceipt): boolean;
//# sourceMappingURL=proof-encryption.d.ts.map