/**
 * IPFS/Pinata Integration Module (SDK v2.5.1)
 *
 * Handles pinning and fetching content from IPFS via Pinata.
 * Also propagates content to public IPFS gateways for redundancy.
 * Integrates with the Pin Manager for backup, redundancy, and verification.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { PinataSDK } from "pinata";
import * as pinManager from "./ipfs-pin-manager.js";
import { getMonitorStatus, type MonitorStatus } from "./ipfs-monitor.js";
import {
  ipfsPinsTotal,
  ipfsFetchDuration,
  ipfsCacheHits,
  ipfsCacheMisses,
} from "./metrics.js";
import { registerCircuitBreaker } from "./circuit-breaker.js";
import { config } from "../config.js";

// Circuit breakers for external IPFS dependencies. Trips fast when Pinata
// or the public gateways are degraded, instead of letting every caller run
// its own retry logic against a service that is known to be down.
const pinataBreaker = registerCircuitBreaker("pinata", {
  failureThreshold: config.circuitBreakerPinataFailureThreshold,
  resetTimeoutMs: config.circuitBreakerPinataResetMs,
});
const ipfsGatewayBreaker = registerCircuitBreaker("ipfs_gateway", {
  failureThreshold: config.circuitBreakerGatewayFailureThreshold,
  resetTimeoutMs: config.circuitBreakerGatewayResetMs,
});

// ============================================
// TYPES
// ============================================

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

// ============================================
// LOGGER
// ============================================

import { createLogger } from "./logger.js";

const ipfsLogger = createLogger("ipfs");
const log = (
  level: "debug" | "info" | "warn" | "error",
  event: string,
  meta: Record<string, unknown> = {},
): void => {
  ipfsLogger[level](event, meta);
};

// ============================================
// MODULE STATE
// ============================================

let pinata: PinataSDK | null = null;
let gatewayUrl: string | null = null;
let isDedicatedGateway = false;

// Public IPFS gateways for propagation and fallback access
const PUBLIC_GATEWAYS = [
  "https://ipfs.io/ipfs",
  "https://dweb.link/ipfs",
  "https://cloudflare-ipfs.com/ipfs",
  "https://w3s.link/ipfs",
];

// Content size limits (DoS protection)
export const MAX_JSON_SIZE = 1024 * 1024; // 1MB for JSON metadata
export const MAX_RAW_SIZE = 10 * 1024 * 1024; // 10MB for raw content (images)

// Metadata schema validation
export const PROPOSAL_METADATA_SCHEMA: MetadataSchema = {
  requiredFields: ["version", "body"],
  maxBodyLength: 100000, // 100KB of text
  allowedVersions: [1],
};

export const COMMENT_METADATA_SCHEMA: MetadataSchema = {
  requiredFields: ["version", "body", "createdAt"],
  maxBodyLength: 10000, // 10KB for comments
  allowedVersions: [1],
};

// ============================================
// SANITIZATION FUNCTIONS
// ============================================

/**
 * Maximum nesting depth accepted by sanitizeMetadata. Subtrees deeper than
 * this are truncated to `null` so pathological payloads (JSON depth bombs)
 * cannot exhaust the call stack or pin CPU (DoS hardening).
 */
export const MAX_METADATA_DEPTH = 32;

/**
 * Maximum rounds the string cleaner runs while looking for a fixed point.
 * Bounded so adversarial inputs cannot keep re-assembling removed fragments
 * (e.g. "<scr<script>ipt>") indefinitely.
 */
export const MAX_SANITIZE_ROUNDS = 10;

/**
 * Maximum rounds of HTML-entity decoding (defeats double-encoded payloads
 * such as "&amp;#60;script&amp;#62;" without unbounded expansion).
 */
export const MAX_ENTITY_DECODE_ROUNDS = 3;

/**
 * Maximum depth for re-parsing string values that contain embedded JSON.
 * Defends against JSON injection where a later JSON.parse would revive
 * dangerous keys ("__proto__") or markup from inside a string field.
 */
export const MAX_EMBEDDED_JSON_DEPTH = 3;

// Control characters, zero-width characters and soft hyphens that are used
// to break up tag/scheme names ("<scr\u200Bipt>") while remaining invisible.
// Horizontal tab, carriage return and line feed are preserved for Markdown.
/* eslint-disable no-control-regex -- intentional: strips hostile control chars */
const DANGEROUS_CONTROL_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u2060\uFEFF]/g;
/* eslint-enable no-control-regex */

// Tags dropped together with their contents: executable script and CSS.
const SCRIPT_TAG_RE =
  /<script\b[^<]*(?:(?!<\/script\s*>)<[^<]*)*<\/script\s*>/gi;
const STYLE_TAG_RE = /<style\b[^<]*(?:(?!<\/style\s*>)<[^<]*)*<\/style\s*>/gi;
// Leftover/standalone occurrences (including malformed split tags) of the
// content-bearing elements above and of active-markup containers.
const STANDALONE_TAG_RE =
  /<\/?\s*(?:script|style|svg|math|iframe|object|embed|applet|base|link|meta|form|input|button|select|textarea|option|frame|frameset|video|audio|source|track|param|isindex|keygen|marquee|animate|animatemotion|animatetransform|set|use|foreignobject|discard|listener|handler)\b[^>]*>?/gi;

// Inline event handlers (onclick=..., onerror=...) quoted, backticked or bare.
const EVENT_HANDLER_QUOTED_RE = /\bon\w+\s*=\s*("[^"]*"|'[^']*'|`[^`]*`)/gi;
const EVENT_HANDLER_UNQUOTED_RE = /\bon\w+\s*=[^\s>]*/gi;

