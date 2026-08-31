import { coalescingHitsTotal, coalescingMissesTotal, coalescingWaitTime, } from "../services/metrics.js";
export class SingleFlight {
    calls = new Map();
    /**
     * Executes and returns the results of the given function, making sure that only one execution
     * is in-flight for a given key at a time. If a duplicate comes in, the duplicate caller waits
     * for the original to complete and receives the same results.
     *
     * @param key The deduplication key
     * @param fn The function to execute
     * @param timeoutMs Optional timeout in milliseconds. Defaults to 30000ms.
     * @returns The result of the function
     */
    async do(key, fn, timeoutMs = 30000) {
        const existing = this.calls.get(key);
        if (existing) {
            coalescingHitsTotal.inc({ key });
            const timer = coalescingWaitTime.startTimer({ key });
            try {
                return await existing.promise;
            }
            finally {
                timer();
            }
        }
        coalescingMissesTotal.inc({ key });
        const promise = new Promise((resolve, reject) => {
            // Execute the function
            const fnPromise = fn();
            let timeoutId = null;
            if (timeoutMs > 0) {
                timeoutId = setTimeout(() => {
                    reject(new Error(`SingleFlight timeout for key: ${key}`));
                }, timeoutMs);
            }
            fnPromise
                .then((res) => {
                if (timeoutId)
                    clearTimeout(timeoutId);
                resolve(res);
            })
                .catch((err) => {
                if (timeoutId)
                    clearTimeout(timeoutId);
                reject(err);
            })
                .finally(() => {
                // Clean up the map after the promise completes (success or error)
                this.calls.delete(key);
            });
        });
        this.calls.set(key, { promise });
        return promise;
    }
}
export const sharedSingleFlight = new SingleFlight();
//# sourceMappingURL=singleflight.js.map