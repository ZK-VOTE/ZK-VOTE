/**
 * Zod Validation Schemas
 *
 * Type-safe request validation for all API endpoints.
 * Includes BN254 field validation for ZK proof inputs.
 */
import { z } from "zod";
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
    daoId: number;
    proposalId: number;
    nullifier: string;
}, {
    daoId: string;
    proposalId: string;
    nullifier: string;
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
 * Stellar contract ID validator
 */
export declare const contractAddress: z.ZodString;
export declare const commitSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    proposalId: z.ZodNumber;
    nullifier: z.ZodEffects<z.ZodString, string, string>;
    commitmentHash: z.ZodEffects<z.ZodString, string, string>;
    timestamp: z.ZodNumber;
    walletAddress: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    daoId: number;
    proposalId: number;
    nullifier: string;
    timestamp: number;
    commitmentHash: string;
    walletAddress?: string | undefined;
}, {
    daoId: number;
    proposalId: number;
    nullifier: string;
    timestamp: number;
    commitmentHash: string;
    walletAddress?: string | undefined;
}>;
export type CommitRequest = z.infer<typeof commitSchema>;
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
}, "strip", z.ZodTypeAny, {
    daoId: number;
    proposalId: number;
    choice: boolean;
    nullifier?: string | undefined;
    root?: string | undefined;
    proof?: {
        a: string;
        b: string;
        c: string;
    } | undefined;
    timestamp?: number | undefined;
    walletAddress?: string | undefined;
    nonce?: string | undefined;
    encryptedPayload?: string | Record<string, unknown> | undefined;
    voterPublicKey?: string | undefined;
    voterSignature?: string | undefined;
}, {
    daoId: number;
    proposalId: number;
    choice: boolean;
    nullifier?: string | undefined;
    root?: string | undefined;
    proof?: {
        a: string;
        b: string;
        c: string;
    } | undefined;
    timestamp?: number | undefined;
    walletAddress?: string | undefined;
    nonce?: string | undefined;
    encryptedPayload?: string | Record<string, unknown> | undefined;
    voterPublicKey?: string | undefined;
    voterSignature?: string | undefined;
}>, {
    daoId: number;
    proposalId: number;
    choice: boolean;
    nullifier?: string | undefined;
    root?: string | undefined;
    proof?: {
        a: string;
        b: string;
        c: string;
    } | undefined;
    timestamp?: number | undefined;
    walletAddress?: string | undefined;
    nonce?: string | undefined;
    encryptedPayload?: string | Record<string, unknown> | undefined;
    voterPublicKey?: string | undefined;
    voterSignature?: string | undefined;
}, {
    daoId: number;
    proposalId: number;
    choice: boolean;
    nullifier?: string | undefined;
    root?: string | undefined;
    proof?: {
        a: string;
        b: string;
        c: string;
    } | undefined;
    timestamp?: number | undefined;
    walletAddress?: string | undefined;
    nonce?: string | undefined;
    encryptedPayload?: string | Record<string, unknown> | undefined;
    voterPublicKey?: string | undefined;
    voterSignature?: string | undefined;
}>;
export type VoteRequest = z.infer<typeof voteSchema>;
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
    daoId: number;
    proposalId: number;
    nullifier: string;
    root: string;
    proof: {
        a: string;
        b: string;
        c: string;
    };
    contentCid: string;
    voteChoice: boolean;
    parentId?: number | null | undefined;
    serverId?: string | undefined;
    workNonce?: string | undefined;
}, {
    daoId: number;
    proposalId: number;
    nullifier: string;
    root: string;
    proof: {
        a: string;
        b: string;
        c: string;
    };
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
    commentId: number;
    serverId: string;
    workNonce: string;
    flaggerCommitment: string;
    flaggerNullifier: string;
}, {
    daoId: number;
    proposalId: number;
    commentId: number;
    serverId: string;
    workNonce: string;
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
    cursor: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    offset: number;
    cursor?: number | undefined;
    user?: string | undefined;
}, {
    limit?: number | undefined;
    offset?: number | undefined;
    cursor?: number | undefined;
    user?: string | undefined;
}>, {
    offset: number;
    limit: number;
    user?: string | undefined;
}, {
    limit?: number | undefined;
    offset?: number | undefined;
    cursor?: number | undefined;
    user?: string | undefined;
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
    daoId: number;
    proposalId: number;
    root: string;
    proof: {
        a: string;
        b: string;
        c: string;
    };
    voteNullifier: string;
    claimNullifier: string;
}, {
    daoId: number;
    proposalId: number;
    root: string;
    proof: {
        a: string;
        b: string;
        c: string;
    };
    voteNullifier: string;
    claimNullifier: string;
}>;
export type ClaimRequest = z.infer<typeof claimSchema>;
//# sourceMappingURL=schemas.d.ts.map