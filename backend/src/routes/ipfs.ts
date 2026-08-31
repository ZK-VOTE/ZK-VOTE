/**
 * IPFS Routes
 *
 * Handles IPFS uploads (images, metadata) and content retrieval.
 */

import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import sharp from "sharp";

import { config, LIMITS, ALLOWED_IMAGE_MIMES } from "../config.js";
import { log } from "../services/logger.js";
import * as ipfsService from "../services/ipfs.js";
import {
  authGuard,
  auditLog,
  queryLimiter,
  ipfsUploadLimiter,
  ipfsReadLimiter,
  validateParams,
  noteDegraded,
  sendPartial,
  bodyLimit,
} from "../middleware/index.js";
import { cidParamsSchema } from "../validation/schemas.js";
import type { AsyncHandler } from "../types/index.js";
import {
  markDegraded,
  markHealthy,
  setLkg,
  getLkg,
  ipfsLkgKey,
  enqueueDegradedWrite,
  drainIpfsPinQueue,
} from "../services/service-health.js";
import { detectMimeType } from "../utils/magic-bytes.js";

const router = Router();

// ============================================
// IPFS SECURITY MIDDLEWARE
// ============================================

router.use(["/ipfs/:cid", "/ipfs/image/:cid"], (req, res, next) => {
  // Origin isolation
  if (
    config.ipfsSubdomain &&
    req.hostname !== config.ipfsSubdomain &&
    !config.testMode
  ) {
    return res.status(403).json({
      error: "IPFS content must be served from the dedicated IPFS subdomain",
    });
  }

  // Security headers for all IPFS responses
  res.set("X-Content-Type-Options", "nosniff");
  next();
});

// ============================================
// MULTER CONFIGURATION (FILE UPLOADS)
// ============================================

const MAX_IMAGE_DIMENSION = 4096;

const ALLOWED_IMAGE_MIME_SET = new Set<string>(ALLOWED_IMAGE_MIMES);

const FORBIDDEN_IMAGE_MIMES = new Set<string>([
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
  "application/javascript",
  "text/javascript",
]);

const MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
  "image/x-gif": "image/gif",
  "image/x-webp": "image/webp",
};

function normalizeMimeType(mime: string | undefined): string | null {
  if (!mime) return null;
  const normalized = mime.toLowerCase().split(";")[0].trim();
  return MIME_ALIASES[normalized] ?? normalized;
}

function isAllowedImageMime(mime: string | undefined): boolean {
  const normalized = normalizeMimeType(mime);
  return (
    normalized !== null &&
    ALLOWED_IMAGE_MIME_SET.has(normalized) &&
    !FORBIDDEN_IMAGE_MIMES.has(normalized)
  );
}

function scanFileForThreats(file: {
  buffer: Buffer;
  originalname: string;
}): string[] {
  const threats: string[] = [];
  const lower = file.buffer.toString("latin1").toLowerCase();

  const patterns: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /<script[\s>]/i, label: "script_tag" },
    { pattern: /javascript:/i, label: "javascript_protocol" },
    { pattern: /vbscript:/i, label: "vbscript_protocol" },
    { pattern: /<svg[\s>]/i, label: "svg_xss" },
    { pattern: /<html[\s>]/i, label: "html_payload" },
    { pattern: /<\?php/i, label: "php_payload" },
    { pattern: /<\?xml/i, label: "xml_payload" },
    { pattern: /<!doctype\s+html/i, label: "html_doctype" },
    { pattern: /on(error|load)\s*=/i, label: "event_handler" },
    { pattern: /data:\s*text\/html/i, label: "data_html" },
  ];

  for (const { pattern, label } of patterns) {
    if (pattern.test(lower)) {
      threats.push(label);
    }
  }

  const archiveSignatures: Array<{ bytes: number[]; label: string }> = [
    { bytes: [0x50, 0x4b, 0x03, 0x04], label: "zip_polyglot" },
    { bytes: [0x52, 0x61, 0x72, 0x21], label: "rar_polyglot" },
    { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], label: "7z_polyglot" },
    { bytes: [0x25, 0x50, 0x44, 0x46], label: "pdf_polyglot" },
  ];

  for (const { bytes, label } of archiveSignatures) {
    if (file.buffer.includes(Buffer.from(bytes))) {
      threats.push(label);
    }
  }

  if (
    /\.(html?|svg|php|phtml|jsp|asp|aspx|sh|js|mjs|xml)$/i.test(
      file.originalname,
    )
  ) {
    threats.push("dangerous_extension");
  }

  return threats;
}

