/**
 * IPFS/Pinata Integration Module (SDK v2.5.1)
 *
 * Handles pinning and fetching content from IPFS via Pinata.
 * Also propagates content to public IPFS gateways for redundancy.
 */

import { PinataSDK } from "pinata";

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
 * Sanitize string content to prevent XSS
 * Removes script tags and event handlers
 */
export function sanitizeString(str: string): string {
  if (typeof str !== "string") return str;

  // Remove script tags and their content
  let sanitized = str.replace(
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    "",
  );

  // Remove event handlers (onclick, onerror, etc.)
  sanitized = sanitized.replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, "");
  sanitized = sanitized.replace(/\bon\w+\s*=\s*[^\s>]*/gi, "");

  // Remove javascript: URLs
  sanitized = sanitized.replace(/javascript:/gi, "");

  // Remove data: URLs that could contain scripts
  sanitized = sanitized.replace(/data:\s*text\/html/gi, "data:blocked");

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
 * Sanitize metadata object recursively
 */
export function sanitizeMetadata<T>(data: T): T {
  if (typeof data === "string") {
    return sanitizeString(data) as unknown as T;
  }

  if (Array.isArray(data)) {
    return data.map(sanitizeMetadata) as unknown as T;
  }

  if (data && typeof data === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      // Sanitize both keys and values
      const sanitizedKey = sanitizeString(key);
      sanitized[sanitizedKey] = sanitizeMetadata(value);
    }
    return sanitized as T;
  }

  return data;
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
  // Fire off requests to public gateways in parallel (don't wait)
  const propagationPromises = PUBLIC_GATEWAYS.map(async (gateway) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

      const response = await fetch(`${gateway}/${cid}`, {
        method: "HEAD", // Just request headers to trigger caching
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        log("debug", "ipfs_propagated", { gateway, cid });
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
      cid,
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

  // SDK v2.x: pinata.upload.public.json() with chainable methods
  const result = await pinata.upload.public.json(data).name(name).keyvalues({
    app: "zkvote",
    type: "proposal-metadata",
  });

  // Propagate to public gateways in background
  propagateToPublicGateways(result.cid);

  return {
    cid: result.cid,
    size: result.size || 0,
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

  // Create a File object from the buffer
  // Cast buffer to BlobPart to satisfy strict TypeScript checks
  const file = new File([buffer as unknown as BlobPart], filename, {
    type: mimeType,
  });

  // SDK v2.x: pinata.upload.public.file() with chainable methods
  const result = await pinata.upload.public
    .file(file)
    .name(filename)
    .keyvalues({
      app: "zkvote",
      type: "proposal-image",
    });

  // Propagate to public gateways in background
  propagateToPublicGateways(result.cid);

  return {
    cid: result.cid,
    size: result.size || buffer.length,
    publicUrl: `https://ipfs.io/ipfs/${result.cid}`,
  };
}

/**
 * Validate CID format (CIDv0 or CIDv1)
 */
export function isValidCid(cid: string): boolean {
  if (!cid || typeof cid !== "string") {
    return false;
  }

  // CIDv0: Starts with "Qm" and is 46 characters
  if (cid.startsWith("Qm") && cid.length === 46) {
    return true;
  }

  // CIDv1: Starts with "bafy" (base32) or "bafk" and is variable length
  if ((cid.startsWith("bafy") || cid.startsWith("bafk")) && cid.length >= 50) {
    return true;
  }

  return false;
}

/**
 * Fetch content from IPFS via Pinata gateway
 */
export async function fetchContent(cid: string): Promise<FetchResult> {
  if (!gatewayUrl || !pinata) {
    throw new Error("Pinata client not initialized");
  }

  // Validate CID format
  if (!isValidCid(cid)) {
    throw new Error("Invalid CID format");
  }

  let url: string;

  if (isDedicatedGateway) {
    // SDK v2.x: Use gateways.private.createAccessLink for dedicated gateways
    try {
      const signedUrl = await pinata.gateways.private.createAccessLink({
        cid: cid,
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
    url = `${gatewayUrl}/ipfs/${cid}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch from IPFS: ${response.status} ${response.statusText}`,
      );
    }

    const contentType =
      response.headers.get("content-type") || "application/json";

    let data: unknown;
    if (contentType.includes("application/json")) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return {
      data,
      contentType,
    };
  } finally {
    clearTimeout(timeout);
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

  // Validate CID format
  if (!isValidCid(cid)) {
    throw new Error("Invalid CID format");
  }

  let url: string;

  if (isDedicatedGateway) {
    // SDK v2.x: Use gateways.private.createAccessLink for dedicated gateways
    try {
      const signedUrl = await pinata.gateways.private.createAccessLink({
        cid: cid,
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
    url = `${gatewayUrl}/ipfs/${cid}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch from IPFS: ${response.status} ${response.statusText}`,
      );
    }

    const contentType =
      response.headers.get("content-type") || "application/octet-stream";
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      buffer,
      contentType,
    };
  } finally {
    clearTimeout(timeout);
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
