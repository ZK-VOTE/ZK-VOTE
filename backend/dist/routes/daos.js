// @ts-nocheck
/**
 * DAO Routes
 *
 * Handles DAO listing, retrieval, and sync operations.
 */
import { Router } from "express";
import { log } from "../services/logger.js";
import * as dbService from "../services/db.js";
import { syncDaosFromContract, daoMembersCache, daoAdminsCache, } from "../services/sync.js";
import { authGuard, auditLog, queryLimiter, validateParams, noteDegraded, validateQuery, bodyLimit, } from "../middleware/index.js";
import { getServiceHealth, } from "../services/service-health.js";
import { daoParamsSchema, daosQuerySchema, proposalsQuerySchema, } from "../validation/schemas.js";
import multer from "multer";
import sharp from "sharp";
import { config, LIMITS, ALLOWED_IMAGE_MIMES } from "../config.js";
import { detectMimeType, validationLock, containsEmbeddedScript, isPolyglot, } from "../utils/magic-bytes.js";
import * as ipfsService from "../services/ipfs.js";
const router = Router();
/**
 * GET /daos - Get all DAOs with limit/offset pagination
 */
router.get("/daos", queryLimiter, validateQuery(daosQuerySchema), (async (req, res) => {
    const { limit, offset, user, search, membershipType } = req.validatedQuery;
    const pageOffset = offset;
    try {
        // The DAO list is served from the sync cache whether or not a user was
        // supplied, so the degradation note applies to both cases.
        const syncHealth = getServiceHealth("dao_sync");
        if (syncHealth.state !== "healthy") {
            noteDegraded("dao_sync");
        }
        let filteredDaos = dbService.getAllCachedDaos();
        // Apply free-text search on DAO name (case-insensitive substring)
        if (search) {
            const lowerSearch = search.toLowerCase();
            filteredDaos = filteredDaos.filter((dao) => dao.name.toLowerCase().includes(lowerSearch));
        }
        // Apply membership type filter
        if (membershipType === "open") {
            filteredDaos = filteredDaos.filter((dao) => dao.membership_open);
        }
        else if (membershipType === "closed") {
            filteredDaos = filteredDaos.filter((dao) => !dao.membership_open);
        }
        // `user` is already format-checked by daosQuerySchema, so an invalid
        // address never reaches this handler; it is only used to annotate roles.
        const allDaos = filteredDaos;
        const annotatedDaos = user
            ? filteredDaos.map((dao) => {
                const adminAddr = daoAdminsCache.get(dao.id) || dao.creator;
                if (adminAddr === user) {
                    return { ...dao, role: "admin" };
                }
                const members = daoMembersCache.get(dao.id);
                if (members && members.has(user)) {
                    return { ...dao, role: "member" };
                }
                return { ...dao, role: null };
            })
            : allDaos;
        const total = annotatedDaos.length;
        const paginatedDaos = annotatedDaos.slice(pageOffset, pageOffset + limit);
        const hasMore = pageOffset + limit < total;
        log("info", "get_daos_paginated", {
            user: user ? `${user.slice(0, 8)}...` : null,
            count: paginatedDaos.length,
            total,
            offset: pageOffset,
            limit,
            search: search ?? null,
            membershipType: membershipType ?? null,
        });
        // `pagination.cursor` is the *next* page cursor (echoed back as ?cursor=
        // by the frontend, which `daosQuerySchema` folds into offset); it is
        // undefined on the last page so clients stop auto-paginating.
        res.json({
            data: paginatedDaos,
            pagination: {
                cursor: hasMore ? String(offset + limit) : undefined,
                hasMore,
                limit,
                offset,
                total,
            },
            lastSync: dbService.getDaosSyncTime(),
            cached: true,
        });
    }
    catch (err) {
        log("error", "get_daos_failed", { error: err.message });
        res.status(500).json({ error: "Failed to get DAOs" });
    }
}));
/**
 * GET /dao/:daoId - Get specific DAO from cache
 */
router.get("/dao/:daoId", queryLimiter, validateParams(daoParamsSchema), (req, res) => {
    const { daoId } = req.validatedParams;
    try {
        const dao = dbService.getCachedDao(daoId);
        if (!dao) {
            return res.status(404).json({ error: "DAO not found in cache" });
        }
        res.json({ dao, cached: true });
    }
    catch (err) {
        log("error", "get_dao_failed", { daoId, error: err.message });
        res.status(500).json({ error: "Failed to get DAO" });
    }
});
/**
 * POST /daos/sync - Trigger manual DAO sync (admin only)
 */