interface ProcessedImage {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  hash: string;
}

function invalidUpload(message: string, code: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

async function processImageUpload(file: {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}): Promise<ProcessedImage> {
  const declaredMime = normalizeMimeType(file.mimetype);
  if (!declaredMime || !isAllowedImageMime(declaredMime)) {
    throw invalidUpload(
      `Unsupported file type: ${file.mimetype || "unknown"}. Allowed: JPEG, PNG, GIF, WebP, AVIF, HEIC.`,
      "INVALID_FILE_TYPE",
    );
  }

  const detectedMime = detectMimeType(file.buffer);
  if (!detectedMime || !isAllowedImageMime(detectedMime)) {
    throw invalidUpload(
      `File content is not a supported image (detected: ${detectedMime || "unknown"}).`,
      "INVALID_FILE_TYPE",
    );
  }

  if (detectedMime !== declaredMime) {
    throw invalidUpload(
      `File content (${detectedMime}) does not match declared MIME type (${declaredMime}).`,
      "MIME_MISMATCH",
    );
  }

  const threats = scanFileForThreats(file);
  if (threats.length > 0) {
    throw invalidUpload(
      `Upload rejected as potentially malicious (${threats.join(", ")}).`,
      "MALICIOUS_CONTENT",
    );
  }

  let metadata;
  try {
    metadata = await sharp(file.buffer, { failOn: "error" }).metadata();
  } catch {
    throw invalidUpload("Unable to read image metadata.", "INVALID_IMAGE");
  }

  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width > MAX_IMAGE_DIMENSION ||
    metadata.height > MAX_IMAGE_DIMENSION
  ) {
    throw invalidUpload(
      `Image dimensions exceed maximum allowed ${MAX_IMAGE_DIMENSION}x${MAX_IMAGE_DIMENSION}.`,
      "IMAGE_DIMENSIONS_EXCEEDED",
    );
  }

  let sanitizedBuffer: Buffer;
  try {
    sanitizedBuffer = await sharp(file.buffer, { failOn: "error" })
      .rotate()
      .withMetadata(false)
      .toBuffer();
  } catch {
    throw invalidUpload("Image sanitization failed.", "IMAGE_SANITIZATION_FAILED");
  }

  const sanitizedThreats = scanFileForThreats({
    buffer: sanitizedBuffer,
    originalname: file.originalname,
  });
  if (sanitizedThreats.length > 0) {
    throw invalidUpload(
      `Sanitized image still contains threats (${sanitizedThreats.join(", ")}).`,
      "MALICIOUS_CONTENT",
    );
  }

  return {
    buffer: sanitizedBuffer,
    mimeType: detectedMime,
    width: metadata.width,
    height: metadata.height,
    hash: createHash("sha256").update(file.buffer).digest("hex"),
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: LIMITS.MAX_IMAGE_SIZE,
    files: 1,
    fields: 0,
    parts: 1,
  },
  fileFilter: (_req, file, cb) => {
    log("info", "upload_file_filter", {
      mimetype: file.mimetype,
      originalname: file.originalname,
    });

    if (isAllowedImageMime(file.mimetype)) {
      cb(null, true);
    } else {
      const err = new Error(
        `Unsupported file type: ${file.mimetype || "unknown"}. Allowed: JPEG, PNG, GIF, WebP, AVIF, HEIC.`,
      ) as any;
      err.code = "INVALID_FILE_TYPE";
      cb(err);
    }
  },
});

