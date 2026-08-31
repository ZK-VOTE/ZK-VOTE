declare const router: import("express-serve-static-core").Router;
type ShutdownHandler = (reason: string) => void | Promise<void>;
/**
 * Wire the server's graceful-shutdown function to the /admin/shutdown
 * route. Called once at startup from index.ts.
 */
export declare function registerShutdownHandler(handler: ShutdownHandler): void;
export default router;
//# sourceMappingURL=admin.d.ts.map