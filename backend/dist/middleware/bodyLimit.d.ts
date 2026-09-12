/**
 * Per-Route Body Size Limit
 *
 * express.json({ limit }) only accepts one global limit. This factory lets
 * each route apply a limit sized to its actual payload (#69) instead of
 * sharing one size across every endpoint, which either over-permits small
 * endpoints or under-permits large ones.
 */
import { type RequestHandler } from "express";
/**
 * Returns an `express.json()` middleware capped at `limit` (e.g. "5kb").
 * Oversized payloads are rejected by express.json's own 413 handling; this
 * wrapper additionally logs the rejection for observability.
 */
export declare function bodyLimit(limit: string): RequestHandler;
/**
 * Per-Upload Memory Limit
 *
 * Wraps Multer with memory storage and a fixed per-route file size limit (in
 * bytes) to prevent memory exhaustion. The in-memory buffer also enables
 * downstream magic-byte, dimension, EXIF, and malware validation.
 */
export declare function uploadLimit(limit: number): RequestHandler;
//# sourceMappingURL=bodyLimit.d.ts.map