/**
 * Zod Validation Middleware
 *
 * Express middleware for request body and query validation using Zod schemas.
 */
import { config } from "../config.js";
import { log } from "../services/logger.js";
/**
 * Format Zod errors into user-friendly messages
 */
function formatZodError(error) {
    return error.errors.map((err) => ({
        field: err.path.join(".") || "body",
        message: err.message,
    }));
}
/**
 * Create validation middleware for request body
 */
export function validateBody(schema) {
    return (req, res, next) => {
        // Handle stripped request bodies in test mode
        if (config.stripRequestBodies) {
            return res.status(400).json({ error: "Request body stripping enabled" });
        }
        const result = schema.safeParse(req.body);
        if (!result.success) {
            const errors = formatZodError(result.error);
            log("warn", "validation_failed", {
                path: req.path,
                errors: errors.slice(0, 5), // Limit logged errors
            });
            return res.status(400).json({
                error: "Validation failed",
                details: config.genericErrors ? undefined : errors,
            });
        }
        // Replace body with validated/transformed data
        req.body = result.data;
        next();
    };
}
/**
 * Create validation middleware for query parameters
 */
export function validateQuery(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.query);
        if (!result.success) {
            const errors = formatZodError(result.error);
            log("warn", "query_validation_failed", {
                path: req.path,
                errors: errors.slice(0, 5),
            });
            return res.status(400).json({
                error: "Invalid query parameters",
                details: config.genericErrors ? undefined : errors,
            });
        }
        // Replace query with validated/transformed data
        req.validatedQuery = result.data;
        next();
    };
}
/**
 * Create validation middleware for URL parameters
 */
export function validateParams(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.params);
        if (!result.success) {
            const errors = formatZodError(result.error);
            return res.status(400).json({
                error: "Invalid URL parameters",
                details: config.genericErrors ? undefined : errors,
            });
        }
        req.validatedParams = result.data;
        next();
    };
}
//# sourceMappingURL=validate.js.map