router.post("/daos/sync", bodyLimit("1kb"), authGuard, auditLog("daos_sync"), (async (req, res) => {
    try {
        const synced = await syncDaosFromContract();
        res.json({ success: true, synced });
    }
    catch (err) {
        log("error", "dao_sync_failed", { error: err.message });
        res.status(500).json({ error: "Failed to sync DAOs" });
    }
}));
router.post("/dao/:daoId/notifications/subscribe", bodyLimit("1kb"), authGuard, auditLog("dao_notifications_subscribe"), validateParams(daoParamsSchema), (req, res) => {
    try {
        const { daoId } = req.validatedParams;
        const { walletAddress } = req.body ?? {};
        if (typeof walletAddress !== "string" || walletAddress.trim().length === 0) {
            return res.status(400).json({ error: "walletAddress is required" });
        }
        const result = dbService.subscribeToDaoProposalLifecycle(daoId, walletAddress);
        return res.json({
            success: true,
            active: result.active,
            walletAddressHash: result.walletAddressHash,
        });
    }
    catch (err) {
        log("error", "dao_notifications_subscribe_failed", {
            error: err.message,
        });
        return res.status(500).json({ error: "Failed to subscribe to DAO notifications" });
    }
});
router.post("/dao/:daoId/notifications/unsubscribe", bodyLimit("1kb"), authGuard, auditLog("dao_notifications_unsubscribe"), validateParams(daoParamsSchema), (req, res) => {
    try {
        const { daoId } = req.validatedParams;
        const { walletAddress } = req.body ?? {};
        if (typeof walletAddress !== "string" || walletAddress.trim().length === 0) {
            return res.status(400).json({ error: "walletAddress is required" });
        }
        const result = dbService.unsubscribeFromDaoProposalLifecycle(daoId, walletAddress);
        return res.json({
            success: result.success,
            active: result.active,
            walletAddressHash: result.walletAddressHash,
        });
    }
    catch (err) {
        log("error", "dao_notifications_unsubscribe_failed", {
            error: err.message,
        });
        return res.status(500).json({ error: "Failed to unsubscribe from DAO notifications" });
    }
});
router.get("/dao/:daoId/notifications/subscriptions", queryLimiter, validateParams(daoParamsSchema), (req, res) => {
    try {
        const { daoId } = req.validatedParams;
        const subscriptions = dbService.listDaoProposalLifecycleSubscriptions(daoId);
        res.json({ data: subscriptions });
    }
    catch (err) {
        log("error", "dao_notifications_list_failed", {
            daoId: req.validatedParams?.daoId,
            error: err.message,
        });
        res.status(500).json({ error: "Failed to list DAO notifications" });
    }
});
router.get("/dao/:daoId/notifications", queryLimiter, validateParams(daoParamsSchema), (req, res) => {
    try {
        const { daoId } = req.validatedParams;
        const eventType = req.query.eventType;
        const notifications = dbService.getDaoProposalLifecycleNotifications(daoId, {
            eventType,
        });
        res.json({ data: notifications });
    }
    catch (err) {
        log("error", "dao_notifications_history_failed", {
            daoId: req.validatedParams?.daoId,
            error: err.message,
        });
        res.status(500).json({ error: "Failed to load DAO notification history" });
    }
});
/**
 * GET /proposals/:daoId - Search and filter proposals for a DAO
 *
 * Query params:
 *  - status    : active | closed | all (default all)
 *  - search    : free-text substring match on proposal title
 *  - limit     : page size (1 – 500, default 100)
 *  - offset    : zero-based page start
 *
 * Authorization: public (queryLimiter rate-limited)
 */
