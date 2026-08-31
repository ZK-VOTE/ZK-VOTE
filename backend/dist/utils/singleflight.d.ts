export declare class SingleFlight {
    private calls;
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
    do<T>(key: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T>;
}
export declare const sharedSingleFlight: SingleFlight;
//# sourceMappingURL=singleflight.d.ts.map