/**
 * Zod Validation Middleware
 *
 * Express middleware for request body and query validation using Zod schemas.
 */
import type { Request, Response, NextFunction } from "express";
import type { ZodType } from "zod";
/**
 * Create validation middleware for request body
 */
export declare function validateBody<T>(schema: ZodType<T, any, any>): (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
/**
 * Create validation middleware for query parameters
 */
export declare function validateQuery<T>(schema: ZodType<T, any, any>): (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
/**
 * Create validation middleware for URL parameters
 */
export declare function validateParams<T>(schema: ZodType<T, any, any>): (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
//# sourceMappingURL=validate.d.ts.map