/**
 * Scoped relay session tokens and encrypted relay metadata support.
 *
 * The relay is assumed to be honest-but-curious, so the session token must be
 * short-lived and bound to a specific DAO scope. Each token includes an Ed25519
 * signature over its payload so the relay can authenticate a client without
 * trusting a static shared secret alone.
 */
export interface RelaySessionCapability {
    daoId?: number;
    actions?: string[];
    nonce?: string;
    issuedAt?: number;
    expiresAt?: number;
    scope?: string;
}
export interface RelaySessionTokenPayload {
    jti: string;
    clientId: string;
    daoId?: number;
    nonce: string;
    issuedAt: number;
    expiresAt: number;
    capabilities: string[];
    publicKeyPem: string;
}
export declare function createSignedSessionToken(clientId: string, privateKeyPem: string, options?: {
    daoId?: number;
    nonce?: string;
    capabilities?: string[];
    ttlMs?: number;
}): string;
export declare function verifySignedSessionToken(sessionToken: string, expectedDaoId?: number): {
    valid: boolean;
    clientId?: string;
    daoId?: number;
    tokenId?: string;
    reason?: string;
};
export declare function getDefaultSessionSigningKey(): string | null;
export declare function generateSessionSigningKeyPair(): {
    privateKeyPem: string;
    publicKeyPem: string;
};
//# sourceMappingURL=relaySessions.d.ts.map