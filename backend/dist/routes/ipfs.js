/**
 * IPFS Routes
 *
 * Handles IPFS uploads (images, metadata) and content retrieval.
 */
import { Router } from "express";
import multer from "multer";
import { config, LIMITS, ALLOWED_IMAGE_MIMES } from "../config.js";
import { log } from "../services/logger.js";
import * as ipfsService from "../services/ipfs.js";
import { authGuard, auditLog, queryLimiter, ipfsUploadLimiter, ipfsReadLimiter, validateParams, noteDegraded, sendPartial, bodyLimit, } from "../middleware/index.js";
import { cidParamsSchema } from "../validation/schemas.js";
import { markDegraded, markHealthy, setLkg, getLkg, ipfsLkgKey, enqueueDegradedWrite, drainIpfsPinQueue, } from "../services/service-health.js";
import { detectMimeType } from "../utils/magic-bytes.js";
const router = Router();
// ============================================
// IPFS SECURITY MIDDLEWARE
// ============================================
router.use(["/ipfs/:cid", "/ipfs/image/:cid"], (req, res, next) => {
    // Origin isolation
    if (config.ipfsSubdomain &&
        req.hostname !== config.ipfsSubdomain &&
        !config.testMode) {
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
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: LIMITS.MAX_IMAGE_SIZE,
        files: 1,
    },
    fileFilter: (_req, file, cb) => {
        log("info", "upload_file_filter", {
            mimetype: file.mimetype,
            originalname: file.originalname,
        });
        if (ALLOWED_IMAGE_MIMES.includes(file.mimetype) ||
            file.mimetype?.startsWith("image/")) {
            cb(null, true);
        }
        else {
            const err = new Error(`Unsupported file type: ${file.mimetype || "unknown"}. Allowed: JPEG, PNG, GIF, WebP, AVIF, HEIC.`);
            err.code = "INVALID_FILE_TYPE";
            cb(err);
        }
    },
});
const MAX_CACHE_SIZE = 500;
const ipfsCache = new Map();
function getCachedContent(cid) {
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
function setCachedContent(cid, data) {
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
router.get("/ipfs/health", queryLimiter, (async (req, res) => {
    if (!config.ipfsEnabled) {
        return res.json({ enabled: false, status: "not_configured" });
    }
    try {
        const healthy = await ipfsService.isHealthy();
        // Get enhanced pin verification data
        let pinStatus;
        try {
            pinStatus = ipfsService.getEnhancedHealth();
        }
        catch {
            pinStatus = null;
        }
        if (healthy) {
            markHealthy("ipfs");
            // Best-effort drain of queued pinJSON ops
            void drainIpfsPinQueue(async (payload) => ipfsService.pinJSON(payload.data, payload.name ?? "zkvote-queued"));
        }
        else {
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
    }
    catch (err) {
        markDegraded("ipfs", err.message);
        noteDegraded("ipfs");
        res.json({
            enabled: true,
            status: "error",
            error: err.message,
        });
    }
}));
/**
 * POST /ipfs/image - Upload image to IPFS
 */
router.post("/ipfs/image", 
// N1 hardening: was unauthenticated. Requires AUTH_TOKEN now even though
// the token is shipped in the public frontend bundle — keeps random
// internet attackers off the multer parser + Pinata bill.
authGuard, auditLog("ipfs_upload_image"), ipfsUploadLimiter, (req, res, next) => {
    upload.single("image")(req, res, (err) => {
        if (err) {
            if (err.code === "LIMIT_FILE_SIZE") {
                return res
                    .status(400)
                    .json({ error: "File too large. Maximum size is 5MB." });
            }
            if (err.code === "INVALID_FILE_TYPE" ||
                err.message?.includes("file type")) {
                return res.status(400).json({ error: err.message });
            }
            log("error", "multer_error", { code: err.code, message: err.message });
            return res
                .status(400)
                .json({ error: err.message || "File upload failed" });
        }
        next();
    });
}, (async (req, res) => {
    if (!config.ipfsEnabled) {
        return res.status(503).json({ error: "IPFS service not configured" });
    }
    if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
    }
    try {
        log("info", "ipfs_upload_image", {
            filename: req.file.originalname,
            size: req.file.size,
            mimetype: req.file.mimetype,
        });
        const result = await ipfsService.pinFile(req.file.buffer, req.file.originalname, req.file.mimetype);
        log("info", "ipfs_upload_success", { cid: result.cid, type: "image" });
        res.json({
            cid: result.cid,
            size: result.size,
            filename: req.file.originalname,
            mimeType: req.file.mimetype,
        });
    }
    catch (err) {
        log("error", "ipfs_upload_failed", {
            error: err.message,
            type: "image",
        });
        res.status(500).json({ error: "Failed to upload image to IPFS" });
    }
}));
/**
 * POST /ipfs/metadata - Upload JSON metadata to IPFS
 */
// N1 hardening: was unauthenticated — see /ipfs/image rationale.
router.post("/ipfs/metadata", bodyLimit("50kb"), authGuard, auditLog("ipfs_upload_metadata"), ipfsUploadLimiter, (async (req, res) => {
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
        const videoPattern = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com)\/.+$/i;
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
        const result = await ipfsService.pinJSON(sanitizedMetadata, "zkvote-proposal-metadata");
        markHealthy("ipfs");
        log("info", "ipfs_upload_success", { cid: result.cid, type: "metadata" });
        res.json({
            cid: result.cid,
            size: result.size,
        });
    }
    catch (err) {
        const message = err.message;
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
        sendPartial(res, {
            queued: true,
            queueId: queued.id,
            error: "IPFS unavailable — metadata queued for retry",
        }, ["ipfs"], 202);
    }
}));
/**
 * GET /ipfs/:cid - Fetch content from IPFS (JSON)
 */
