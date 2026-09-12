/**
 * Zod Validation Schemas
 *
 * Type-safe request validation for all API endpoints.
 * Includes BN254 field validation for ZK proof inputs.
 */
import { z } from "zod";
export declare const MAX_IMAGE_UPLOAD_BYTES: number;
export declare const MAX_IMAGE_DIMENSION = 4096;
export declare const imageUploadMulterLimits: {
    readonly fileSize: number;
    readonly files: 1;
};
export declare const imageUploadSchema: z.ZodEffects<z.ZodEffects<z.ZodObject<{
    fieldname: z.ZodOptional<z.ZodString>;
    originalname: z.ZodOptional<z.ZodString>;
    encoding: z.ZodOptional<z.ZodString>;
    mimetype: z.ZodString;
    size: z.ZodNumber;
    buffer: z.ZodType<Buffer, z.ZodTypeDef, Buffer>;
}, "strip", z.ZodTypeAny, {
    buffer: Buffer;
    size: number;
    mimetype: string;
    encoding?: string | undefined;
    fieldname?: string | undefined;
    originalname?: string | undefined;
}, {
    buffer: Buffer;
    size: number;
    mimetype: string;
    encoding?: string | undefined;
    fieldname?: string | undefined;
    originalname?: string | undefined;
}>, {
    buffer: Buffer;
    size: number;
    mimetype: string;
    encoding?: string | undefined;
    fieldname?: string | undefined;
    originalname?: string | undefined;
}, {
    buffer: Buffer;
    size: number;
    mimetype: string;
    encoding?: string | undefined;
    fieldname?: string | undefined;
    originalname?: string | undefined;
}>, {
    detectedMime: string;
    width: number | undefined;
    height: number | undefined;
    sha256: string;
    sanitizedBuffer: Buffer;
    buffer: Buffer;
    size: number;
    mimetype: string;
    encoding?: string | undefined;
    fieldname?: string | undefined;
    originalname?: string | undefined;
}, {
    buffer: Buffer;
    size: number;
    mimetype: string;
    encoding?: string | undefined;
    fieldname?: string | undefined;
    originalname?: string | undefined;
}>;
/**
 * BN254 field element - hex string less than field modulus
 */
export declare const bn254Field: z.ZodEffects<z.ZodString, string, string>;
/**
 * Groth16 proof object
 */
export declare const groth16Proof: z.ZodObject<{
    a: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
    b: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
    c: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
}, "strip", z.ZodTypeAny, {
    a: string;
    b: string;
    c: string;
}, {
    a: string;
    b: string;
    c: string;
}>;
/**
 * Groth16 proof object — anonymous-path variant.
 * Uses the generic-message component validators above so no single
 * sub-check leak is exposed to a probing relayer.
 */
export declare const groth16ProofAnon: z.ZodObject<{
    a: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
    b: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
    c: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
}, "strip", z.ZodTypeAny, {
    a: string;
    b: string;
    c: string;
}, {
    a: string;
    b: string;
    c: string;
}>;
/**
 * Positive integer validator for DAO/Proposal/Comment IDs
 */
export declare const positiveInteger: z.ZodPipeline<z.ZodString, z.ZodNumber>;
/**
 * IPFS CID validator (CIDv0 or CIDv1)
 */
/**
 * IPFS CID validator (CIDv0 or CIDv1)
 */
export declare const ipfsCid: z.ZodEffects<z.ZodString, string, string>;
/**
 * Hex string validator for nullifiers (64 hex chars max)
 */
export declare const nullifierHex: z.ZodEffects<z.ZodString, string, string>;
/**
 * Commitment hash validator (64 hex chars)
 */
export declare const commitmentHash: z.ZodEffects<z.ZodString, string, string>;
/**
 * Parameter schema for routes with :daoId
 */
export declare const daoParamsSchema: z.ZodObject<{
    daoId: z.ZodPipeline<z.ZodString, z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    daoId: number;
}, {
    daoId: string;
}>;
/**
 * Parameter schema for routes with :daoId and :proposalId
 */
export declare const proposalParamsSchema: z.ZodObject<{
    daoId: z.ZodPipeline<z.ZodString, z.ZodNumber>;
    proposalId: z.ZodPipeline<z.ZodString, z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    daoId: number;
    proposalId: number;
}, {
    daoId: string;
    proposalId: string;
}>;
/**
 * Parameter schema for routes with :daoId, :proposalId, and :commentId
 */
export declare const commentParamsSchema: z.ZodObject<{
    daoId: z.ZodPipeline<z.ZodString, z.ZodNumber>;
    proposalId: z.ZodPipeline<z.ZodString, z.ZodNumber>;
    commentId: z.ZodPipeline<z.ZodString, z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    daoId: number;
    proposalId: number;
    commentId: number;
}, {
    daoId: string;
    proposalId: string;
    commentId: string;
}>;
/**
 * Parameter schema for routes with :cid
 */
export declare const cidParamsSchema: z.ZodObject<{
    cid: z.ZodEffects<z.ZodString, string, string>;
}, "strip", z.ZodTypeAny, {
    cid: string;
}, {
    cid: string;
}>;
/**
 * Parameter schema for routes with :daoId, :proposalId, and :nullifier
 */