router.get("/proposals/:daoId", queryLimiter, validateParams(daoParamsSchema), validateQuery(proposalsQuerySchema), (async (req, res) => {
    const { daoId } = req.validatedParams;
    const { limit, offset, status, search } = req
        .validatedQuery;
    try {
        // Pull proposal_created events from the per-DAO partition table
        const now = Date.now();
        const { events } = dbService.getEventsForDao(daoId, {
            types: ["proposal_created"],
            limit: 1000, // Fetch a broad window; we filter in memory
            offset: 0,
            orderBy: "timestamp",
            orderDirection: "DESC",
        });
        // Shape raw events into lightweight proposal summaries
        let proposals = events.map((evt) => {
            const data = (evt.data ?? {});
            const endTime = data.end_time ?? 0;
            const isClosed = !!data.closed || (endTime > 0 && endTime * 1000 < now);
            return {
                proposalId: data.proposal_id ?? null,
                title: data.title ?? "",
                endTime,
                closed: isClosed,
                txHash: evt.tx_hash ?? null,
                timestamp: evt.timestamp,
            };
        });
        // Apply status filter
        if (status === "active") {
            proposals = proposals.filter((p) => !p.closed);
        }
        else if (status === "closed") {
            proposals = proposals.filter((p) => p.closed);
        }
        // Apply free-text search on title
        if (search) {
            const lowerSearch = search.toLowerCase();
            proposals = proposals.filter((p) => p.title.toLowerCase().includes(lowerSearch));
        }
        const total = proposals.length;
        const paginated = proposals.slice(offset, offset + limit);
        const hasMore = offset + limit < total;
        log("info", "get_proposals_filtered", {
            daoId,
            status,
            search: search ?? null,
            total,
            offset,
            limit,
        });
        res.json({
            data: paginated,
            pagination: {
                cursor: hasMore ? String(offset + limit) : undefined,
                hasMore,
                total,
            },
            filters: { status, search: search ?? null },
        });
    }
    catch (err) {
        log("error", "get_proposals_failed", {
            daoId,
            error: err.message,
        });
        res.status(500).json({ error: "Failed to get proposals" });
    }
}));
// ============================================
// DAO THUMBNAIL UPLOAD (ATOMIC TOCTOU PROTECTED)
// ============================================
const thumbnailUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: LIMITS.MAX_IMAGE_SIZE,
        files: 1,
    },
    fileFilter: (_req, file, cb) => {
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
const handleThumbnailUpload = async (req, res) => {
    const daoIdParam = req.params.daoId;
    const daoId = parseInt(daoIdParam, 10);
    if (isNaN(daoId) || daoId < 0) {
        return res.status(400).json({ error: "Invalid DAO ID" });
    }
    const dao = dbService.getCachedDao(daoId);
    if (!dao) {
        return res.status(404).json({ error: "DAO not found" });
    }
    const user = req.headers["x-user-address"] ??
        req.headers["x-caller-address"] ??
        req.user?.address ??
        req.user?.id ??
        req.authClientId ??
        req.body?.user;
    const adminAddr = daoAdminsCache.get(daoId) || dao.creator;
    if (user && adminAddr && user !== adminAddr && user !== dao.creator) {
        return res.status(403).json({
            error: "Only DAO admin or creator can upload thumbnail",
        });
    }
    if (!config.ipfsEnabled) {
        return res.status(503).json({ error: "IPFS service not configured" });
    }
    if (!req.file) {
        return res.status(400).json({ error: "No thumbnail image file provided" });
    }
    try {
        const file = req.file;
        const initialBuffer = Buffer.from(file.buffer);
        // Lock by daoId to serialize all thumbnail updates for this DAO
        const lockKey = `dao-thumb-${daoId}`;
        const result = await validationLock.acquire(lockKey, async () => {
            // 1. Detect MIME via magic bytes
            const detectedMime = detectMimeType(initialBuffer);
            if (!detectedMime || !ALLOWED_IMAGE_MIMES.includes(detectedMime)) {
                throw new Error(`File content is not a supported image (detected: ${detectedMime || "unknown"}).`);
            }
            // 2. Embedded script & polyglot scanning (anti-TOCTOU, anti-malware)
            if (containsEmbeddedScript(initialBuffer) || isPolyglot(initialBuffer)) {
                throw new Error("Malicious content or polyglot format detected.");
            }
            // 3. Sharp metadata inspection & dimensions
            let metadata;
            try {
                metadata = await sharp(initialBuffer, { failOn: "error" }).metadata();
            }
            catch {
                throw new Error("Unable to read image metadata or corrupted image.");
            }
            if (!metadata.width ||
                !metadata.height ||
                metadata.width > LIMITS.MAX_IMAGE_DIMENSION ||
                metadata.height > LIMITS.MAX_IMAGE_DIMENSION) {
                throw new Error(`Image dimensions exceed maximum allowed ${LIMITS.MAX_IMAGE_DIMENSION}x${LIMITS.MAX_IMAGE_DIMENSION}.`);
            }
            // 4. Sharp sanitization: strip metadata, normalize orientation
            let sanitizedBuffer;
            try {
                sanitizedBuffer = await sharp(initialBuffer, { failOn: "error" })
                    .rotate()
                    .withMetadata(false)
                    .toBuffer();
            }
            catch {
                throw new Error("Image sanitization failed.");
            }
            // 5. Atomic pin to IPFS
            const pinResult = await ipfsService.pinFile(sanitizedBuffer, `dao-${daoId}-thumbnail-${file.originalname}`, detectedMime);
            // 6. Update DAO record in DB cache
            dbService.updateDaoThumbnail(daoId, pinResult.cid);
            return {
                cid: pinResult.cid,
                size: pinResult.size,
                mimeType: detectedMime,
                width: metadata.width,
                height: metadata.height,
            };
        });
        log("info", "dao_thumbnail_uploaded", {
            daoId,
            cid: result.cid,
            user,
        });
        res.json({
            success: true,
            daoId,
            cid: result.cid,
            size: result.size,
            mimeType: result.mimeType,
            width: result.width,
            height: result.height,
        });
    }
    catch (err) {
        log("error", "dao_thumbnail_upload_failed", {
            daoId,
            error: err.message,
        });
        res.status(400).json({ error: err.message || "Failed to upload thumbnail" });
    }
};
router.post("/daos/:daoId/thumbnail", authGuard, auditLog("dao_thumbnail_upload"), thumbnailUpload.single("image"), handleThumbnailUpload);
router.post("/dao/:daoId/thumbnail", authGuard, auditLog("dao_thumbnail_upload"), thumbnailUpload.single("image"), handleThumbnailUpload);
export default router;
//# sourceMappingURL=daos.js.map