router.get("/ipfs/:cid", ipfsReadLimiter, validateParams(cidParamsSchema), (async (req, res) => {
    if (!config.ipfsEnabled) {
        return res.status(503).json({ error: "IPFS service not configured" });
    }
    const { cid } = req.validatedParams;
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
        }
        else {
            res.json({ content: result.data, contentType: result.contentType });
        }
    }
    catch (err) {
        const message = err.message;
        log("error", "ipfs_fetch_failed", { cid, error: message });
        markDegraded("ipfs", message);
        noteDegraded("ipfs");
        if (lkg != null) {
            return sendPartial(res, {
                ...(typeof lkg === "object" && lkg !== null
                    ? lkg
                    : { content: lkg }),
                stale: true,
                source: "last_known_good",
            }, ["ipfs"]);
        }
        // Placeholder so UI can keep rendering
        return sendPartial(res, {
            placeholder: true,
            cid,
            error: "IPFS unavailable",
            message: "Content temporarily unavailable — showing placeholder",
        }, ["ipfs"]);
    }
}));
/**
 * GET /ipfs/image/:cid - Fetch raw image from IPFS
 */
router.get("/ipfs/image/:cid", ipfsReadLimiter, validateParams(cidParamsSchema), (async (req, res) => {
    if (!config.ipfsEnabled) {
        return res.status(503).json({ error: "IPFS service not configured" });
    }
    const { cid } = req.validatedParams;
    try {
        log("info", "ipfs_fetch_image", { cid });
        const result = await ipfsService.fetchRawContent(cid);
        const detectedMime = detectMimeType(result.buffer);
        const finalMimeType = detectedMime || result.contentType;
        if (finalMimeType.includes("html") ||
            finalMimeType.includes("svg") ||
            finalMimeType.includes("javascript") ||
            finalMimeType.includes("xml")) {
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
            res.set("Content-Security-Policy", "default-src 'none'; img-src 'self'");
        }
        else {
            res.set("Content-Security-Policy", "default-src 'none'");
            res.set("Content-Disposition", "attachment");
        }
        res.send(result.buffer);
    }
    catch (err) {
        log("error", "ipfs_fetch_image_failed", {
            cid,
            error: err.message,
        });
        res.status(500).json({ error: "Failed to fetch image from IPFS" });
    }
}));
export default router;
//# sourceMappingURL=ipfs.js.map