export declare const nullifierParamsSchema: z.ZodObject<{
    daoId: z.ZodPipeline<z.ZodString, z.ZodNumber>;
    proposalId: z.ZodPipeline<z.ZodString, z.ZodNumber>;
    nullifier: z.ZodEffects<z.ZodString, string, string>;
}, "strip", z.ZodTypeAny, {
    nullifier: string;
    daoId: number;
    proposalId: number;
}, {
    nullifier: string;
    daoId: string;
    proposalId: string;
}>;
/**
 * Parameter schema for routes with :commitment
 */
export declare const commitmentParamsSchema: z.ZodObject<{
    commitment: z.ZodEffects<z.ZodString, string, string>;
}, "strip", z.ZodTypeAny, {
    commitment: string;
}, {
    commitment: string;
}>;
/**
 * Parameter schema for routes with :archiveId
 */
export declare const archiveParamsSchema: z.ZodObject<{
    archiveId: z.ZodPipeline<z.ZodString, z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    archiveId: number;
}, {
    archiveId: string;
}>;
/**
 * Stellar address validator
 */
export declare const stellarAddress: z.ZodString;
/**
 * Stellar contract ID validator
 */
export declare const contractAddress: z.ZodString;
/**
 * Transaction hash validator (64 hex chars)
 */
export declare const txHash: z.ZodString;
export declare const commitSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    proposalId: z.ZodNumber;
    nullifier: z.ZodEffects<z.ZodString, string, string>;
    commitmentHash: z.ZodEffects<z.ZodString, string, string>;
    timestamp: z.ZodNumber;
    walletAddress: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    nullifier: string;
    daoId: number;
    timestamp: number;
    proposalId: number;
    commitmentHash: string;
    walletAddress?: string | undefined;
}, {
    nullifier: string;
    daoId: number;
    timestamp: number;
    proposalId: number;
    commitmentHash: string;
    walletAddress?: string | undefined;
}>;
export type CommitRequest = z.infer<typeof commitSchema>;
/**
 * Membership commitment registration request body.
 * `caller` is the Stellar address of the member registering (used as the
 * per-member rate-limit key on the backend and auth'd on-chain).
 */
export declare const membershipRegisterSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    commitment: z.ZodEffects<z.ZodString, string, string>;
    caller: z.ZodString;
}, "strip", z.ZodTypeAny, {
    commitment: string;
    daoId: number;
    caller: string;
}, {
    commitment: string;
    daoId: number;
    caller: string;
}>;
export type MembershipRegisterRequest = z.infer<typeof membershipRegisterSchema>;
export declare const blindSignRequestSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    blindedValue: z.ZodEffects<z.ZodString, string, string>;
    caller: z.ZodString;
}, "strip", z.ZodTypeAny, {
    daoId: number;
    caller: string;
    blindedValue: string;
}, {
    daoId: number;
    caller: string;
    blindedValue: string;
}>;
export type BlindSignRequest = z.infer<typeof blindSignRequestSchema>;
export declare const voteSchema: z.ZodEffects<z.ZodObject<{
    daoId: z.ZodNumber;
    proposalId: z.ZodNumber;
    choice: z.ZodBoolean;
    nullifier: z.ZodOptional<z.ZodEffects<z.ZodString, string, string>>;
    root: z.ZodOptional<z.ZodEffects<z.ZodString, string, string>>;
    proof: z.ZodOptional<z.ZodObject<{
        a: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
        b: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
        c: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
    }, "strip", z.ZodTypeAny, {
        a: string;
        b: string;
        c: string;
    }, {
        a: string;
        b: string;
        c: string;
    }>>;
    nonce: z.ZodOptional<z.ZodString>;
    timestamp: z.ZodOptional<z.ZodNumber>;
    walletAddress: z.ZodOptional<z.ZodString>;
    encryptedPayload: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>]>>;
    voterPublicKey: z.ZodOptional<z.ZodString>;
    voterSignature: z.ZodOptional<z.ZodString>;
    sponsor: z.ZodOptional<z.ZodEnum<["relayer", "voter"]>>;
    feePayer: z.ZodOptional<z.ZodString>;
    feeBudgetStroops: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    daoId: number;
    proposalId: number;
    choice: boolean;
    proof?: {
        a: string;
        b: string;
        c: string;
    } | undefined;
    nullifier?: string | undefined;
    timestamp?: number | undefined;
    root?: string | undefined;
    nonce?: string | undefined;
    walletAddress?: string | undefined;
    encryptedPayload?: string | Record<string, unknown> | undefined;
    voterPublicKey?: string | undefined;
    voterSignature?: string | undefined;
    sponsor?: "relayer" | "voter" | undefined;
    feePayer?: string | undefined;
    feeBudgetStroops?: number | undefined;
}, {
    daoId: number;
    proposalId: number;
    choice: boolean;
    proof?: {
        a: string;
        b: string;
        c: string;
    } | undefined;
    nullifier?: string | undefined;
    timestamp?: number | undefined;
    root?: string | undefined;
    nonce?: string | undefined;
    walletAddress?: string | undefined;
    encryptedPayload?: string | Record<string, unknown> | undefined;
    voterPublicKey?: string | undefined;
    voterSignature?: string | undefined;
    sponsor?: "relayer" | "voter" | undefined;
    feePayer?: string | undefined;
    feeBudgetStroops?: number | undefined;
}>, {
    daoId: number;
    proposalId: number;
    choice: boolean;
    proof?: {
        a: string;
        b: string;
        c: string;
    } | undefined;
    nullifier?: string | undefined;
    timestamp?: number | undefined;
    root?: string | undefined;
    nonce?: string | undefined;
    walletAddress?: string | undefined;
    encryptedPayload?: string | Record<string, unknown> | undefined;
    voterPublicKey?: string | undefined;
    voterSignature?: string | undefined;
    sponsor?: "relayer" | "voter" | undefined;
    feePayer?: string | undefined;
    feeBudgetStroops?: number | undefined;
}, {
    daoId: number;
    proposalId: number;
    choice: boolean;
    proof?: {
        a: string;
        b: string;
        c: string;
    } | undefined;
    nullifier?: string | undefined;
    timestamp?: number | undefined;
    root?: string | undefined;
    nonce?: string | undefined;
    walletAddress?: string | undefined;
    encryptedPayload?: string | Record<string, unknown> | undefined;
    voterPublicKey?: string | undefined;
    voterSignature?: string | undefined;
    sponsor?: "relayer" | "voter" | undefined;
    feePayer?: string | undefined;
    feeBudgetStroops?: number | undefined;
}>;
export type VoteRequest = z.infer<typeof voteSchema>;
/**
 * Upper bound on a submitted batch.
 *
 * Mirrors `MAX_VOTE_BATCH` in the voting contract, which is
 * `zkvote_groth16::batch::MAX_BATCH_SIZE`. Rejecting an oversized batch here
 * saves a round trip to a simulation that would panic anyway.
 */
