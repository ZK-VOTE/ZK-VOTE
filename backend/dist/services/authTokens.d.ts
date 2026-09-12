/**
 * Auth Token Management Service
 *
 * Handles generation, validation, rotation, and lifecycle management for
 * per-client authentication tokens with secure hashing.
 */
import { type AuthToken, type AuthTokenAuditEntry } from "./db.js";
export interface GeneratedToken {
    id: string;
    rawToken: string;
    clientId: string;
    description: string | null;
    expiresAt: string | null;
}
export declare function generateSecureToken(byteLength?: number): string;
export declare function createTokenRecord(params: {
    clientId: string;
    description?: string | null;
    lifetimeMs?: number | null;
    rotationGroupId?: string | null;
    isLegacy?: boolean;
}): GeneratedToken;
export declare function migrateLegacyToken(): void;
export interface TokenValidationResult {
    valid: boolean;
    token?: AuthToken;
    reason?: string;
}
export declare function validateToken(rawToken: string): TokenValidationResult;
export declare function markTokenUsed(tokenId: string, ipHash: string | null): void;
export declare function createNewToken(params: {
    clientId: string;
    description?: string | null;
    lifetimeMs?: number | null;
}): GeneratedToken;
export declare function revokeToken(tokenId: string, revokedByClientId?: string): boolean;
export declare function listTokens(): AuthToken[];
export declare function listActiveTokens(): AuthToken[];
export declare function listTokensForClient(clientId: string): AuthToken[];
export declare function getToken(tokenId: string): AuthToken | null;
export declare function rotateSingleToken(oldToken: AuthToken): GeneratedToken | null;
export declare function runTokenRotation(): Array<{
    oldTokenId: string;
    newTokenId: string;
    clientId: string;
    rawToken?: string;
}>;
export declare function runMaintenanceTasks(): {
    expiredCount: number;
    cleanedTokens: number;
    cleanedAuditEntries: number;
    rotatedCount: number;
};
export declare function getAllValidTokenHashes(): Set<string>;
export declare function findTokenByRaw(rawToken: string): AuthToken | null;
export declare function getAuditEntries(options?: {
    tokenId?: string;
    clientId?: string;
    action?: string;
    limit?: number;
    offset?: number;
}): AuthTokenAuditEntry[];
export declare function logAuthAttempt(params: {
    tokenId?: string | null;
    clientId?: string | null;
    action: string;
    path?: string | null;
    method?: string | null;
    ipHash?: string | null;
    success: boolean;
    errorMessage?: string | null;
}): void;
export declare const CREDENTIAL_REQUEST_RATE_LIMIT = 3;
export declare const CREDENTIAL_REQUEST_WINDOW_MS: number;
export declare const CREDENTIAL_ISSUANCE_REQUEST_ACTION = "credential_issuance_requested";
export declare function validateTokenForCredentialIssuance(rawToken: string): TokenValidationResult;
/** Revokes a token after successful credential issuance to enforce one-credential-per-voter. */
export declare function revokeTokenAfterCredentialIssuance(tokenId: string): boolean;
export declare function validateMasterKey(rawKey: string): boolean;
//# sourceMappingURL=authTokens.d.ts.map