/**
 * Per-Route Body Size Limit
 *
 * express.json({ limit }) only accepts one global limit. This factory lets
 * each route apply a limit sized to its actual payload (#69) instead of
 * sharing one size across every endpoint, which either over-permits small
 * endpoints or under-permits large ones.
 */
import express from "express";
import { log } from "../services/logger.js";
/**
 * Returns an `express.json()` middleware capped at `limit` (e.g. "5kb").
 * Oversized payloads are rejected by express.json's own 413 handling; this
 * wrapper additionally logs the rejection for observability.
 */
export function bodyLimit(limit) {
    const parser = express.json({ limit });
    return (req, res, next) => {
        parser(req, res, (err) => {
            if (err) {
                log("warn", "request_body_rejected", {
                    path: req.path,
                    limit,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            next(err);
        });
    };
}
//# sourceMappingURL=bodyLimit.js.map