export declare const MAX_VOTE_BATCH = 64;
/**
 * One vote inside a batch.
 *
 * Unlike a single vote there is no `encryptedPayload` variant: the relayer has
 * to see every nullifier to reject a batch that repeats one, and the contract
 * verifies the whole batch under one aggregated pairing check, so a partially
 * opaque batch could not be assembled.
 */
export declare const batchVoteSchema: z.ZodObject<{
    choice: z.ZodBoolean;
    nullifier: z.ZodEffects<z.ZodString, string, string>;
    root: z.ZodEffects<z.ZodString, string, string>;
    proof: z.ZodObject<{
        a: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
        b: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
        c: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
    }, "strip", z.ZodTypeAny, {
        a: string;
        b: string;
        c: string;
    }, {
        a: string;
        b: string;
        c: string;
    }>;
}, "strip", z.ZodTypeAny, {
    proof: {
        a: string;
        b: string;
        c: string;
    };
    nullifier: string;
    root: string;
    choice: boolean;
}, {
    proof: {
        a: string;
        b: string;
        c: string;
    };
    nullifier: string;
    root: string;
    choice: boolean;
}>;
export declare const voteBatchSchema: z.ZodEffects<z.ZodObject<{
    daoId: z.ZodNumber;
    proposalId: z.ZodNumber;
    votes: z.ZodArray<z.ZodObject<{
        choice: z.ZodBoolean;
        nullifier: z.ZodEffects<z.ZodString, string, string>;
        root: z.ZodEffects<z.ZodString, string, string>;
        proof: z.ZodObject<{
            a: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
            b: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
            c: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
        }, "strip", z.ZodTypeAny, {
            a: string;
            b: string;
            c: string;
        }, {
            a: string;
            b: string;
            c: string;
        }>;
    }, "strip", z.ZodTypeAny, {
        proof: {
            a: string;
            b: string;
            c: string;
        };
        nullifier: string;
        root: string;
        choice: boolean;
    }, {
        proof: {
            a: string;
            b: string;
            c: string;
        };
        nullifier: string;
        root: string;
        choice: boolean;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    daoId: number;
    proposalId: number;
    votes: {
        proof: {
            a: string;
            b: string;
            c: string;
        };
        nullifier: string;
        root: string;
        choice: boolean;
    }[];
}, {
    daoId: number;
    proposalId: number;
    votes: {
        proof: {
            a: string;
            b: string;
            c: string;
        };
        nullifier: string;
        root: string;
        choice: boolean;
    }[];
}>, {
    daoId: number;
    proposalId: number;
    votes: {
        proof: {
            a: string;
            b: string;
            c: string;
        };
        nullifier: string;
        root: string;
        choice: boolean;
    }[];
}, {
    daoId: number;
    proposalId: number;
    votes: {
        proof: {
            a: string;
            b: string;
            c: string;
        };
        nullifier: string;
        root: string;
        choice: boolean;
    }[];
}>;
export type VoteBatchRequest = z.infer<typeof voteBatchSchema>;
export declare const anonymousCommentSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    proposalId: z.ZodNumber;
    contentCid: z.ZodEffects<z.ZodString, string, string>;
    parentId: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    voteChoice: z.ZodBoolean;
    nullifier: z.ZodEffects<z.ZodString, string, string>;
    root: z.ZodEffects<z.ZodString, string, string>;
    proof: z.ZodObject<{
        a: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
        b: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
        c: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
    }, "strip", z.ZodTypeAny, {
        a: string;
        b: string;
        c: string;
    }, {
        a: string;
        b: string;
        c: string;
    }>;
    serverId: z.ZodOptional<z.ZodString>;
    workNonce: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    proof: {
        a: string;
        b: string;
        c: string;
    };
    nullifier: string;
    daoId: number;
    proposalId: number;
    root: string;
    contentCid: string;
    voteChoice: boolean;
    parentId?: number | null | undefined;
    serverId?: string | undefined;
    workNonce?: string | undefined;
}, {
    proof: {
        a: string;
        b: string;
        c: string;
    };
    nullifier: string;
    daoId: number;
    proposalId: number;
    root: string;
    contentCid: string;
    voteChoice: boolean;
    parentId?: number | null | undefined;
    serverId?: string | undefined;
    workNonce?: string | undefined;
}>;
export type AnonymousCommentRequest = z.infer<typeof anonymousCommentSchema>;
export declare const editCommentSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    proposalId: z.ZodNumber;
    commentId: z.ZodNumber;
    newContentCid: z.ZodEffects<z.ZodString, string, string>;
    author: z.ZodString;
}, "strip", z.ZodTypeAny, {
    daoId: number;
    proposalId: number;
    commentId: number;
    newContentCid: string;
    author: string;
}, {
    daoId: number;
    proposalId: number;
    commentId: number;
    newContentCid: string;
    author: string;
}>;
export type EditCommentRequest = z.infer<typeof editCommentSchema>;
export declare const deleteCommentSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    proposalId: z.ZodNumber;
    commentId: z.ZodNumber;
    author: z.ZodString;
}, "strip", z.ZodTypeAny, {
    daoId: number;
    proposalId: number;
    commentId: number;
    author: string;
}, {
    daoId: number;
    proposalId: number;
    commentId: number;
    author: string;
}>;
export type DeleteCommentRequest = z.infer<typeof deleteCommentSchema>;
export declare const flagCommentSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    proposalId: z.ZodNumber;
    commentId: z.ZodNumber;
    flaggerCommitment: z.ZodEffects<z.ZodString, string, string>;
    flaggerNullifier: z.ZodEffects<z.ZodString, string, string>;
    serverId: z.ZodString;
    workNonce: z.ZodString;
}, "strip", z.ZodTypeAny, {
    daoId: number;
    proposalId: number;
    serverId: string;
    workNonce: string;
    commentId: number;
    flaggerCommitment: string;
    flaggerNullifier: string;
}, {
    daoId: number;
    proposalId: number;
    serverId: string;
    workNonce: string;
    commentId: number;
    flaggerCommitment: string;
    flaggerNullifier: string;
}>;
export type FlagCommentRequest = z.infer<typeof flagCommentSchema>;
export declare const challengeQuerySchema: z.ZodObject<{
    commitment: z.ZodEffects<z.ZodString, string, string>;
}, "strip", z.ZodTypeAny, {
    commitment: string;
}, {
    commitment: string;
}>;
export declare const manualEventSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    type: z.ZodString;
    data: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    type: string;
    daoId: number;
    data?: Record<string, unknown> | undefined;
}, {
    type: string;
    daoId: number;
    data?: Record<string, unknown> | undefined;
}>;
export type ManualEventRequest = z.infer<typeof manualEventSchema>;
export declare const notifyEventSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    type: z.ZodString;
    data: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    txHash: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: string;
    daoId: number;
    txHash: string;
    data?: Record<string, unknown> | undefined;
}, {
    type: string;
    daoId: number;
    txHash: string;
    data?: Record<string, unknown> | undefined;
}>;
export type NotifyEventRequest = z.infer<typeof notifyEventSchema>;
export declare const proposalMetadataSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    body: z.ZodString;
    videoUrl: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    version: z.ZodLiteral<1>;
    body: z.ZodString;
    videoUrl: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    version: z.ZodLiteral<1>;
    body: z.ZodString;
    videoUrl: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
