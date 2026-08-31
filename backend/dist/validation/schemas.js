/**
 * Zod Validation Schemas
 *
 * Type-safe request validation for all API endpoints.
 * Includes BN254 field validation for ZK proof inputs.
 */
import { z } from "zod";
import { BN254_MODULUS } from "../config.js";
import { BN254_FQ_MODULUS } from "../types/index.js";
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
/**
 * Splits a padded, even-length hex string into `count` equal-size
 * coordinates and checks each is a valid BN254 base-field (Fq) element
 * (i.e. < BN254_FQ_MODULUS). This rejects obviously-malformed proof
 * coordinates before they ever reach the relayer or chain (#167); it does
 * NOT perform curve/subgroup membership verification — that remains the
 * Soroban host's job at proof-verification time (see module comment above).
 */
function coordinatesInFieldRange(paddedHex, count) {
    const coordHexLen = paddedHex.length / count;
    for (let i = 0; i < count; i++) {
        const coordHex = paddedHex.slice(i * coordHexLen, (i + 1) * coordHexLen);
        if (BigInt("0x" + coordHex) >= BN254_FQ_MODULUS)
            return false;
    }
    return true;
}
const proofA = hexString(128).refine((val) => {
    const hex = val.startsWith("0x") ? val.slice(2) : val;
    const padded = hex.padStart(128, "0");
    // G1 point at infinity (all zeros) is invalid for proof.a
    if (/^0*$/.test(padded))
        return false;
    return coordinatesInFieldRange(padded, 2); // X, Y
}, {
    message: "proof.a cannot be all zeros (point at infinity), and each coordinate must be a valid Fq element",
});
const proofB = hexString(256).refine((val) => {
    const hex = val.startsWith("0x") ? val.slice(2) : val;
    const padded = hex.padStart(256, "0");
    // G2 point at infinity (all zeros) is invalid for proof.b
    // Note: G2 has 4 field elements (X_c1, X_c0, Y_c1, Y_c0), all must be non-zero collectively
    if (/^0*$/.test(padded))
        return false;
    return coordinatesInFieldRange(padded, 4); // X_c1, X_c0, Y_c1, Y_c0
}, {
    message: "proof.b cannot be all zeros (point at infinity), and each coordinate must be a valid Fq element",
});
const proofC = hexString(128).refine((val) => {
    const hex = val.startsWith("0x") ? val.slice(2) : val;
    const padded = hex.padStart(128, "0");
    // G1 point at infinity (all zeros) is invalid for proof.c
    if (/^0*$/.test(padded))
        return false;
    return coordinatesInFieldRange(padded, 2); // X, Y
}, {
    message: "proof.c cannot be all zeros (point at infinity), and each coordinate must be a valid Fq element",
});
/**
 * Groth16 proof object
 */
export const groth16Proof = z.object({
    a: proofA,
    b: proofB,
    c: proofC,
});
// ============================================
// ROUTE PARAMETER VALIDATORS
// ============================================
/**
 * Positive integer validator for DAO/Proposal/Comment IDs
 */
const positiveInteger = z
    .string()
    .pipe(z.coerce
    .number()
    .positive("Must be a positive integer")
    .int("Must be an integer")
    .max(Number.MAX_SAFE_INTEGER, "Value too large"));
/**
 * IPFS CID validator (CIDv0 or CIDv1)
 */
