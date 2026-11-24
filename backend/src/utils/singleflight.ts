import {
  coalescingHitsTotal,
  coalescingMissesTotal,
  coalescingWaitTime,
  normalizeCoalesceKey,
} from "../services/metrics.js";

interface Call {
  promise: Promise<any>;
}

export class SingleFlight {
  private calls = new Map<string, Call>();

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
  async do<T>(
    key: string,
    fn: () => Promise<T>,
    timeoutMs: number = 30000,
  ): Promise<T> {
    const existing = this.calls.get(key);
    const operation = normalizeCoalesceKey(key);

    if (existing) {
      coalescingHitsTotal.inc({ operation });
      const timer = coalescingWaitTime.startTimer({ operation });
      try {
        return await existing.promise;
      } finally {
        timer();
      }
    }

    coalescingMissesTotal.inc({ operation });

    const promise = new Promise<T>((resolve, reject) => {
      // Execute the function
      const fnPromise = fn();

      let timeoutId: NodeJS.Timeout | null = null;
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          reject(new Error(`SingleFlight timeout for key: ${key}`));
        }, timeoutMs);
      }

      fnPromise
        .then((res) => {
          if (timeoutId) clearTimeout(timeoutId);
          resolve(res);
        })
        .catch((err) => {
          if (timeoutId) clearTimeout(timeoutId);
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