export type ProposalMetadata = z.infer<typeof proposalMetadataSchema>;
export declare const commentMetadataSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    body: z.ZodString;
    createdAt: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    version: z.ZodLiteral<1>;
    body: z.ZodString;
    createdAt: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    version: z.ZodLiteral<1>;
    body: z.ZodString;
    createdAt: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
export type CommentMetadata = z.infer<typeof commentMetadataSchema>;
export declare const limitOffsetPaginationSchema: z.ZodObject<{
    limit: z.ZodDefault<z.ZodNumber>;
    offset: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    offset: number;
}, {
    limit?: number | undefined;
    offset?: number | undefined;
}>;
export declare const cursorPaginationSchema: z.ZodObject<{
    limit: z.ZodDefault<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    cursor?: string | undefined;
}, {
    limit?: number | undefined;
    cursor?: string | undefined;
}>;
export declare const eventsQuerySchema: z.ZodObject<{
    limit: z.ZodDefault<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
} & {
    types: z.ZodEffects<z.ZodOptional<z.ZodString>, string[] | null, string | undefined>;
    orderBy: z.ZodDefault<z.ZodEnum<["id", "timestamp", "ledger", "type", "verified", "created_at"]>>;
    orderDirection: z.ZodDefault<z.ZodEnum<["ASC", "DESC"]>>;
    cursorField: z.ZodDefault<z.ZodEnum<["id", "ledger", "timestamp"]>>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    types: string[] | null;
    orderBy: "type" | "id" | "ledger" | "timestamp" | "verified" | "created_at";
    orderDirection: "ASC" | "DESC";
    cursorField: "id" | "ledger" | "timestamp";
    cursor?: string | undefined;
}, {
    limit?: number | undefined;
    types?: string | undefined;
    orderBy?: "type" | "id" | "ledger" | "timestamp" | "verified" | "created_at" | undefined;
    orderDirection?: "ASC" | "DESC" | undefined;
    cursor?: string | undefined;
    cursorField?: "id" | "ledger" | "timestamp" | undefined;
}>;
/**
 * `GET /daos` pages on limit/offset but advertises the next page as the opaque
 * `pagination.cursor` string. Clients echo that value straight back, so `cursor`
 * is accepted as an alias for `offset` and folded into it here; an unparseable
 * cursor is rejected as a 400 rather than silently restarting from page one.
 */
