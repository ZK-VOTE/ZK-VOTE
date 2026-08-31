import { ErrorCode } from "../types/index.js";
export declare class ApiError extends Error {
    statusCode: number;
    code: ErrorCode;
    details?: unknown;
    constructor(statusCode: number, code: ErrorCode, message: string, details?: unknown);
}
//# sourceMappingURL=errors.d.ts.map