const CIDV0_REGEX = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CIDV1_REGEX = /^baf[a-z2-7]{46,120}$/i;
const ipfsCid = z.string().refine((val) => {
    // CIDv0: exact-length Bitcoin base58 encoding.
    if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(val))
        return true;
    // CIDv1: bafy... or bafk... (59+ chars)
    if ((val.startsWith("bafy") || val.startsWith("bafk")) && val.length >= 59)
        return true;
    return false;
    if (!val || typeof val !== "string")
        return false;
    const trimmed = val.trim();
    if (/[/?\\#\s\0\r\n\t]/.test(trimmed))
        return false;
    return CIDV0_REGEX.test(trimmed) || CIDV1_REGEX.test(trimmed);
}, { message: "Invalid IPFS CID format" });
/**
 * Hex string validator for nullifiers (64 hex chars max)
 */
const nullifierHex = z.string().refine((val) => {
    const hex = val.startsWith("0x") ? val.slice(2) : val;
    if (hex.length === 0 || hex.length > 64)
        return false;
    return /^[0-9a-fA-F]*$/.test(hex);
}, { message: "Must be a valid hex string (max 64 chars)" });
/**
 * Commitment hash validator (64 hex chars)
 */
const commitmentHash = z.string().refine((val) => {
    const hex = val.startsWith("0x") ? val.slice(2) : val;
    return hex.length === 64 && /^[0-9a-fA-F]*$/.test(hex);
}, { message: "Must be a 64-character hex string" });
// ============================================
// ROUTE PARAMETER SCHEMAS
// ============================================
/**
 * Parameter schema for routes with :daoId
 */
export const daoParamsSchema = z.object({
    daoId: positiveInteger,
});
/**
 * Parameter schema for routes with :daoId and :proposalId
 */
export const proposalParamsSchema = z.object({
    daoId: positiveInteger,
    proposalId: positiveInteger,
});
/**
 * Parameter schema for routes with :daoId, :proposalId, and :commentId
 */
export const commentParamsSchema = z.object({
    daoId: positiveInteger,
    proposalId: positiveInteger,
    commentId: positiveInteger,
});
/**
 * Parameter schema for routes with :cid
 */
export const cidParamsSchema = z.object({
    cid: ipfsCid,
});
/**
 * Parameter schema for routes with :daoId, :proposalId, and :nullifier
 */
export const nullifierParamsSchema = z.object({
    daoId: positiveInteger,
    proposalId: positiveInteger,
    nullifier: nullifierHex,
});
/**
 * Parameter schema for routes with :commitment
 */
export const commitmentParamsSchema = z.object({
    commitment: commitmentHash,
});
/**
 * Parameter schema for routes with :archiveId
 */
export const archiveParamsSchema = z.object({
    archiveId: positiveInteger,
});
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
// PROOF COMMITMENT SCHEMA
// ============================================
export const commitSchema = z.object({
    daoId: z.number().int().nonnegative("daoId must be a non-negative integer"),
    proposalId: z
        .number()
        .int()
        .nonnegative("proposalId must be a non-negative integer"),
    nullifier: bn254Field,
    commitmentHash: commitmentHash,
    timestamp: z.number().int().positive("timestamp must be a positive integer"),
    walletAddress: z.string().optional(),
});
// ============================================
// VOTE SCHEMA
// ============================================
export const voteSchema = z
    .object({
    daoId: z.number().int().nonnegative("daoId must be a non-negative integer"),
    proposalId: z
        .number()
        .int()
        .nonnegative("proposalId must be a non-negative integer"),
    choice: z.boolean({
        required_error: "choice is required",
        invalid_type_error: "choice must be a boolean",
    }),
    nullifier: bn254Field.optional(),
    root: bn254Field.optional(),
    proof: groth16Proof.optional(),
    nonce: z.string().optional(),
    timestamp: z.number().int().optional(),
    walletAddress: z.string().optional(),
    encryptedPayload: z.union([z.string(), z.record(z.unknown())]).optional(),
    voterPublicKey: stellarAddress.optional(),
    voterSignature: z.string().min(1).optional(), // signed XDR from Freighter
})
    .refine((data) => data.encryptedPayload || (data.nullifier && data.root && data.proof), {
    message: "Either encryptedPayload or full vote payload (nullifier, root, proof) must be provided",
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
    serverId: z.string().optional(),
    workNonce: z.string().optional(),
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
// ANTI-SPAM: FLAG SCHEMA
// ============================================
export const flagCommentSchema = z.object({
    daoId: z.number().int().nonnegative("daoId must be a non-negative integer"),
    proposalId: z
        .number()
        .int()
        .nonnegative("proposalId must be a non-negative integer"),
    commentId: z
        .number()
        .int()
        .nonnegative("commentId must be a non-negative integer"),
    flaggerCommitment: bn254Field,
    flaggerNullifier: bn254Field,
    serverId: z.string(),
    workNonce: z.string(),
});
// ============================================
// ANTI-SPAM: CHALLENGE SCHEMA
// ============================================
export const challengeQuerySchema = z.object({
    commitment: bn254Field,
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
const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 100;
export const limitOffsetPaginationSchema = z.object({
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_SIZE)
        .default(DEFAULT_PAGE_SIZE),
    offset: z.coerce.number().int().min(0).default(0),
});
export const cursorPaginationSchema = z.object({
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_SIZE)
        .default(DEFAULT_PAGE_SIZE),
    cursor: z.string().optional(),
});
export const eventsQuerySchema = cursorPaginationSchema.extend({
    types: z
        .string()
        .optional()
        .transform((val) => val?.split(",").filter(Boolean) || null),
    orderBy: z
        .enum(["id", "timestamp", "ledger", "type", "verified", "created_at"])
        .default("timestamp"),
    orderDirection: z.enum(["ASC", "DESC"]).default("DESC"),
    cursorField: z.enum(["id", "ledger", "timestamp"]).default("id"),
});
/**
 * `GET /daos` pages on limit/offset but advertises the next page as the opaque
 * `pagination.cursor` string. Clients echo that value straight back, so `cursor`
 * is accepted as an alias for `offset` and folded into it here; an unparseable
 * cursor is rejected as a 400 rather than silently restarting from page one.
 */
export const daosQuerySchema = limitOffsetPaginationSchema
    .extend({
    user: stellarAddress.optional(),
    cursor: z.coerce.number().int().min(0).optional(),
})
    .transform(({ cursor, offset, ...rest }) => ({
    ...rest,
    offset: cursor ?? offset,
}));
export const commentCountQuerySchema = limitOffsetPaginationSchema.extend({
    types: z
        .string()
        .optional()
        .transform((val) => val?.split(",").filter(Boolean) || null),
});
export const commentNonceQuerySchema = z.object({
    commitment: bn254Field,
});
// ============================================
// VOTE-TO-EARN CLAIM SCHEMA
// ============================================
export const claimSchema = z.object({
    daoId: z.number().int().nonnegative("daoId must be a non-negative integer"),
    proposalId: z
        .number()
        .int()
        .nonnegative("proposalId must be a non-negative integer"),
    voteNullifier: bn254Field,
    claimNullifier: bn254Field,
    root: bn254Field,
    proof: groth16Proof,
});
//# sourceMappingURL=schemas.js.map