export declare const daosQuerySchema: z.ZodEffects<z.ZodObject<{
    limit: z.ZodDefault<z.ZodNumber>;
    offset: z.ZodDefault<z.ZodNumber>;
} & {
    user: z.ZodOptional<z.ZodString>;
    /** Free-text search against DAO name (case-insensitive substring match) */
    search: z.ZodOptional<z.ZodString>;
    /** Filter by membership type: open | closed */
    membershipType: z.ZodOptional<z.ZodEnum<["open", "closed"]>>;
    cursor: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    offset: number;
    search?: string | undefined;
    cursor?: number | undefined;
    user?: string | undefined;
    membershipType?: "closed" | "open" | undefined;
}, {
    search?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
    cursor?: number | undefined;
    user?: string | undefined;
    membershipType?: "closed" | "open" | undefined;
}>, {
    offset: number;
    limit: number;
    search?: string | undefined;
    user?: string | undefined;
    membershipType?: "closed" | "open" | undefined;
}, {
    search?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
    cursor?: number | undefined;
    user?: string | undefined;
    membershipType?: "closed" | "open" | undefined;
}>;
/**
 * Query-string schema for the GET /proposals/:daoId endpoint.
 *
 * - `status`  : filter by proposal lifecycle state (active / closed / all)
 * - `search`  : free-text substring match on proposal title stored in event data
 * - `limit`   : page size (1 – 500, default 100)
 * - `offset`  : zero-based page start
 */
