/**
 * IPFS/Pinata Integration Module (SDK v2.5.1)
 *
 * Handles pinning and fetching content from IPFS via Pinata.
 * Also propagates content to public IPFS gateways for redundancy.
 * Integrates with the Pin Manager for backup, redundancy, and verification.
 */
import { type MonitorStatus } from "./ipfs-monitor.js";
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
 * Maximum nesting depth accepted by sanitizeMetadata. Subtrees deeper than
 * this are truncated to `null` so pathological payloads (JSON depth bombs)
 * cannot exhaust the call stack or pin CPU (DoS hardening).
 */
export declare const MAX_METADATA_DEPTH = 32;
/**
 * Maximum rounds the string cleaner runs while looking for a fixed point.
 * Bounded so adversarial inputs cannot keep re-assembling removed fragments
 * (e.g. "<scr<script>ipt>") indefinitely.
 */
export declare const MAX_SANITIZE_ROUNDS = 10;
/**
 * Maximum rounds of HTML-entity decoding (defeats double-encoded payloads
 * such as "&amp;#60;script&amp;#62;" without unbounded expansion).
 */
export declare const MAX_ENTITY_DECODE_ROUNDS = 3;
/**
 * Maximum depth for re-parsing string values that contain embedded JSON.
 * Defends against JSON injection where a later JSON.parse would revive
 * dangerous keys ("__proto__") or markup from inside a string field.
 */
export declare const MAX_EMBEDDED_JSON_DEPTH = 3;
/**
 * Sanitize string content to prevent XSS and CSS/SVG/script injection.
 *
 * The input is first canonicalized (entity decoding + NFKC + control-char
 * stripping) so Unicode confusables and encodings cannot smuggle payloads
 * past the pattern checks, then dangerous constructs are removed in a loop
 * until a fixed point is reached so nested fragments cannot re-assemble:
 *
 * - <script>/<style> elements including their contents
 * - SVG/MathML and other active-markup tags (svg, iframe, object, embed, ...)
 * - inline event handlers (onclick, onerror, ...)
 * - inline style attributes (CSS injection carrier)
 * - javascript:/vbscript:/livescript:/mocha: URL schemes
 * - data: URLs with script-capable mediatypes (text/html, image/svg+xml, ...)
 * - CSS expression(), import directives, behavior and binding constructs
 *
 * Benign markup and text are preserved unchanged.
 */
export declare function sanitizeString(str: string): string;
/**
 * Validate metadata against a schema
 */
export declare function validateMetadataSchema(data: unknown, schema: MetadataSchema): MetadataValidationResult;
/**
 * Sanitize metadata objects recursively before pinning to IPFS.
 *
 * Beyond HTML/script stripping this defends against:
 * - Unicode confusable bypasses (fullwidth "＜script＞", zero-width joiners)
 *   via entity decoding + NFKC normalization before pattern matching
 * - JSON injection: string values containing embedded JSON documents are
 *   parsed, recursively sanitized and re-serialized so "__proto__",
 *   "constructor" and "prototype" keys cannot be revived by a later parse
 * - SVG-based XSS: <svg>/<math> and other active-markup tags plus
 *   script-capable data: URLs (e.g. data:image/svg+xml) are removed
 * - CSS injection: <style> blocks, inline style attributes, expression(),
 *   CSS import directives, behavior and binding constructs are neutralized
 *
 * Non-string scalars (numbers, booleans, null) are preserved untouched and
 * traversal is depth-capped for DoS resistance.
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
 * Validate CID format (CIDv0 or CIDv1) strictly
 */
export declare function isValidCid(cid: string): boolean;
/**
 * Sanitize CID before URL construction (reject path separators, query strings, etc.)
 */
export declare function sanitizeCid(cid: string): string;
/**
 * Check if a host or IP is in a private/internal network range
 */
export declare function isPrivateIP(host: string): boolean;
/**
 * Validate that a URL belongs to an allowed IPFS gateway and does not target private IPs
 */
export declare function isAllowedGatewayUrl(urlString: string): boolean;
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
 * Enhanced health check that includes pin verification status.
 */
export declare function getEnhancedHealth(): MonitorStatus;
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
/**
 * Re-pin callback for the pin monitor.
 * Reads content from the backup path and re-uploads to Pinata.
 */
export declare function repinCallback(backupPath: string, contentType: "json" | "file", name: string, mimeType?: string): Promise<string>;
export {};
//# sourceMappingURL=ipfs.d.ts.map