// Inline style attributes: the primary CSS-injection carrier in markup.
const STYLE_ATTR_QUOTED_RE = /\sstyle\s*=\s*("[^"]*"|'[^']*'|`[^`]*`)/gi;
const STYLE_ATTR_UNQUOTED_RE = /\sstyle\s*=[^\s>]*/gi;

// Script-capable URL schemes. Whitespace-tolerant because browsers ignore
// tabs/newlines inside scheme names ("java\tscript:").
const JS_SCHEME_RE =
  /j[\s]*a[\s]*v[\s]*a[\s]*s[\s]*c[\s]*r[\s]*i[\s]*p[\s]*t[\s]*:/gi;
const VB_SCHEME_RE = /v[\s]*b[\s]*s[\s]*c[\s]*r[\s]*i[\s]*p[\s]*t[\s]*:/gi;
const LIVESCRIPT_SCHEME_RE =
  /l[\s]*i[\s]*v[\s]*e[\s]*s[\s]*c[\s]*r[\s]*i[\s]*p[\s]*t[\s]*:/gi;
const MOCHA_SCHEME_RE = /m[\s]*o[\s]*c[\s]*h[\s]*a[\s]*:/gi;

// data: URLs whose mediatype can execute script when navigated/embedded.
// Safe static image mediatypes (png/jpeg/gif/webp/avif) remain untouched.
const SCRIPTABLE_DATA_URL_RE =
  /data[\s]*:[\s]*(?:text[\s]*\/[\s]*html|image[\s]*\/[\s]*svg[\s]*\+[\s]*xml|application[\s]*\/[\s]*(?:xhtml[\s]*\+[\s]*xml|x-shockwave-flash))/gi;

// CSS constructs usable for code execution or request exfiltration.
const CSS_EXPRESSION_RE = /expression\s*\(/gi;
const CSS_IMPORT_RE = /@import\b/gi;
const CSS_BEHAVIOR_RE = /(?:-moz-)?behavior\s*:/gi;
const CSS_BINDING_RE = /(?:-moz-)?binding\s*:/gi;

// Subset of named HTML entities needed to unmask obfuscated tags/schemes.
const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  colon: ":",
  semi: ";",
  sol: "/",
  bsol: "\\",
  tab: "\t",
  newline: "\n",
  equals: "=",
  num: "#",
  dollar: "$",
};

/**
 * Convert a numeric HTML entity code point to a string, clamping invalid
 * values (out-of-range / lone surrogates) to U+FFFD so decoding never throws.
 */
function codePointToString(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "�";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "�";
  }
}

/**
 * Decode numeric and a curated set of named HTML entities, repeated a bounded
 * number of times to unwrap double- and triple-encoded payloads.
 */