// ============================================
// IPFS CACHE (IN-MEMORY)
// ============================================

interface CachedContent {
  data: unknown;
  expiry: number;
}

const MAX_CACHE_SIZE = 500;
const ipfsCache = new Map<string, CachedContent>();

function getCachedContent(cid: string): unknown | null {
  const cached = ipfsCache.get(cid);
  if (cached && Date.now() < cached.expiry) {
    // Move to end for LRU behavior (Map preserves insertion order)
    ipfsCache.delete(cid);
    ipfsCache.set(cid, cached);
    return cached.data;
  }
  ipfsCache.delete(cid);
  return null;
}

function setCachedContent(cid: string, data: unknown): void {
  // If key already exists, delete first so re-insert moves it to the end
  ipfsCache.delete(cid);
  // Evict oldest entry (first key in Map) if at capacity
  if (ipfsCache.size >= MAX_CACHE_SIZE) {
    const firstKey = ipfsCache.keys().next().value;
    if (firstKey !== undefined) {
      ipfsCache.delete(firstKey);
    }
  }
  ipfsCache.set(cid, { data, expiry: Date.now() + LIMITS.IPFS_CACHE_TTL });
}

// ============================================
// ROUTES
// ============================================

/**
 * GET /ipfs/health - IPFS health check with pin verification status
 */
router.get("/ipfs/health", queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  if (!config.ipfsEnabled) {
    return res.json({ enabled: false, status: "not_configured" });
  }

  try {
    const healthy = await ipfsService.isHealthy();

    // Get enhanced pin verification data
    let pinStatus;
    try {
      pinStatus = ipfsService.getEnhancedHealth();
    } catch {
      pinStatus = null;
    }

    if (healthy) {
      markHealthy("ipfs");
      // Best-effort drain of queued pinJSON ops
      void drainIpfsPinQueue(async (payload) =>
        ipfsService.pinJSON(
          payload.data as Record<string, unknown>,
          payload.name ?? "zkvote-queued",
        ),
      );
    } else {
      markDegraded("ipfs", "Pinata health check failed");
      noteDegraded("ipfs");
    }

    res.json({
      enabled: true,
      status: healthy ? "healthy" : "degraded",
      pinVerification: pinStatus
        ? {
            monitorRunning: pinStatus.running,
            totalPins: pinStatus.stats.totalPins,
            healthyPins: pinStatus.stats.healthyPins,
            degradedPins: pinStatus.stats.degradedPins,
            failedPins: pinStatus.stats.failedPins,
            totalSizeBytes: pinStatus.stats.totalSizeBytes,
            estimatedMonthlyCostUsd: pinStatus.stats.estimatedMonthlyCostUsd,
            lastScanAt: pinStatus.lastScanAt,
            lastScanDurationMs: pinStatus.lastScanDurationMs,
            nextScanAt: pinStatus.nextScanAt,
            activeAlerts: pinStatus.alerts.length,
            alerts: pinStatus.alerts.slice(0, 10), // Cap at 10 for response size
          }
        : null,
    });
  } catch (err) {
    markDegraded("ipfs", (err as Error).message);
    noteDegraded("ipfs");
    res.json({
      enabled: true,
      status: "error",
      error: (err as Error).message,
    });
  }
}) as AsyncHandler);

/**
 * POST /ipfs/image - Upload image to IPFS
 */
