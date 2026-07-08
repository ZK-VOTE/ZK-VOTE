/**
 * Zod Validation Schemas
 *
 * Type-safe request validation for all API endpoints.
 * Includes BN254 field validation for ZK proof inputs.
 */
import { z } from "zod";
import { BN254_MODULUS } from "../config.js";
// ============================================
// PRIMITIVE VALIDATORS
// ============================================
/**
 * Hex string validator (with optional 0x prefix)
 */
const hexString = (maxHexChars) => z.string().refine((val) => {
    const hex = val.startsWith("0x") ? val.slice(2) : val;
    if (hex.length > maxHexChars)
        return false;
    return /^[0-9a-fA-F]*$/.test(hex);
}, { message: `Must be a valid hex string (max ${maxHexChars} chars)` });
/**
 * BN254 field element - hex string less than field modulus
 */
const bn254Field = z.string().refine((val) => {
    const hex = val.startsWith("0x") ? val.slice(2) : val;
    if (hex.length === 0 || hex.length > 64)
        return false;
    if (!/^[0-9a-fA-F]*$/.test(hex))
        return false;
    try {
        const value = BigInt("0x" + hex);
        return value < BN254_MODULUS;
    }
    catch {
        return false;
    }
}, { message: "Must be a valid hex string < BN254 field modulus" });
/**
 * Groth16 proof component validators
 *
 * BN254 Point Encoding (CAP-74 / EIP-196/197):
 * - G1 (a, c): 64 bytes (128 hex chars) = be_bytes(X) || be_bytes(Y)
 * - G2 (b): 128 bytes (256 hex chars) = be_bytes(X_c1) || be_bytes(X_c0) || be_bytes(Y_c1) || be_bytes(Y_c0)
 *
 * Point at infinity is (0, 0) for both G1 and G2, serialized as all zeros.
 * In a valid Groth16 proof, A, B, and C must NOT be the point at infinity.
 * Additional curve membership validation is performed on-chain by the host functions.
 */
const proofA = hexString(128).refine((val) => {
    const hex = val.startsWith("0x") ? val.slice(2) : val;
    // G1 point at infinity (all zeros) is invalid for proof.a
    return !/^0*$/.test(hex.padStart(128, "0"));
}, { message: "proof.a cannot be all zeros (point at infinity)" });
const proofB = hexString(256).refine((val) => {
    const hex = val.startsWith("0x") ? val.slice(2) : val;
    // G2 point at infinity (all zeros) is invalid for proof.b
    // Note: G2 has 4 field elements (X_c1, X_c0, Y_c1, Y_c0), all must be non-zero collectively
    return !/^0*$/.test(hex.padStart(256, "0"));
}, { message: "proof.b cannot be all zeros (point at infinity)" });
const proofC = hexString(128).refine((val) => {
    const hex = val.startsWith("0x") ? val.slice(2) : val;
    // G1 point at infinity (all zeros) is invalid for proof.c
    return !/^0*$/.test(hex.padStart(128, "0"));
}, { message: "proof.c cannot be all zeros (point at infinity)" });
/**
 * Groth16 proof object
 */
const groth16Proof = z.object({
    a: proofA,
    b: proofB,
    c: proofC,
});
/**
 * IPFS CID validator (CIDv0 or CIDv1)
 */
const ipfsCid = z.string().refine((val) => {
    // CIDv0: Qm... (46 chars)
    if (val.startsWith("Qm") && val.length >= 46)
        return true;
    // CIDv1: bafy... or bafk... (59+ chars)
    if ((val.startsWith("bafy") || val.startsWith("bafk")) && val.length >= 59)
        return true;
    return false;
}, { message: "Invalid IPFS CID format" });
/**
 * Stellar address validator
 */
const stellarAddress = z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address format");
/**
 * Stellar contract ID validator
 */
export const contractAddress = z
    .string()
    .regex(/^C[A-Z2-7]{55}$/, "Invalid Stellar contract ID format");
/**
 * Transaction hash validator (64 hex chars)
 */
const txHash = z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "Invalid transaction hash format");
// ============================================
// VOTE SCHEMA
// ============================================
export const voteSchema = z.object({
    daoId: z.number().int().nonnegative("daoId must be a non-negative integer"),
    proposalId: z
        .number()
        .int()
        .nonnegative("proposalId must be a non-negative integer"),
    choice: z.boolean({
        required_error: "choice is required",
        invalid_type_error: "choice must be a boolean",
    }),
    nullifier: bn254Field,
    root: bn254Field,
    proof: groth16Proof,
});
// ============================================
// ANONYMOUS COMMENT SCHEMA
// ============================================
export const anonymousCommentSchema = z.object({
    daoId: z.number().int().nonnegative("daoId must be a non-negative integer"),
    proposalId: z
        .number()
        .int()
        .nonnegative("proposalId must be a non-negative integer"),
    contentCid: ipfsCid,
    parentId: z.number().int().nonnegative().nullable().optional(),
    voteChoice: z.boolean({
        required_error: "voteChoice is required",
        invalid_type_error: "voteChoice must be a boolean",
    }),
    nullifier: bn254Field,
    root: bn254Field,
    proof: groth16Proof,
});
// ============================================
// COMMENT EDIT/DELETE SCHEMAS
// ============================================
export const editCommentSchema = z.object({
    daoId: z.number().int().nonnegative(),
    proposalId: z.number().int().nonnegative(),
    commentId: z.number().int().nonnegative(),
    newContentCid: ipfsCid,
    author: stellarAddress,
});
export const deleteCommentSchema = z.object({
    daoId: z.number().int().nonnegative(),
    proposalId: z.number().int().nonnegative(),
    commentId: z.number().int().nonnegative(),
    author: stellarAddress,
});
// ============================================
// EVENT SCHEMAS
// ============================================
export const manualEventSchema = z.object({
    daoId: z.number().int().nonnegative(),
    type: z.string().min(1, "type is required"),
    data: z.record(z.unknown()).optional(),
});
export const notifyEventSchema = z.object({
    daoId: z.number().int().nonnegative(),
    type: z.string().min(1, "type is required"),
    data: z.record(z.unknown()).optional(),
    txHash: txHash,
});
// ============================================
// IPFS METADATA SCHEMAS
// ============================================
export const proposalMetadataSchema = z
    .object({
    version: z.literal(1, {
        errorMap: () => ({ message: "version must be 1" }),
    }),
    body: z.string().max(100000, "body too large (max 100KB)"),
    videoUrl: z
        .string()
        .regex(/^https?:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com)\/.+$/i, "Invalid video URL. Only YouTube and Vimeo URLs are allowed.")
        .optional(),
})
    .passthrough(); // Allow additional fields
export const commentMetadataSchema = z
    .object({
    version: z.literal(1),
    body: z.string().max(10000, "body too large (max 10KB)"),
    createdAt: z.string().datetime().optional(),
})
    .passthrough();
// ============================================
// QUERY PARAMETER SCHEMAS
// ============================================
export const paginationSchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
});
export const eventsQuerySchema = paginationSchema.extend({
    types: z
        .string()
        .optional()
        .transform((val) => val?.split(",").filter(Boolean) || null),
});
export const commentNonceQuerySchema = z.object({
    commitment: bn254Field,
});
export const daosQuerySchema = z.object({
    user: stellarAddress.optional(),
});
//# sourceMappingURL=schemas.js.map