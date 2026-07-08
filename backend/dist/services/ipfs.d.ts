/**
 * IPFS/Pinata Integration Module (SDK v2.5.1)
 *
 * Handles pinning and fetching content from IPFS via Pinata.
 * Also propagates content to public IPFS gateways for redundancy.
 */
export interface PinResult {
    cid: string;
    size: number;
    publicUrl: string;
}
export interface FetchResult {
    data: unknown;
    contentType: string;
}
export interface RawFetchResult {
    buffer: Buffer;
    contentType: string;
}
export interface PublicUrls {
    primary: string;
    fallbacks: string[];
}
interface MetadataSchema {
    requiredFields: string[];
    maxBodyLength: number;
    allowedVersions: number[];
}
export interface MetadataValidationResult {
    valid: boolean;
    error?: string;
}
export declare const MAX_JSON_SIZE: number;
export declare const MAX_RAW_SIZE: number;
export declare const PROPOSAL_METADATA_SCHEMA: MetadataSchema;
export declare const COMMENT_METADATA_SCHEMA: MetadataSchema;
/**
 * Sanitize string content to prevent XSS
 * Removes script tags and event handlers
 */
export declare function sanitizeString(str: string): string;
/**
 * Validate metadata against a schema
 */
export declare function validateMetadataSchema(data: unknown, schema: MetadataSchema): MetadataValidationResult;
/**
 * Sanitize metadata object recursively
 */
export declare function sanitizeMetadata<T>(data: T): T;
/**
 * Initialize the Pinata client (SDK v2.x)
 */
export declare function initPinata(jwt: string, gateway?: string): void;
/**
 * Pin JSON data to public IPFS (SDK v2.x)
 */
export declare function pinJSON(data: Record<string, unknown>, name?: string): Promise<PinResult>;
/**
 * Pin a file (image) to public IPFS (SDK v2.x)
 */
export declare function pinFile(buffer: Buffer, filename: string, mimeType: string): Promise<PinResult>;
/**
 * Validate CID format (CIDv0 or CIDv1)
 */
export declare function isValidCid(cid: string): boolean;
/**
 * Fetch content from IPFS via Pinata gateway
 */
export declare function fetchContent(cid: string): Promise<FetchResult>;
/**
 * Fetch raw content (e.g., image) from IPFS via Pinata gateway
 * Returns the raw buffer and content type for binary data
 */
export declare function fetchRawContent(cid: string): Promise<RawFetchResult>;
/**
 * Check if Pinata is initialized and healthy (SDK v2.x)
 */
export declare function isHealthy(): Promise<boolean>;
/**
 * Get public gateway URLs for a CID
 * These URLs are accessible without authentication and provide redundancy.
 */
export declare function getPublicUrls(cid: string): PublicUrls;
/**
 * Manually trigger propagation of a CID to public gateways
 * Use this to ensure older content is propagated.
 */
export declare function ensurePublicAvailability(cid: string): void;
export {};
//# sourceMappingURL=ipfs.d.ts.map