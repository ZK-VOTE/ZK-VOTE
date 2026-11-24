/**
 * Magic byte detection for image uploads.
 * Provides MIME detection, dimension extraction, and basic polyglot/script checks.
 */
export declare function detectMimeType(buffer: Buffer): string | null;
/**
 * Extract image dimensions from the buffer for JPEG/PNG/GIF/WebP/BMP.
 * Returns null if dimensions cannot be determined or format is unsupported.
 */
export declare function getImageDimensions(buffer: Buffer): {
    width: number;
    height: number;
} | null;
/**
 * Detect whether the buffer appears to contain multiple image format signatures.
 */
export declare function isPolyglot(buffer: Buffer): boolean;
/**
 * Heuristic scan for embedded scripts or executable content in the first 4KB.
 */
export declare function containsEmbeddedScript(buffer: Buffer): boolean;
/**
 * Validation TOCTOU lock to ensure file validation, sanitization, and Pinata pinning
 * execute as an atomic, serialized unit without allowing concurrent buffer modification
 * or swapped file race conditions.
 */
export declare class ValidationLockManager {
    private activeLocks;
    acquire<T>(key: string, fn: () => Promise<T>): Promise<T>;
    isLocked(key: string): boolean;
}
export declare const validationLock: ValidationLockManager;
//# sourceMappingURL=magic-bytes.d.ts.map