router.post(
  "/ipfs/image",
  // N1 hardening: was unauthenticated. Requires AUTH_TOKEN now even though
  // the token is shipped in the public frontend bundle — keeps random
  // internet attackers off the multer parser + Pinata bill.
  authGuard,
  auditLog("ipfs_upload_image"),
  ipfsUploadLimiter,
  (req, res, next) => {
    upload.single("image")(req, res, (err: any) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res
            .status(400)
            .json({ error: "File too large. Maximum size is 5MB." });
        }
        if (
          err.code === "INVALID_FILE_TYPE" ||
          err.message?.includes("file type")
        ) {
          return res.status(400).json({ error: err.message });
        }
        log("error", "multer_error", { code: err.code, message: err.message });
        return res
          .status(400)
          .json({ error: err.message || "File upload failed" });
      }
      next();
    });
  },
  (async (req: Request, res: Response) => {
    if (!config.ipfsEnabled) {
      return res.status(503).json({ error: "IPFS service not configured" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No image file provided" });
    }

    try {
      const uploader =
        (req as any).user?.address ??
        (req as any).user?.id ??
        (req as any).auth?.sub ??
        "authenticated";

      const processed = await processImageUpload(req.file);

      log("info", "ipfs_upload_image", {
        filename: req.file.originalname,
        originalSize: req.file.size,
        size: processed.buffer.length,
        mimetype: processed.mimeType,
        width: processed.width,
        height: processed.height,
        hash: processed.hash,
        uploader,
      });

      const result = await ipfsService.pinFile(
        processed.buffer,
        req.file.originalname,
        processed.mimeType,
      );

      log("info", "ipfs_upload_success", {
        cid: result.cid,
        type: "image",
        hash: processed.hash,
        uploader,
      });

      res.json({
        cid: result.cid,
        size: result.size,
        originalSize: req.file.size,
        filename: req.file.originalname,
        mimeType: processed.mimeType,
      });
    } catch (err) {
      log("error", "ipfs_upload_failed", {
        error: (err as Error).message,
        code: (err as any).code,
        type: "image",
      });
      if (
        (err as any).code &&
        [
          "INVALID_FILE_TYPE",
          "MIME_MISMATCH",
          "MALICIOUS_CONTENT",
          "INVALID_IMAGE",
          "IMAGE_DIMENSIONS_EXCEEDED",
          "IMAGE_SANITIZATION_FAILED",
        ].includes((err as any).code)
      ) {
        return res.status(400).json({ error: (err as Error).message });
      }
      res.status(500).json({ error: "Failed to upload image to IPFS" });
    }
  }) as AsyncHandler,
);

/**
 * POST /ipfs/metadata - Upload JSON metadata to IPFS
 */
// N1 hardening: was unauthenticated — see /ipfs/image rationale.
router.post(
  "/ipfs/metadata",
  bodyLimit("50kb"),
  authGuard,
  auditLog("ipfs_upload_metadata"),
  ipfsUploadLimiter,
  (async (req: Request, res: Response) => {
    const metadata = req.body;

    const metadataSize = JSON.stringify(metadata).length;
    if (metadataSize > LIMITS.MAX_METADATA_SIZE) {
      return res.status(400).json({
        error: `Metadata too large: ${metadataSize} bytes (max ${LIMITS.MAX_METADATA_SIZE})`,
      });
    }

    if (!metadata.version || typeof metadata.version !== "number") {
      return res
        .status(400)
        .json({ error: "metadata.version is required and must be a number" });
    }

    if (metadata.videoUrl) {
      const videoPattern =
        /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com)\/.+$/i;
      if (!videoPattern.test(metadata.videoUrl)) {
        return res.status(400).json({
          error: "Invalid video URL. Only YouTube and Vimeo URLs are allowed.",
        });
      }
    }

    if (!config.ipfsEnabled) {
      return res.status(503).json({ error: "IPFS service not configured" });
    }

    try {
      // Sanitize metadata to prevent XSS attacks
      const sanitizedMetadata = ipfsService.sanitizeMetadata(metadata);

      log("info", "ipfs_upload_metadata", { size: metadataSize });

      const result = await ipfsService.pinJSON(
        sanitizedMetadata,
        "zkvote-proposal-metadata",
      );

      markHealthy("ipfs");
      log("info", "ipfs_upload_success", { cid: result.cid, type: "metadata" });

      res.json({
        cid: result.cid,
        size: result.size,
      });
    } catch (err) {
      const message = (err as Error).message;
      log("error", "ipfs_upload_failed", {
        error: message,
        type: "metadata",
      });
      markDegraded("ipfs", message);
      noteDegraded("ipfs");
      const queued = enqueueDegradedWrite("ipfs", "pinJSON", {
        data: metadata,
        name: "zkvote-proposal-metadata",
      });
      sendPartial(
        res,
        {
          queued: true,
          queueId: queued.id,
          error: "IPFS unavailable — metadata queued for retry",
        },
        ["ipfs"],
        202,
      );
    }
  }) as AsyncHandler,
);

