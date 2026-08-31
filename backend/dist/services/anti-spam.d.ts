export interface FlagResult {
    success: boolean;
    hidden: boolean;
    flagCount: number;
    threshold: number;
}
export interface FlagStatus {
    flagged: boolean;
    hidden: boolean;
    flagCount: number;
}
export declare function checkCommitmentRateLimit(commitment: string, daoId: number, proposalId: number, maxPerWindow: number, windowMs: number): boolean;
export declare function recordCommentSubmission(commitment: string, daoId: number, proposalId: number, windowMs: number): void;
export declare function flagComment(commentId: number, daoId: number, proposalId: number, flaggerCommitment: string, flaggerNullifier: string, threshold: number): FlagResult;
export declare function getFlagStatus(commentId: number, daoId: number, proposalId: number): FlagStatus;
export declare function getHiddenCommentIds(daoId: number, proposalId: number): number[];
//# sourceMappingURL=anti-spam.d.ts.map