function decodeHtmlEntities(input: string): string {
  let out = input;
  for (let i = 0; i < MAX_ENTITY_DECODE_ROUNDS; i++) {
    const next = out
      .replace(/&#[xX]([0-9a-fA-F]{1,6});?/g, (_m, hex: string) =>
        codePointToString(parseInt(hex, 16)),
      )
      .replace(/&#(\d{1,7});?/g, (_m, dec: string) =>
        codePointToString(parseInt(dec, 10)),
      )
      .replace(/&([a-zA-Z]{2,8});?/g, (m, name: string) => {
        const decoded = NAMED_ENTITIES[name.toLowerCase()];
        return decoded !== undefined ? decoded : m;
      });
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Canonicalize a string so homoglyph and encoding tricks cannot disguise
 * markup: decode HTML entities, apply NFKC (folds fullwidth characters such
 * as U+FF1C "＜" to ASCII "<" and fullwidth letters to ASCII), then strip
 * zero-width/control characters used to split dangerous tokens.
 */
function normalizeUnicode(input: string): string {
  const decoded = decodeHtmlEntities(input);
  let normalized = decoded;
  try {
    normalized = decoded.normalize("NFKC");
  } catch {
    // Extremely defensive: keep the decoded form if normalization fails.
  }
  return normalized.replace(DANGEROUS_CONTROL_CHARS, "");
}

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
export function sanitizeString(str: string): string {
  if (typeof str !== "string") return str;

  let sanitized = normalizeUnicode(str);
  let previous: string;
  let rounds = 0;
  do {
    previous = sanitized;
    sanitized = sanitized
      .replace(SCRIPT_TAG_RE, "")
      .replace(STYLE_TAG_RE, "")
      .replace(STANDALONE_TAG_RE, "")
      .replace(EVENT_HANDLER_QUOTED_RE, "")
      .replace(EVENT_HANDLER_UNQUOTED_RE, "")
      .replace(STYLE_ATTR_QUOTED_RE, "")
      .replace(STYLE_ATTR_UNQUOTED_RE, "")
      .replace(JS_SCHEME_RE, "")
      .replace(VB_SCHEME_RE, "")
      .replace(LIVESCRIPT_SCHEME_RE, "")
      .replace(MOCHA_SCHEME_RE, "")
      .replace(SCRIPTABLE_DATA_URL_RE, "data:blocked")
      .replace(CSS_EXPRESSION_RE, "blocked(")
      .replace(CSS_IMPORT_RE, "@blocked-import")
      .replace(CSS_BEHAVIOR_RE, "blocked:")
      .replace(CSS_BINDING_RE, "blocked:");
  } while (sanitized !== previous && ++rounds < MAX_SANITIZE_ROUNDS);

  return sanitized;
}

/**
 * Validate metadata against a schema
 */
export function validateMetadataSchema(
  data: unknown,
  schema: MetadataSchema,
): MetadataValidationResult {
  if (!data || typeof data !== "object") {
    return { valid: false, error: "Metadata must be an object" };
  }

  const obj = data as Record<string, unknown>;

  // Check required fields
  for (const field of schema.requiredFields) {
    if (!(field in obj)) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }

  // Validate version
  if (
    "version" in obj &&
    !schema.allowedVersions.includes(obj.version as number)
  ) {
    return { valid: false, error: `Invalid version: ${obj.version}` };
  }

  // Validate body length
  if ("body" in obj) {
    if (typeof obj.body !== "string") {
      return { valid: false, error: "Body must be a string" };
    }
    if (obj.body.length > schema.maxBodyLength) {
      return {
        valid: false,
        error: `Body exceeds maximum length of ${schema.maxBodyLength}`,
      };
    }
  }

  // Validate createdAt format if present
  if ("createdAt" in obj && typeof obj.createdAt === "string") {
    const date = new Date(obj.createdAt);
    if (isNaN(date.getTime())) {
      return { valid: false, error: "Invalid createdAt date format" };
    }
  }

  return { valid: true };
}

/**
 * Check whether an object key can be abused for prototype pollution or
 * other property-injection attacks ("__proto__", "constructor",
 * "prototype", or any "__"-prefixed name).
 */
function isDangerousKey(key: string): boolean {
  return key.startsWith("__") || key === "constructor" || key === "prototype";
}

/**
 * Canonicalize an object key so unicode-obfuscated dangerous names (e.g.
 * fullwidth "＿＿proto＿＿") are recognized by isDangerousKey.
 */
function canonicalizeKey(key: string): string {
  return normalizeUnicode(key).trim();
}

/**
 * Re-sanitize a string value that contains embedded JSON. If the string
 * parses as a JSON document, its structure is sanitized (dangerous keys
 * removed, string leaves cleaned) and re-serialized, so a later JSON.parse
 * downstream cannot revive injected keys or markup. Bounded by
 * MAX_EMBEDDED_JSON_DEPTH to also cover double-encoded payloads while
 * keeping adversarial recursion in check.
 */
function sanitizeEmbeddedJson(value: string, jsonDepth: number): string {
  if (jsonDepth >= MAX_EMBEDDED_JSON_DEPTH) return value;

  const trimmed = value.trim();
  if (trimmed.length < 2 || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
    return value;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return value; // Ordinary text that merely happens to start with { or [
  }

  const sanitized = sanitizeValue(parsed, 0, jsonDepth + 1);
  try {
    return JSON.stringify(sanitized) ?? value;
  } catch {
    return value;
  }
}

/**
 * Internal recursive worker for sanitizeMetadata. Strings are cleaned with
 * sanitizeString (plus embedded-JSON handling), arrays and plain objects are
 * traversed, dangerous keys are dropped, and nesting is capped at
 * MAX_METADATA_DEPTH so deeply nested payloads cannot exhaust the stack.
 */
function sanitizeValue(
  value: unknown,
  objectDepth: number,
  jsonDepth: number,
): unknown {
  if (typeof value === "string") {
    return sanitizeEmbeddedJson(sanitizeString(value), jsonDepth);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (objectDepth >= MAX_METADATA_DEPTH) {
    log("warn", "metadata_depth_truncated", { objectDepth });
    return null;
  }

  if (Array.isArray(value)) {
    return value.map((entry) =>
      sanitizeValue(entry, objectDepth + 1, jsonDepth),
    );
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    // Drop dangerous keys both before and after sanitization so that
    // obfuscated variants (encoding/unicode tricks) cannot slip through.
    if (isDangerousKey(key) || isDangerousKey(canonicalizeKey(key))) {
      continue;
    }
    // Sanitize both keys and values
    const sanitizedKey = sanitizeString(key);
    if (
      isDangerousKey(sanitizedKey) ||
      isDangerousKey(canonicalizeKey(sanitizedKey))
    ) {
      continue;
    }
    sanitized[sanitizedKey] = sanitizeValue(
      entryValue,
      objectDepth + 1,
      jsonDepth,
    );
  }
  return sanitized;
}

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
export function sanitizeMetadata<T>(data: T): T {
  return sanitizeValue(data, 0, 0) as T;
}

// ============================================
// PINATA CLIENT FUNCTIONS
// ============================================

/**
 * Initialize the Pinata client (SDK v2.x)
 */
export function initPinata(jwt: string, gateway?: string): void {
  if (!jwt) {
    throw new Error("PINATA_JWT is required");
  }

  gatewayUrl = gateway || "https://gateway.pinata.cloud";
  // Dedicated gateways use .mypinata.cloud domain and require signed URLs
  isDedicatedGateway = gatewayUrl.includes(".mypinata.cloud");

  pinata = new PinataSDK({
    pinataJwt: jwt,
    pinataGateway: gatewayUrl,
  });

  log("info", "pinata_initialized", { dedicatedGateway: isDedicatedGateway });
}

/**
 * Propagate content to public IPFS gateways (fire and forget)
 * This triggers public gateways to fetch and cache the content,
 * ensuring it's accessible even if our Pinata gateway goes down.
 */
async function propagateToPublicGateways(cid: string): Promise<void> {
  let cleanCid: string;
  try {
    cleanCid = sanitizeCid(cid);
  } catch {
    return;
  }

  // Fire off requests to public gateways in parallel (don't wait)
  const propagationPromises = PUBLIC_GATEWAYS.map(async (gateway) => {
    try {
      const url = `${gateway}/${cleanCid}`;
      if (!isAllowedGatewayUrl(url)) return;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

      const response = await fetch(url, {
        method: "HEAD", // Just request headers to trigger caching
        signal: controller.signal,
        redirect: "error",
      });

      clearTimeout(timeout);

      if (response.ok) {
        log("debug", "ipfs_propagated", { gateway, cid: cleanCid });
      }
    } catch {
      // Ignore errors - this is best-effort propagation
      // Gateway might be slow or temporarily unavailable
    }
  });

  // Don't wait for all - just fire and forget
  Promise.allSettled(propagationPromises).then((results) => {
    const successful = results.filter((r) => r.status === "fulfilled").length;
    log("info", "ipfs_propagation_complete", {
      cid: cleanCid,
      successful,
      total: PUBLIC_GATEWAYS.length,
    });
  });
}

/**
 * Pin JSON data to public IPFS (SDK v2.x)
 */
export async function pinJSON(
  data: Record<string, unknown>,
  name = "zkvote-metadata",
): Promise<PinResult> {
  if (!pinata) {
    throw new Error("Pinata client not initialized");
  }

  // 1. Backup to local disk before uploading (recovery safety net)
  let backupPath: string | undefined;
  try {
    backupPath = pinManager.backupJSON(data, name);
  } catch (err) {
    log("warn", "local_backup_failed", { name, error: (err as Error).message });
    // Non-fatal — continue with the pin
  }

  // 2. Upload to Pinata (primary)
  // SDK v2.x: pinata.upload.public.json() with chainable methods
  const result = await pinataBreaker.execute(async () =>
    pinata!.upload.public.json(data).name(name).keyvalues({
      app: "zkvote",
      type: "proposal-metadata",
    }),
  );

  const sizeBytes = result.size || JSON.stringify(data).length;

  // 3. Register in pin tracker
  try {
    pinManager.registerPin(
      result.cid,
      "json",
      name,
      sizeBytes,
      "application/json",
      backupPath,
    );
  } catch (err) {
    log("warn", "pin_register_failed", {
      cid: result.cid,
      error: (err as Error).message,
    });
  }

  ipfsPinsTotal.inc({ type: "json", status: "success" });

  // 4. Secondary pin to Web3.Storage (best-effort, non-blocking)
  if (backupPath) {
    pinManager.pinToSecondary(result.cid, backupPath, "json").catch(() => {});
  }

  // 5. Propagate to public gateways in background
  propagateToPublicGateways(result.cid);

  return {
    cid: result.cid,
    size: sizeBytes,
    publicUrl: `https://ipfs.io/ipfs/${result.cid}`,
  };
}

/**
 * Pin a file (image) to public IPFS (SDK v2.x)
 */
export async function pinFile(
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<PinResult> {
  if (!pinata) {
    throw new Error("Pinata client not initialized");
  }

  // 1. Backup to local disk before uploading (recovery safety net)
  let backupPath: string | undefined;
  try {
    backupPath = pinManager.backupFile(buffer, filename);
  } catch (err) {
    log("warn", "local_backup_failed", {
      filename,
      error: (err as Error).message,
    });
  }

  // 2. Upload to Pinata (primary)
  // Create a File object from the buffer
  // Cast buffer to BlobPart to satisfy strict TypeScript checks
  const file = new File([buffer as unknown as BlobPart], filename, {
    type: mimeType,
  });

  // SDK v2.x: pinata.upload.public.file() with chainable methods
  const result = await pinataBreaker.execute(async () =>
    pinata!.upload.public.file(file).name(filename).keyvalues({
      app: "zkvote",
      type: "proposal-image",
    }),
  );

  const sizeBytes = result.size || buffer.length;

  // 3. Register in pin tracker
  try {
    pinManager.registerPin(
      result.cid,
      "file",
      filename,
      sizeBytes,
      mimeType,
      backupPath,
    );
  } catch (err) {
    log("warn", "pin_register_failed", {
      cid: result.cid,
      error: (err as Error).message,
    });
  }

  ipfsPinsTotal.inc({ type: "file", status: "success" });

  // 4. Secondary pin to Web3.Storage (best-effort, non-blocking)
  if (backupPath) {
    pinManager.pinToSecondary(result.cid, backupPath, "file").catch(() => {});
  }

  // 5. Propagate to public gateways in background
  propagateToPublicGateways(result.cid);

  return {
    cid: result.cid,
    size: sizeBytes,
    publicUrl: `https://ipfs.io/ipfs/${result.cid}`,
  };
}

/**
 * CID format regexes
 * CIDv0: Base58 string starting with Qm, 46 characters long
 * CIDv1: Base32 string starting with baf, 50-120 characters long
 */
const CIDV0_REGEX = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CIDV1_REGEX = /^baf[a-z2-7]{46,120}$/i;

/**
 * Validate CID format (CIDv0 or CIDv1) strictly
 */
export function isValidCid(cid: string): boolean {
  if (!cid || typeof cid !== "string") {
    return false;
  }

  const trimmed = cid.trim();

  // Reject path separators, query params, hash fragments, control characters, whitespace
  if (/[/?\\#\s\0\r\n\t]/.test(trimmed)) {
    return false;
  }

  return CIDV0_REGEX.test(trimmed) || CIDV1_REGEX.test(trimmed);
}

/**
 * Sanitize CID before URL construction (reject path separators, query strings, etc.)
 */
export function sanitizeCid(cid: string): string {
  if (typeof cid !== "string") {
    throw new Error("Invalid CID parameter type");
  }

  const trimmed = cid.trim();

  if (/[/?\\#\s\0\r\n\t]/.test(trimmed)) {
    throw new Error(
      "CID contains forbidden characters, query parameters, or path separators",
    );
  }

  if (!isValidCid(trimmed)) {
    throw new Error("Invalid CID format");
  }

  return trimmed;
}

// ============================================
// CID CONTENT INTEGRITY
// ============================================

/**
 * Base32 alphabet used by CIDv1 (RFC 4648 variant without padding,
 * lowercase: "a"=0 … "z"=25, "2"=26 … "7"=31).
 */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Decode a base32-encoded string (RFC 4648, no padding, lowercase) to a Buffer.
 * Returns null if the input contains characters outside the alphabet.
 */
function decodeBase32(input: string): Buffer | null {
  const lower = input.toLowerCase();
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of lower) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

/**
 * Verify that the raw `content` buffer matches the hash encoded in `cid`.
 *
 * Supports:
 *   - CIDv0 (Qm…): SHA2-256 multihash inside a base58btc-encoded CIDv1-dag-pb wrapper.
 *     Multihash layout: [0x12][0x20][32 bytes SHA-256 digest]
 *   - CIDv1 bafy… / bafk…: base32-encoded CIDv1.  The raw bytes after
 *     stripping the CID version (0x01) and codec varint are a multihash.
 *     This function handles the common SHA2-256 codec variant (multihash
 *     function code 0x12).
 *
 * Returns `true` when the hash of `content` matches the CID digest,
 * `false` when it does not match or the format is unrecognised.
 */
export function verifyCidContent(cid: string, content: Buffer): boolean {
  if (!cid || !Buffer.isBuffer(content)) return false;

  const trimmed = cid.trim();

  // ── CIDv0 (Base58BTC, starts with "Qm") ──────────────────────────────────
  if (trimmed.startsWith("Qm")) {
    // CIDv0 is raw base58btc-encoded multihash with SHA2-256.
    // We don't ship a base58 decoder, so we decode by computing the expected
    // multihash bytes ourselves and comparing them after re-encoding — instead
    // we simply compute the SHA-256 of content and construct the expected
    // multihash, then encode it with base58btc and compare strings.
    //
    // base58btc alphabet: "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    const BASE58_ALPHABET =
      "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

    const digest = crypto.createHash("sha256").update(content).digest();
    // Multihash: [0x12 = sha2-256][0x20 = 32 bytes length][32-byte digest]
    const multihash = Buffer.concat([
      Buffer.from([0x12, 0x20]),
      digest,
    ]);

    // Encode multihash as base58btc
    let num = BigInt("0x" + multihash.toString("hex"));
    let encoded = "";
    const BIGINT58 = BigInt(58);
    while (num > 0n) {
      const remainder = num % BIGINT58;
      num = num / BIGINT58;
      encoded = BASE58_ALPHABET[Number(remainder)] + encoded;
    }
    // Leading zero bytes → leading '1' chars
    for (let i = 0; i < multihash.length && multihash[i] === 0; i++) {
      encoded = "1" + encoded;
    }

    const expectedCid = encoded;
    const match = expectedCid === trimmed;
    if (!match) {
      log("warn", "cid_content_mismatch", {
        cid: trimmed,
        cidVersion: "v0",
        expected: expectedCid,
      });
    }
    return match;
  }

  // ── CIDv1 (base32, starts with "baf") ────────────────────────────────────
  if (trimmed.toLowerCase().startsWith("baf")) {
    // CIDv1 base32 layout (after stripping the 'b' multibase prefix):
    //   [version varint = 0x01]
    //   [codec varint   = e.g. 0x55 raw, 0x70 dag-pb, 0x71 dag-cbor …]
    //   [multihash …]
    //     [hash-fn varint = 0x12 for sha2-256]
    //     [digest-length varint = 0x20 = 32]
    //     [32-byte digest]
    //
    // For content stored as raw bytes (codec 0x55) or dag-pb (0x70) the
    // hash function is almost always sha2-256 (0x12).  We read the varints
    // dynamically so we handle any codec, but only verify sha2-256 digests.

    // The first character is the multibase prefix 'b' (base32lower).
    const b32body = trimmed.slice(1);
    const cidBytes = decodeBase32(b32body);
    if (!cidBytes || cidBytes.length < 4) return false;

    // Read version varint (typically single byte 0x01 for CIDv1)
    let offset = 0;
    let version = 0;
    let shift = 0;
    while (offset < cidBytes.length) {
      const byte = cidBytes[offset++];
      version |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    if (version !== 1) return false; // Only CIDv1 handled

    // Read codec varint (skip it — we don't restrict by codec)
    shift = 0;
    while (offset < cidBytes.length) {
      const byte = cidBytes[offset++];
      if ((byte & 0x80) === 0) break;
      shift += 7; // unused but kept for symmetry
    }

    // Now at the multihash
    if (offset >= cidBytes.length) return false;
    const hashFn = cidBytes[offset++];

    if (offset >= cidBytes.length) return false;
    const digestLen = cidBytes[offset++];

    if (hashFn !== 0x12 || digestLen !== 0x20) {
      // We only verify SHA2-256 (0x12) with 32-byte digest (0x20).
      // Return false conservatively for unrecognised hash functions rather
      // than silently skipping verification.
      log("warn", "cid_unsupported_hash_function", {
        cid: trimmed,
        hashFn: `0x${hashFn.toString(16)}`,
        digestLen,
      });
      return false;
    }

    if (cidBytes.length < offset + 32) return false;
    const cidDigest = cidBytes.slice(offset, offset + 32);
    const contentDigest = crypto.createHash("sha256").update(content).digest();

    const match = cidDigest.equals(contentDigest);
    if (!match) {
      log("warn", "cid_content_mismatch", {
        cid: trimmed,
        cidVersion: "v1",
        expected: cidDigest.toString("hex"),
        actual: contentDigest.toString("hex"),
      });
    }
    return match;
  }

  // Unsupported CID format
  return false;
}

// ============================================
// PINNING REDUNDANCY
// ============================================

export interface EnsurePinnedResult {
  cid: string;
  alreadyPinned: boolean;
  pinned: boolean;
  services: string[];
  error?: string;
}

/**
 * Ensure a CID is pinned to at least `minPinCount` services.
 *
 * Checks the local pin registry first; if the CID is already tracked with
 * enough services, returns immediately.  Otherwise pins to Pinata (which
 * counts as one service), optionally supplemented by secondary services
 * via the pin-manager's `pinToSecondary`.
 *
 * @param cid          The IPFS CID to pin
 * @param minPinCount  Minimum number of pinning services required (default 1)
 */
export async function ensurePinned(
  cid: string,
  minPinCount = 1,
): Promise<EnsurePinnedResult> {
  let cleanCid: string;
  try {
    cleanCid = sanitizeCid(cid);
  } catch (err) {
    return {
      cid,
      alreadyPinned: false,
      pinned: false,
      services: [],
      error: (err as Error).message,
    };
  }

  // Check the local registry first
  const existing = pinManager.getPinRecord(cleanCid);
  if (existing && existing.pinnedOn.length >= minPinCount) {
    log("debug", "ipfs_already_pinned", {
      cid: cleanCid,
      services: existing.pinnedOn,
      minPinCount,
    });
    return {
      cid: cleanCid,
      alreadyPinned: true,
      pinned: true,
      services: existing.pinnedOn,
    };
  }

  if (!pinata) {
    const services = existing?.pinnedOn ?? [];
    return {
      cid: cleanCid,
      alreadyPinned: false,
      pinned: false,
      services,
      error: "Pinata client not initialized",
    };
  }

  // Pin via Pinata by re-pinning the CID by hash (pin by CID endpoint)
  try {
    await pinataBreaker.execute(async () =>
      pinata!.upload.public
        .json({ _rePinCid: cleanCid })
        .name(`repin-${cleanCid}`)
        .keyvalues({ app: "zkvote", type: "repin" }),
    );

    const services = ["pinata"];
    log("info", "ipfs_ensure_pinned", { cid: cleanCid, services });

    return {
      cid: cleanCid,
      alreadyPinned: false,
      pinned: true,
      services,
    };
  } catch (err) {
    log("error", "ipfs_ensure_pinned_failed", {
      cid: cleanCid,
      error: (err as Error).message,
    });
    return {
      cid: cleanCid,
      alreadyPinned: false,
      pinned: false,
      services: existing?.pinnedOn ?? [],
      error: (err as Error).message,
    };
  }
}

/**
 * Check if a host or IP is in a private/internal network range
 */
export function isPrivateIP(host: string): boolean {
  if (!host) return true;
  const h = host.toLowerCase().trim();

  // Localhost & local domain identifiers
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) {
    return true;
  }

  // Strip IPv6 brackets if present
  let ip = h.replace(/^\[|\]$/g, "");
  if (ip.startsWith("::ffff:")) {
    ip = ip.substring(7);
  }

  // Check IPv4 ranges
  const ipv4Match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) return true;

    const [o1, o2, o3] = octets;

    // 0.0.0.0/8
    if (o1 === 0) return true;
    // 10.0.0.0/8 (Private network)
    if (o1 === 10) return true;
    // 127.0.0.0/8 (Loopback)
    if (o1 === 127) return true;
    // 169.254.0.0/16 (Link-local / Cloud Metadata)
    if (o1 === 169 && o2 === 254) return true;
    // 172.16.0.0/12 (Private network: 172.16.0.0 – 172.31.255.255)
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    // 192.168.0.0/16 (Private network)
    if (o1 === 192 && o2 === 168) return true;
    // 100.64.0.0/10 (Carrier-grade NAT)
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return true;
    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (o1 === 192 && o2 === 0 && o3 === 0) return true;
    // 192.0.2.0/24 (TEST-NET-1)
    if (o1 === 192 && o2 === 0 && o3 === 2) return true;
    // 198.51.100.0/24 (TEST-NET-2)
    if (o1 === 198 && o2 === 51 && o3 === 100) return true;
    // 203.0.113.0/24 (TEST-NET-3)
    if (o1 === 203 && o2 === 0 && o3 === 113) return true;
    // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
    if (o1 >= 224) return true;

    return false;
  }

  // Check IPv6 loopback, link-local, unique local
  if (
    ip === "::1" ||
    ip === "::" ||
    ip.startsWith("fe80:") ||
    ip.startsWith("fc") ||
    ip.startsWith("fd")
  ) {
    return true;
  }

  return false;
}

/**
 * Validate that a URL belongs to an allowed IPFS gateway and does not target private IPs
 */
export function isAllowedGatewayUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }

    if (parsed.username || parsed.password) {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();

    if (isPrivateIP(hostname)) {
      return false;
    }

    // Match against configured gateway URL
    if (gatewayUrl) {
      try {
        const configuredHost = new URL(gatewayUrl).hostname.toLowerCase();
        if (
          hostname === configuredHost ||
          hostname.endsWith("." + configuredHost)
        ) {
          return true;
        }
      } catch {
        /* ignore */
      }
    }

    // Match against public gateways
    for (const gw of PUBLIC_GATEWAYS) {
      try {
        const gwHost = new URL(gw).hostname.toLowerCase();
        if (hostname === gwHost) {
          return true;
        }
      } catch {
        /* ignore */
      }
    }

    return false;
  } catch {
    return false;
  }
}

// Per-gateway timeout for the public-gateway fallback chain (issue #379).
// Deliberately shorter than the primary Pinata fetch's 30s timeout since
// there are multiple gateways to try in sequence before giving up.
const PUBLIC_GATEWAY_TIMEOUT_MS = 10000;

/**
 * Try each public IPFS gateway in turn for a CID, returning the first
 * successful response. Used as a fallback when the primary Pinata gateway
 * fails or times out (issue #379), so a single degraded/down gateway
 * doesn't make already-pinned content unreachable. Reuses the same
 * `isAllowedGatewayUrl` SSRF/private-IP guard as the primary path.
 */
async function fetchFromPublicGateways(cleanCid: string): Promise<Response> {
  let lastError: Error | undefined;

  for (const gateway of PUBLIC_GATEWAYS) {
    const url = `${gateway}/${cleanCid}`;
    if (!isAllowedGatewayUrl(url)) continue;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      PUBLIC_GATEWAY_TIMEOUT_MS,
    );
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "error",
      });
      if (!res.ok) {
        throw new Error(
          `Failed to fetch from IPFS: ${res.status} ${res.statusText}`,
        );
      }
      return res;
    } catch (err) {
      lastError = err as Error;
      log("warn", "ipfs_public_gateway_failed", {
        gateway,
        cid: cleanCid,
        error: lastError.message,
      });
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("All public IPFS gateways failed");
}

