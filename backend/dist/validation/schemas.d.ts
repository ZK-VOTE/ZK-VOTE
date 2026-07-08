/**
 * Zod Validation Schemas
 *
 * Type-safe request validation for all API endpoints.
 * Includes BN254 field validation for ZK proof inputs.
 */
import { z } from "zod";
/**
 * Stellar contract ID validator
 */
export declare const contractAddress: z.ZodString;
export declare const voteSchema: z.ZodObject<{
    daoId: z.ZodNumber;
    proposalId: z.ZodNumber;
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
    daoId: number;
    proposalId: number;
    choice: boolean;
    root: string;
}, {
    proof: {
        a: string;
        b: string;
        c: string;
    };
    nullifier: string;
    daoId: number;
    proposalId: number;
    choice: boolean;
    root: string;
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
export declare const paginationSchema: z.ZodObject<{
    limit: z.ZodDefault<z.ZodNumber>;
    offset: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    offset: number;
}, {
    limit?: number | undefined;
    offset?: number | undefined;
}>;
export declare const eventsQuerySchema: z.ZodObject<{
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
export declare const daosQuerySchema: z.ZodObject<{
    user: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    user?: string | undefined;
}, {
    user?: string | undefined;
}>;
//# sourceMappingURL=schemas.d.ts.map