/**
 * GET /ipfs/:cid - Fetch content from IPFS (JSON)
 */
router.get(
  "/ipfs/:cid",
  ipfsReadLimiter,
  validateParams(cidParamsSchema),
  (async (req: Request, res: Response) => {
    if (!config.ipfsEnabled) {
      return res.status(503).json({ error: "IPFS service not configured" });
    }

    const { cid } = (req as any).validatedParams;

    const cached = getCachedContent(cid);
    if (cached) {
      log("info", "ipfs_cache_hit", { cid });
      return res.json(cached);
    }

    const lkg = getLkg(ipfsLkgKey(cid));
    try {
      log("info", "ipfs_fetch", { cid });

      const result = await ipfsService.fetchContent(cid);

      setCachedContent(cid, result.data);
      setLkg(ipfsLkgKey(cid), result.data);
      markHealthy("ipfs");

      log("info", "ipfs_fetch_success", { cid });

      res.set("Content-Security-Policy", "default-src 'none'");
      res.set("Content-Disposition", "attachment");

      if (typeof result.data === "object") {
        res.json(result.data);
      } else {
        res.json({ content: result.data, contentType: result.contentType });
      }
    } catch (err) {
      const message = (err as Error).message;
      log("error", "ipfs_fetch_failed", { cid, error: message });
      markDegraded("ipfs", message);
      noteDegraded("ipfs");

      if (lkg != null) {
        return sendPartial(
          res,
          {
            ...(typeof lkg === "object" && lkg !== null
              ? (lkg as Record<string, unknown>)
              : { content: lkg }),
            stale: true,
            source: "last_known_good",
          },
          ["ipfs"],
        );
      }

      // Placeholder so UI can keep rendering
      return sendPartial(
        res,
        {
          placeholder: true,
          cid,
          error: "IPFS unavailable",
          message: "Content temporarily unavailable — showing placeholder",
        },
        ["ipfs"],
      );
    }
  }) as AsyncHandler,
);

/**
 * GET /ipfs/image/:cid - Fetch raw image from IPFS
 */
router.get(
  "/ipfs/image/:cid",
  ipfsReadLimiter,
  validateParams(cidParamsSchema),
  (async (req: Request, res: Response) => {
    if (!config.ipfsEnabled) {
      return res.status(503).json({ error: "IPFS service not configured" });
    }

    const { cid } = (req as any).validatedParams;

    try {
      log("info", "ipfs_fetch_image", { cid });

      const result = await ipfsService.fetchRawContent(cid);

      const detectedMime = detectMimeType(result.buffer);
      const finalMimeType = detectedMime || result.contentType;

      if (
        finalMimeType.includes("html") ||
        finalMimeType.includes("svg") ||
        finalMimeType.includes("javascript") ||
        finalMimeType.includes("xml")
      ) {
        return res.status(403).json({ error: "Forbidden content type" });
      }

      log("info", "ipfs_fetch_image_success", {
        cid,
        contentType: finalMimeType,
      });

      res.set("Content-Type", finalMimeType);
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      res.set("Cross-Origin-Resource-Policy", "cross-origin");

      if (finalMimeType.startsWith("image/")) {
        res.set(
          "Content-Security-Policy",
          "default-src 'none'; img-src 'self'",
        );
      } else {
        res.set("Content-Security-Policy", "default-src 'none'");
        res.set("Content-Disposition", "attachment");
      }

      res.send(result.buffer);
    } catch (err) {
      log("error", "ipfs_fetch_image_failed", {
        cid,
        error: (err as Error).message,
      });
      res.status(500).json({ error: "Failed to fetch image from IPFS" });
    }
  }) as AsyncHandler,
);

export default router;
