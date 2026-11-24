/**
 * #593 SBT metadata sanitized render. Never use innerHTML/dangerouslySetInnerHTML
 * with token URIs. SVG is rendered only as <img src> (no script execution);
 * URIs restricted to ipfs/https/ar schemes; XSS vectors rejected.
 */
const XSS_RE = /<\s*(script|svg|math|foreignobject|iframe|object|embed|link|style|meta)\b|on\w+\s*=|javascript\s*:|data\s*:\s*text\/html/i;

export function isSbtMetadataSafe(input: string): boolean {
  if (typeof input !== "string") return false;
  if (input.length > 200_000) return false;
  return !XSS_RE.test(input);
}

export function assertSbtMetadataSafe(input: string): void {
  if (!isSbtMetadataSafe(input)) throw new Error("SBT metadata blocked: XSS vector");
}

export function sanitizeSbtUri(uri: string): string {
  const u = uri.trim();
  if (!/^(ipfs:\/\/|https:\/\/|ar:\/\/)/i.test(u)) throw new Error("SBT URI scheme not allowed");
  assertSbtMetadataSafe(u);
  return u;
}