export declare const proposalsQuerySchema: z.ZodObject<{
    limit: z.ZodDefault<z.ZodNumber>;
    offset: z.ZodDefault<z.ZodNumber>;
} & {
    status: z.ZodDefault<z.ZodEnum<["active", "closed", "all"]>>;
    search: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "active" | "closed" | "all";
    limit: number;
    offset: number;
    search?: string | undefined;
}, {
    status?: "active" | "closed" | "all" | undefined;
    search?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
}>;
export declare const commentCountQuerySchema: z.ZodObject<{
    limit: z.ZodDefault<z.ZodNumber>;
    offset: z.ZodDefault<z.ZodNumber>;
} & {
    types: z.ZodEffects<z.ZodOptional<z.ZodString>, string[] | null, string | undefined>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    offset: number;
    types: string[] | null;
}, {
    limit?: number | undefined;
    offset?: number | undefined;
    types?: string | undefined;
}>;
export declare const commentNonceQuerySchema: z.ZodObject<{
    commitment: z.ZodEffects<z.ZodString, string, string>;
}, "strip", z.ZodTypeAny, {
    commitment: string;
}, {
    commitment: string;
}>;
export declare const claimSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    proposalId: z.ZodNumber;
    voteNullifier: z.ZodEffects<z.ZodString, string, string>;
    claimNullifier: z.ZodEffects<z.ZodString, string, string>;
    root: z.ZodEffects<z.ZodString, string, string>;
    proof: z.ZodObject<{
        a: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
        b: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
        c: z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>;
    }, "strip", z.ZodTypeAny, {
        a: string;
        b: string;
        c: string;
    }, {
        a: string;
        b: string;
        c: string;
    }>;
}, "strip", z.ZodTypeAny, {
    proof: {
        a: string;
        b: string;
        c: string;
    };
    daoId: number;
    proposalId: number;
    root: string;
    voteNullifier: string;
    claimNullifier: string;
}, {
    proof: {
        a: string;
        b: string;
        c: string;
    };
    daoId: number;
    proposalId: number;
    root: string;
    voteNullifier: string;
    claimNullifier: string;
}>;
export type ClaimRequest = z.infer<typeof claimSchema>;
export declare const bridgeVoteSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    proposalId: z.ZodNumber;
    voteChoice: z.ZodNumber;
    nullifier: z.ZodString;
    voteRoot: z.ZodString;
    sbtRoot: z.ZodString;
    proof: z.ZodObject<{
        a: z.ZodString;
        b: z.ZodString;
        c: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        a: string;
        b: string;
        c: string;
    }, {
        a: string;
        b: string;
        c: string;
    }>;
}, "strip", z.ZodTypeAny, {
    proof: {
        a: string;
        b: string;
        c: string;
    };
    nullifier: string;
    daoId: number;
    proposalId: number;
    voteChoice: number;
    voteRoot: string;
    sbtRoot: string;
}, {
    proof: {
        a: string;
        b: string;
        c: string;
    };
    nullifier: string;
    daoId: number;
    proposalId: number;
    voteChoice: number;
    voteRoot: string;
    sbtRoot: string;
}>;
export type BridgeVoteRequest = z.infer<typeof bridgeVoteSchema>;
export declare const circuitParamsSchema: z.ZodObject<{
    dao: z.ZodPipeline<z.ZodString, z.ZodNumber>;
    type: z.ZodEnum<["comment", "vote"]>;
}, "strip", z.ZodTypeAny, {
    type: "vote" | "comment";
    dao: number;
}, {
    type: "vote" | "comment";
    dao: string;
}>;
export declare const createTokenSchema: z.ZodObject<{
    clientId: z.ZodString;
    description: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    lifetimeMs: z.ZodNullable<z.ZodOptional<z.ZodNumber>>;
}, "strip", z.ZodTypeAny, {
    clientId: string;
    description?: string | null | undefined;
    lifetimeMs?: number | null | undefined;
}, {
    clientId: string;
    description?: string | null | undefined;
    lifetimeMs?: number | null | undefined;
}>;
export type CreateTokenRequest = z.infer<typeof createTokenSchema>;
export declare const tokenIdSchema: z.ZodObject<{
    tokenId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    tokenId: string;
}, {
    tokenId: string;
}>;
export type TokenIdParams = z.infer<typeof tokenIdSchema>;
export declare const clientIdQuerySchema: z.ZodObject<{
    clientId: z.ZodOptional<z.ZodString>;
    activeOnly: z.ZodEffects<z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodBoolean]>>, boolean, string | boolean | undefined>;
}, "strip", z.ZodTypeAny, {
    activeOnly: boolean;
    clientId?: string | undefined;
}, {
    clientId?: string | undefined;
    activeOnly?: string | boolean | undefined;
}>;
export declare const auditQuerySchema: z.ZodObject<{
    tokenId: z.ZodOptional<z.ZodString>;
    clientId: z.ZodOptional<z.ZodString>;
    action: z.ZodOptional<z.ZodString>;
    limit: z.ZodEffects<z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodNumber]>>, number, string | number | undefined>;
    offset: z.ZodEffects<z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodNumber]>>, number, string | number | undefined>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    offset: number;
    action?: string | undefined;
    tokenId?: string | undefined;
    clientId?: string | undefined;
}, {
    action?: string | undefined;
    limit?: string | number | undefined;
    offset?: string | number | undefined;
    tokenId?: string | undefined;
    clientId?: string | undefined;
}>;
export declare const didAttributeClaimSchema: z.ZodObject<{
    claim: z.ZodObject<{
        issuer: z.ZodString;
        subjectDid: z.ZodString;
        attributeKey: z.ZodString;
        attributeValue: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        signature: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        signature: string;
        expiresAt: number;
        issuer: string;
        subjectDid: string;
        attributeKey: string;
        attributeValue: number;
        issuedAt: number;
    }, {
        signature: string;
        expiresAt: number;
        issuer: string;
        subjectDid: string;
        attributeKey: string;
        attributeValue: number;
        issuedAt: number;
    }>;
    minAttributeValue: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    claim: {
        signature: string;
        expiresAt: number;
        issuer: string;
        subjectDid: string;
        attributeKey: string;
        attributeValue: number;
        issuedAt: number;
    };
    minAttributeValue: number;
}, {
    claim: {
        signature: string;
        expiresAt: number;
        issuer: string;
        subjectDid: string;
        attributeKey: string;
        attributeValue: number;
        issuedAt: number;
    };
    minAttributeValue: number;
}>;
export type DidAttributeClaimRequest = z.infer<typeof didAttributeClaimSchema>;
/**
 * Max quadratic voting constants. Must match circuits/quadratic_vote_main.circom
 * and the voting contract's MAX_QV_BUDGET.
 */
