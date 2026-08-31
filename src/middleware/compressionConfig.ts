/**
 * compressionConfig.ts
 * -----------------------------------------------------------------------
 * Configuration for issue #186: API Response Compression and Optimization.
 * -----------------------------------------------------------------------
 */

/** Minimum response size (bytes) before compression is applied. */
export const COMPRESSION_THRESHOLD_BYTES = 1024; // 1KB

/**
 * Paths excluded from compression entirely -- primarily already-compressed
 * binary content (IPFS images) where re-compressing wastes CPU for no gain.
 */
export const EXCLUDED_PATH_PATTERNS: RegExp[] = [
  /^\/ipfs\/image\/[^/]+$/,
  /^\/ipfs\/(file|blob)\/[^/]+$/,
];

export function isExcludedPath(path: string): boolean {
  return EXCLUDED_PATH_PATTERNS.some((p) => p.test(path));
}

/** Content-Types we should never try to compress even if path isn't excluded. */
export const EXCLUDED_CONTENT_TYPE_PATTERNS: RegExp[] = [
  /^image\//,
  /^video\//,
  /^audio\//,
  /^application\/zip/,
  /^application\/gzip/,
  /^application\/x-brotli/,
];

export function isExcludedContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return EXCLUDED_CONTENT_TYPE_PATTERNS.some((p) => p.test(contentType));
}

export type SupportedEncoding = "br" | "gzip" | "deflate" | "identity";

/**
 * Parses an `Accept-Encoding` header and returns the best supported
 * encoding, preferring brotli (better ratio) over gzip over deflate.
 * Honors q=0 exclusions per RFC 7231 §5.3.4.
 */
export function negotiateEncoding(acceptEncodingHeader: string | undefined): SupportedEncoding {
  if (!acceptEncodingHeader) return "identity";

  const entries = acceptEncodingHeader
    .split(",")
    .map((part) => {
      const [encRaw, qRaw] = part.trim().split(";q=");
      const enc = encRaw.trim().toLowerCase();
      const q = qRaw !== undefined ? parseFloat(qRaw) : 1;
      return { enc, q: Number.isNaN(q) ? 1 : q };
    })
    .filter((e) => e.q > 0);

  const accepts = (name: string) =>
    entries.some((e) => e.enc === name) || entries.some((e) => e.enc === "*");

  const isRejected = (name: string) =>
    entries.some((e) => e.enc === name && e.q === 0);

  if (!isRejected("br") && accepts("br")) return "br";
  if (!isRejected("gzip") && accepts("gzip")) return "gzip";
  if (!isRejected("deflate") && accepts("deflate")) return "deflate";
  return "identity";
}
