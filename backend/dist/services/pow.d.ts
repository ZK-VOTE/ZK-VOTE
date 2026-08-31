export interface PowChallenge {
    serverId: string;
    commitment: string;
    difficulty: number;
    createdAt: number;
    expiresAt: number;
    consumed: boolean;
}
export interface PowConfig {
    difficulty: number;
    challengeTtlMs: number;
}
export declare function generateChallenge(commitment: string, config: PowConfig): PowChallenge;
export declare function verifyChallenge(serverId: string, commitment: string, workNonce: string, config: PowConfig): {
    valid: boolean;
    reason?: string;
};
export declare function cleanupExpiredChallenges(): void;
export declare function getChallengeCount(): number;
//# sourceMappingURL=pow.d.ts.map