export declare const QV_MAX_BUDGET = 100;
export declare const QV_MAX_CREDITS = 10;
export declare const qvAllocationSchema: z.ZodObject<{
    proposalId: z.ZodNumber;
    voiceCredits: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    proposalId: number;
    voiceCredits: number;
}, {
    proposalId: number;
    voiceCredits: number;
}>;
export declare const qvCalculateSchema: z.ZodObject<{
    allocations: z.ZodArray<z.ZodObject<{
        proposalId: z.ZodNumber;
        voiceCredits: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        proposalId: number;
        voiceCredits: number;
    }, {
        proposalId: number;
        voiceCredits: number;
    }>, "many">;
    budget: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    allocations: {
        proposalId: number;
        voiceCredits: number;
    }[];
    budget?: number | undefined;
}, {
    allocations: {
        proposalId: number;
        voiceCredits: number;
    }[];
    budget?: number | undefined;
}>;
export type QvCalculateRequest = z.infer<typeof qvCalculateSchema>;
export declare const qvTallySchema: z.ZodObject<{
    ballots: z.ZodArray<z.ZodObject<{
        allocations: z.ZodArray<z.ZodObject<{
            proposalId: z.ZodNumber;
            voiceCredits: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            proposalId: number;
            voiceCredits: number;
        }, {
            proposalId: number;
            voiceCredits: number;
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        allocations: {
            proposalId: number;
            voiceCredits: number;
        }[];
    }, {
        allocations: {
            proposalId: number;
            voiceCredits: number;
        }[];
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    ballots: {
        allocations: {
            proposalId: number;
            voiceCredits: number;
        }[];
    }[];
}, {
    ballots: {
        allocations: {
            proposalId: number;
            voiceCredits: number;
        }[];
    }[];
}>;
export type QvTallyRequest = z.infer<typeof qvTallySchema>;
export declare const qvParamsSchema: z.ZodObject<{
    dao: z.ZodString;
}, "strip", z.ZodTypeAny, {
    dao: string;
}, {
    dao: string;
}>;
export declare const novaWitnessSchema: z.ZodObject<{
    secret: z.ZodString;
    salt: z.ZodString;
    path_elements: z.ZodArray<z.ZodString, "many">;
    path_indices: z.ZodArray<z.ZodNumber, "many">;
    vote_choice: z.ZodNumber;
    nullifier: z.ZodString;
    dao_id: z.ZodNumber;
    proposal_id: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    nullifier: string;
    secret: string;
    dao_id: number;
    proposal_id: number;
    salt: string;
    path_elements: string[];
    path_indices: number[];
    vote_choice: number;
}, {
    nullifier: string;
    secret: string;
    dao_id: number;
    proposal_id: number;
    salt: string;
    path_elements: string[];
    path_indices: number[];
    vote_choice: number;
}>;
export declare const novaAggregateSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    proposalId: z.ZodNumber;
    root: z.ZodOptional<z.ZodString>;
    witnesses: z.ZodArray<z.ZodObject<{
        secret: z.ZodString;
        salt: z.ZodString;
        path_elements: z.ZodArray<z.ZodString, "many">;
        path_indices: z.ZodArray<z.ZodNumber, "many">;
        vote_choice: z.ZodNumber;
        nullifier: z.ZodString;
        dao_id: z.ZodNumber;
        proposal_id: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        nullifier: string;
        secret: string;
        dao_id: number;
        proposal_id: number;
        salt: string;
        path_elements: string[];
        path_indices: number[];
        vote_choice: number;
    }, {
        nullifier: string;
        secret: string;
        dao_id: number;
        proposal_id: number;
        salt: string;
        path_elements: string[];
        path_indices: number[];
        vote_choice: number;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    daoId: number;
    proposalId: number;
    witnesses: {
        nullifier: string;
        secret: string;
        dao_id: number;
        proposal_id: number;
        salt: string;
        path_elements: string[];
        path_indices: number[];
        vote_choice: number;
    }[];
    root?: string | undefined;
}, {
    daoId: number;
    proposalId: number;
    witnesses: {
        nullifier: string;
        secret: string;
        dao_id: number;
        proposal_id: number;
        salt: string;
        path_elements: string[];
        path_indices: number[];
        vote_choice: number;
    }[];
    root?: string | undefined;
}>;
export type NovaAggregateRequest = z.infer<typeof novaAggregateSchema>;
export declare const ciphertextSchema: z.ZodObject<{
    c1: z.ZodString;
    c2: z.ZodString;
}, "strip", z.ZodTypeAny, {
    c1: string;
    c2: string;
}, {
    c1: string;
    c2: string;
}>;
export declare const thresholdInitSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    proposalId: z.ZodNumber;
    thresholdN: z.ZodNumber;
    thresholdT: z.ZodNumber;
    creator: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    daoId: number;
    proposalId: number;
    thresholdN: number;
    thresholdT: number;
    creator?: string | undefined;
}, {
    daoId: number;
    proposalId: number;
    thresholdN: number;
    thresholdT: number;
    creator?: string | undefined;
}>;
export type ThresholdInitRequest = z.infer<typeof thresholdInitSchema>;
export declare const thresholdAuthorityRegisterSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    proposalId: z.ZodNumber;
    authorityAddress: z.ZodString;
    authorityName: z.ZodString;
    verifierId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    daoId: number;
    proposalId: number;
    authorityAddress: string;
    authorityName: string;
    verifierId: string;
}, {
    daoId: number;
    proposalId: number;
    authorityAddress: string;
    authorityName: string;
    verifierId: string;
}>;
export type ThresholdAuthorityRegisterRequest = z.infer<typeof thresholdAuthorityRegisterSchema>;
export declare const thresholdFinalizeSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    proposalId: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    daoId: number;
    proposalId: number;
}, {
    daoId: number;
    proposalId: number;
}>;
export type ThresholdFinalizeRequest = z.infer<typeof thresholdFinalizeSchema>;
export declare const thresholdEncryptSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    proposalId: z.ZodNumber;
    voteChoice: z.ZodNumber;
    voterNullifier: z.ZodString;
}, "strip", z.ZodTypeAny, {
    daoId: number;
    proposalId: number;
    voteChoice: number;
    voterNullifier: string;
}, {
    daoId: number;
    proposalId: number;
    voteChoice: number;
    voterNullifier: string;
}>;
export type ThresholdEncryptRequest = z.infer<typeof thresholdEncryptSchema>;
export declare const thresholdTallyComputeSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    proposalId: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    daoId: number;
    proposalId: number;
}, {
    daoId: number;
    proposalId: number;
}>;
export type ThresholdTallyComputeRequest = z.infer<typeof thresholdTallyComputeSchema>;
export declare const thresholdDecryptShareSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    proposalId: z.ZodNumber;
    authorityAddress: z.ZodString;
    privateKeyShare: z.ZodString;
    encryptedTally: z.ZodObject<{
        c1: z.ZodString;
        c2: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        c1: string;
        c2: string;
    }, {
        c1: string;
        c2: string;
    }>;
}, "strip", z.ZodTypeAny, {
    daoId: number;
    proposalId: number;
    authorityAddress: string;
    privateKeyShare: string;
    encryptedTally: {
        c1: string;
        c2: string;
    };
}, {
    daoId: number;
    proposalId: number;
    authorityAddress: string;
    privateKeyShare: string;
    encryptedTally: {
        c1: string;
        c2: string;
    };
}>;
export type ThresholdDecryptShareRequest = z.infer<typeof thresholdDecryptShareSchema>;
export declare const thresholdTallyDecryptSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    proposalId: z.ZodNumber;
    encryptedTally: z.ZodObject<{
        c1: z.ZodString;
        c2: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        c1: string;
        c2: string;
    }, {
        c1: string;
        c2: string;
    }>;
}, "strip", z.ZodTypeAny, {
    daoId: number;
    proposalId: number;
    encryptedTally: {
        c1: string;
        c2: string;
    };
}, {
    daoId: number;
    proposalId: number;
    encryptedTally: {
        c1: string;
        c2: string;
    };
}>;
export type ThresholdTallyDecryptRequest = z.infer<typeof thresholdTallyDecryptSchema>;
export declare const thresholdStateParamsSchema: z.ZodObject<{
    daoId: z.ZodPipeline<z.ZodString, z.ZodNumber>;
    proposalId: z.ZodPipeline<z.ZodString, z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    daoId: number;
    proposalId: number;
}, {
    daoId: string;
    proposalId: string;
}>;
export declare const adminShutdownSchema: z.ZodObject<{
    reason: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    reason?: string | undefined;
}, {
    reason?: string | undefined;
}>;
export declare const adminAuditLogQuerySchema: z.ZodObject<{
    limit: z.ZodDefault<z.ZodNumber>;
    offset: z.ZodDefault<z.ZodNumber>;
    action: z.ZodOptional<z.ZodString>;
    format: z.ZodDefault<z.ZodEnum<["json", "cef"]>>;
    verify: z.ZodOptional<z.ZodEnum<["true", "false"]>>;
}, "strip", z.ZodTypeAny, {
    format: "json" | "cef";
    limit: number;
    offset: number;
    action?: string | undefined;
    verify?: "true" | "false" | undefined;
}, {
    format?: "json" | "cef" | undefined;
    action?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
    verify?: "true" | "false" | undefined;
}>;
export declare const adminSbtTransferAttemptsQuerySchema: z.ZodObject<{
    daoId: z.ZodNumber;
    limit: z.ZodDefault<z.ZodNumber>;
    offset: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    daoId: number;
    limit: number;
    offset: number;
}, {
    daoId: number;
    limit?: number | undefined;
    offset?: number | undefined;
}>;
export declare const adminRelayerRotateSchema: z.ZodObject<{
    targetKeyId: z.ZodOptional<z.ZodString>;
    targetPublicKey: z.ZodOptional<z.ZodString>;
    reason: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    reason?: string | undefined;
    targetKeyId?: string | undefined;
    targetPublicKey?: string | undefined;
}, {
    reason?: string | undefined;
    targetKeyId?: string | undefined;
    targetPublicKey?: string | undefined;
}>;
export declare const adminRelayerRegisterKeySchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
    secretKey: z.ZodOptional<z.ZodString>;
    publicKey: z.ZodOptional<z.ZodString>;
    signerType: z.ZodDefault<z.ZodEnum<["local", "aws_kms", "gcp_kms", "pkcs11", "test"]>>;
    kmsKeyId: z.ZodOptional<z.ZodString>;
    kmsRegion: z.ZodOptional<z.ZodString>;
    role: z.ZodDefault<z.ZodEnum<["primary", "secondary", "standby"]>>;
    makeActive: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    role: "primary" | "secondary" | "standby";
    signerType: "test" | "local" | "aws_kms" | "gcp_kms" | "pkcs11";
    makeActive: boolean;
    id?: string | undefined;
    publicKey?: string | undefined;
    secretKey?: string | undefined;
    kmsKeyId?: string | undefined;
    kmsRegion?: string | undefined;
}, {
    role?: "primary" | "secondary" | "standby" | undefined;
    id?: string | undefined;
    publicKey?: string | undefined;
    secretKey?: string | undefined;
    signerType?: "test" | "local" | "aws_kms" | "gcp_kms" | "pkcs11" | undefined;
    kmsKeyId?: string | undefined;
    kmsRegion?: string | undefined;
    makeActive?: boolean | undefined;
}>;
export declare const adminRelayerGenerateKeySchema: z.ZodObject<{
    role: z.ZodDefault<z.ZodEnum<["primary", "secondary", "standby"]>>;
    makeActive: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    role: "primary" | "secondary" | "standby";
    makeActive: boolean;
}, {
    role?: "primary" | "secondary" | "standby" | undefined;
    makeActive?: boolean | undefined;
}>;
export declare const adminRelayerFundKeySchema: z.ZodObject<{
    publicKey: z.ZodString;
    friendbotUrl: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    publicKey: string;
    friendbotUrl?: string | undefined;
}, {
    publicKey: string;
    friendbotUrl?: string | undefined;
}>;
export declare const remediationHistoryQuerySchema: z.ZodObject<{
    limit: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    limit: number;
}, {
    limit?: number | undefined;
}>;
//# sourceMappingURL=schemas.d.ts.map