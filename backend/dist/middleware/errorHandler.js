/**
 * Global Error Handler Middleware
 *
 * Catches unhandled errors and returns standardized error responses.
 */
import { log } from "../services/logger.js";
/**
 * Global error handler middleware (must be last)
 */
export const errorHandler = (err, req, res, _next) => {
    log("error", "unhandled_error", {
        path: req.path,
        message: err.message,
    });
    res.status(500).json({ error: "Internal server error" });
};
//# sourceMappingURL=errorHandler.js.map