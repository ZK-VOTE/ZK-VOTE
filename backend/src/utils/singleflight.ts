import {
  coalescingHitsTotal,
  coalescingMissesTotal,
  coalescingWaitTime,
} from "../services/metrics.js";

/** "root:42" → "root"; anything without a recognisable prefix → "other". */
export function keyScope(key: string): string {
  const prefix = key.split(":")[0];
  return /^[a-z][a-z0-9_-]{0,31}$/i.test(prefix) && prefix !== key
    ? prefix
    : "other";
}

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
    // Keys embed ids ("root:42"); the metric label is only the prefix (#749).
    const scope = keyScope(key);

    if (existing) {
      coalescingHitsTotal.inc({ scope });
      const timer = coalescingWaitTime.startTimer({ scope });
      try {
        return await existing.promise;
      } finally {
        timer();
      }
    }

    coalescingMissesTotal.inc({ scope });

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