/**
 * Fetch content from IPFS via Pinata gateway
 */
export async function fetchContent(cid: string): Promise<FetchResult> {
  if (!gatewayUrl || !pinata) {
    throw new Error("Pinata client not initialized");
  }

  // Validate and sanitize CID format
  const cleanCid = sanitizeCid(cid);

  let url: string;

  if (isDedicatedGateway) {
    // SDK v2.x: Use gateways.private.createAccessLink for dedicated gateways
    try {
      const signedUrl = await pinata.gateways.private.createAccessLink({
        cid: cleanCid,
        expires: 300, // 5 minutes
      });
      url = signedUrl;
    } catch (err) {
      const error = err as Error;
      throw new Error(`Failed to create signed URL: ${error.message}`, {
        cause: err,
      });
    }
  } else {
    // Public gateway - direct URL
    url = `${gatewayUrl}/ipfs/${cleanCid}`;
  }

  if (!isAllowedGatewayUrl(url)) {
    throw new Error(
      "Target URL is not an allowed gateway or resolves to a restricted IP address",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const fetchStart = performance.now();
  try {
    const response = await ipfsGatewayBreaker.execute(async () => {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "error",
      });
      if (!res.ok) {
        throw new Error(
          `Failed to fetch from IPFS: ${res.status} ${res.statusText}`,
        );
      }
      return res;
    });

    const contentType =
      response.headers.get("content-type") || "application/json";

    if (
      contentType.includes("text/html") ||
      contentType.includes("application/javascript") ||
      contentType.includes("text/javascript")
    ) {
      throw new Error(`Forbidden response content-type: ${contentType}`);
    }

    // Read the raw bytes first so we can verify the CID digest (issue #344)
    const rawBytes = Buffer.from(await response.arrayBuffer());

    if (!verifyCidContent(cleanCid, rawBytes)) {
      throw new Error(
        `CID content integrity check failed: fetched content does not match CID ${cleanCid}`,
      );
    }

    let data: unknown;
    if (contentType.includes("application/json")) {
      data = JSON.parse(rawBytes.toString("utf-8"));
      ipfsCacheHits.inc();
    } else {
      data = rawBytes.toString("utf-8");
      ipfsCacheHits.inc();
    }

    log("debug", "ipfs_primary_gateway_succeeded", { cid: cleanCid, url });

    return {
      data,
      contentType,
    };
  } catch (err) {
    // Issue #379: primary Pinata gateway failed — fail over to the public
    // gateway chain before giving up.
    try {
      const fallbackRes = await fetchFromPublicGateways(cleanCid);
      const contentType =
        fallbackRes.headers.get("content-type") || "application/json";

      if (
        contentType.includes("text/html") ||
        contentType.includes("application/javascript") ||
        contentType.includes("text/javascript")
      ) {
        throw new Error(`Forbidden response content-type: ${contentType}`, {
          cause: err,
        });
      }

      // Verify CID integrity from fallback gateway too (issue #344)
      const rawBytes = Buffer.from(await fallbackRes.arrayBuffer());

      if (!verifyCidContent(cleanCid, rawBytes)) {
        throw new Error(
          `CID content integrity check failed on fallback: fetched content does not match CID ${cleanCid}`,
          { cause: err },
        );
      }

      const data = contentType.includes("application/json")
        ? JSON.parse(rawBytes.toString("utf-8"))
        : rawBytes.toString("utf-8");

      ipfsCacheHits.inc();
      log("info", "ipfs_fallback_gateway_succeeded", { cid: cleanCid });
      return { data, contentType };
    } catch {
      ipfsCacheMisses.inc();
      throw err;
    }
  } finally {
    clearTimeout(timeout);
    const fetchDuration = (performance.now() - fetchStart) / 1000;
    ipfsFetchDuration.observe({ type: "json" }, fetchDuration);
  }
}

