/**
 * Graceful Degradation Middleware (#204)
 *
 * Request-scoped bag of degraded services. On response, sets:
 *   X-Service-Degraded: ipfs,comments
 *   X-Service-Status: ipfs=degraded;comments=degraded
 */
import { AsyncLocalStorage } from "async_hooks";
import { getDegradedServiceNames } from "../services/service-health.js";
const als = new AsyncLocalStorage();
export function degradationContext(_req, res, next) {
    const store = { noted: new Set() };
    als.run(store, () => {
        const originalJson = res.json.bind(res);
        res.json = ((body) => {
            applyDegradationHeaders(res);
            return originalJson(body);
        });
        const originalSend = res.send.bind(res);
        res.send = ((body) => {
            applyDegradationHeaders(res);
            return originalSend(body);
        });
        next();
    });
}
function applyDegradationHeaders(res) {
    if (res.headersSent)
        return;
    const store = als.getStore();
    const fromRequest = store ? Array.from(store.noted) : [];
    const fromRegistry = getDegradedServiceNames();
    const all = Array.from(new Set([...fromRequest, ...fromRegistry]));
    if (all.length === 0)
        return;
    res.setHeader("X-Service-Degraded", all.join(","));
    res.setHeader("X-Service-Status", all.map((s) => `${s}=degraded`).join(";"));
}
/** Mark a service as degraded for this request (and optionally globally). */
export function noteDegraded(service) {
    const store = als.getStore();
    if (store)
        store.noted.add(service);
}
/**
 * Send a partial success response with degradation indicators.
 */
export function sendPartial(res, body, services, statusCode = 200) {
    for (const s of services)
        noteDegraded(s);
    res.status(statusCode).json({
        ...body,
        degraded: true,
        degradedServices: services,
    });
}
//# sourceMappingURL=degradation.js.map