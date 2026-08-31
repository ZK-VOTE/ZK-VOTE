/**
 * Database Worker Thread Execution Handler
 *
 * Runs SQLite queries in isolated worker threads using better-sqlite3.
 * Listens for query messages from the main thread and responds with execution results.
 */
export interface WorkerInitData {
    dbPath: string;
    isWriter: boolean;
    workerId: number;
}
export interface WorkerMessageRequest {
    id: string;
    type: "query" | "queryOne" | "execute" | "exec";
    sql: string;
    params?: any[];
}
export interface WorkerMessageResponse {
    id: string;
    success: boolean;
    result?: any;
    error?: string;
    durationMs: number;
}
//# sourceMappingURL=dbWorker.d.ts.map