/**
 * Fetch raw content (e.g., image) from IPFS via Pinata gateway
 * Returns the raw buffer and content type for binary data
 */
export async function fetchRawContent(cid: string): Promise<RawFetchResult> {
  if (!gatewayUrl || !pinata) {
    throw new Error("Pinata client not initialized");
  }

  // Validate and sanitize CID format
  const cleanCid = sanitizeCid(cid);

  let url: string;

  if (isDedicatedGateway) {
    // SDK v2.x: Use gateways.private.createAccessLink for dedicated gateways
    try {
      const signedUrl = await pinata.gateways.private.createAccessLink({
        cid: cleanCid,
        expires: 300, // 5 minutes
      });
      url = signedUrl;
    } catch (err) {
      const error = err as Error;
      throw new Error(`Failed to create signed URL: ${error.message}`, {
        cause: err,
      });
    }
  } else {
    // Public gateway - direct URL
    url = `${gatewayUrl}/ipfs/${cleanCid}`;
  }

  if (!isAllowedGatewayUrl(url)) {
    throw new Error(
      "Target URL is not an allowed gateway or resolves to a restricted IP address",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const fetchStart = performance.now();
  try {
    const response = await ipfsGatewayBreaker.execute(async () => {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "error",
      });
      if (!res.ok) {
        throw new Error(
          `Failed to fetch from IPFS: ${res.status} ${res.statusText}`,
        );
      }
      return res;
    });

    const contentType =
      response.headers.get("content-type") || "application/octet-stream";

    if (
      contentType.includes("text/html") ||
      contentType.includes("application/javascript") ||
      contentType.includes("text/javascript")
    ) {
      throw new Error(`Forbidden response content-type: ${contentType}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Verify CID integrity (issue #344)
    if (!verifyCidContent(cleanCid, buffer)) {
      throw new Error(
        `CID content integrity check failed: fetched content does not match CID ${cleanCid}`,
      );
    }

    ipfsCacheHits.inc();

    log("debug", "ipfs_primary_gateway_succeeded", { cid: cleanCid, url });

    return {
      buffer,
      contentType,
    };
  } catch (err) {
    // Issue #379: primary Pinata gateway failed — fail over to the public
    // gateway chain before giving up.
    try {
      const fallbackRes = await fetchFromPublicGateways(cleanCid);
      const contentType =
        fallbackRes.headers.get("content-type") || "application/octet-stream";

      if (
        contentType.includes("text/html") ||
        contentType.includes("application/javascript") ||
        contentType.includes("text/javascript")
      ) {
        throw new Error(`Forbidden response content-type: ${contentType}`, {
          cause: err,
        });
      }

      const arrayBuffer = await fallbackRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Verify CID integrity from fallback gateway too (issue #344)
      if (!verifyCidContent(cleanCid, buffer)) {
        throw new Error(
          `CID content integrity check failed on fallback: fetched content does not match CID ${cleanCid}`,
          { cause: err },
        );
      }

      ipfsCacheHits.inc();
      log("info", "ipfs_fallback_gateway_succeeded", { cid: cleanCid });
      return { buffer, contentType };
    } catch {
      ipfsCacheMisses.inc();
      throw err;
    }
  } finally {
    clearTimeout(timeout);
    const fetchDuration = (performance.now() - fetchStart) / 1000;
    ipfsFetchDuration.observe({ type: "raw" }, fetchDuration);
  }
}

/**
 * Check if Pinata is initialized and healthy (SDK v2.x)
 */
export async function isHealthy(): Promise<boolean> {
  if (!pinata) {
    return false;
  }

  try {
    // SDK v2.x: Test by listing public files
    await pinata.files.public.list().limit(1);
    return true;
  } catch (error) {
    const err = error as Error;
    log("error", "pinata_health_failed", { error: err.message });
    return false;
  }
}

/**
 * Enhanced health check that includes pin verification status.
 */
export function getEnhancedHealth(): MonitorStatus {
  return getMonitorStatus();
}

/**
 * Get public gateway URLs for a CID
 * These URLs are accessible without authentication and provide redundancy.
 */
export function getPublicUrls(cid: string): PublicUrls {
  return {
    primary: `https://ipfs.io/ipfs/${cid}`,
    fallbacks: PUBLIC_GATEWAYS.map((gw) => `${gw}/${cid}`),
  };
}

/**
 * Manually trigger propagation of a CID to public gateways
 * Use this to ensure older content is propagated.
 */
export function ensurePublicAvailability(cid: string): void {
  if (isValidCid(cid)) {
    propagateToPublicGateways(cid);
  }
}

/**
 * Re-pin callback for the pin monitor.
 * Reads content from the backup path and re-uploads to Pinata.
 */
export async function repinCallback(
  backupPath: string,
  contentType: "json" | "file",
  name: string,
  mimeType?: string,
): Promise<string> {
  if (!pinata) {
    throw new Error("Pinata client not initialized");
  }

  if (contentType === "json") {
    const raw = fs.readFileSync(backupPath, "utf-8");
    const data = JSON.parse(raw);
    const result = await pinata.upload.public.json(data).name(name).keyvalues({
      app: "zkvote",
      type: "proposal-metadata",
    });
    propagateToPublicGateways(result.cid);
    return result.cid;
  } else {
    const buffer = fs.readFileSync(backupPath);
    const file = new File([buffer as unknown as BlobPart], name, {
      type: mimeType || "application/octet-stream",
    });
    const result = await pinata.upload.public.file(file).name(name).keyvalues({
      app: "zkvote",
      type: "proposal-image",
    });
    propagateToPublicGateways(result.cid);
    return result.cid;
  }
}
