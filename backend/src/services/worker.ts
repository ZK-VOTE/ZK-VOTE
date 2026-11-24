/**
 * Background worker abstraction (#358 follow-up).
 *
 * Every long-running loop/timer owned by the backend is represented by a
 * `BackgroundWorker`: a named unit with `start()`, `stop()` and `health()`.
 * `WorkerRegistry` composes workers, starts them in registration order and
 * drains them in reverse order with a bounded timeout.
 *
 * This module is intentionally dependency-free so it can be used both by the
 * composition root and by unit tests without booting Express, the database or
 * the Stellar RPC client.
 */

/** Lifecycle state tracked by `createWorker`. */
export type WorkerStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "failed"
  | "disabled";

/** Snapshot returned by `BackgroundWorker.health()`. */
export interface WorkerHealth {
  readonly name: string;
  readonly status: WorkerStatus;
  readonly enabled: boolean;
  readonly startedAt?: string;
  readonly stoppedAt?: string;
  readonly lastError?: string;
  /** Optional worker-specific detail (queue depth, last tick, ...). */
  readonly detail?: unknown;
}

/** Contract every background worker fulfils. */
export interface BackgroundWorker {
  readonly name: string;
  readonly enabled: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<WorkerHealth>;
}

/** Declarative definition accepted by `createWorker`. */
export interface WorkerDefinition {
  name: string;
  start: () => void | Promise<void>;
  stop: () => void | Promise<void>;
  /** Optional worker-specific health detail. */
  health?: () => unknown | Promise<unknown>;
  /** Disabled workers are skipped by startAll/stopAll and report `disabled`. */
  enabled?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wrap a start/stop pair into a `BackgroundWorker` with idempotent lifecycle,
 * state tracking and health reporting.
 */
export function createWorker(definition: WorkerDefinition): BackgroundWorker {
  const enabled = definition.enabled !== false;
  let status: WorkerStatus = enabled ? "stopped" : "disabled";
  let startedAt: string | undefined;
  let stoppedAt: string | undefined;
  let lastError: string | undefined;

  return {
    name: definition.name,
    enabled,

    async start(): Promise<void> {
      if (!enabled) return;
      if (status === "running" || status === "starting") return;
      status = "starting";
      try {
        await definition.start();
        status = "running";
        startedAt = new Date().toISOString();
        stoppedAt = undefined;
        lastError = undefined;
      } catch (error) {
        status = "failed";
        lastError = errorMessage(error);
        throw error;
      }
    },

    async stop(): Promise<void> {
      if (!enabled) return;
      if (status === "stopped" || status === "disabled") return;
      status = "stopping";
      try {
        await definition.stop();
      } catch (error) {
        status = "failed";
        lastError = errorMessage(error);
        throw error;
      } finally {
        stoppedAt = new Date().toISOString();
        if (status === "stopping") status = "stopped";
      }
    },

    async health(): Promise<WorkerHealth> {
      let detail: unknown;
      if (definition.health) {
        try {
          detail = await definition.health();
        } catch (error) {
          lastError = errorMessage(error);
        }
      }
      return {
        name: definition.name,
        status,
        enabled,
        ...(startedAt ? { startedAt } : {}),
        ...(stoppedAt ? { stoppedAt } : {}),
        ...(lastError ? { lastError } : {}),
        ...(detail !== undefined ? { detail } : {}),
      };
    },
  };
}

/** Error thrown when a worker's `stop()` exceeds the drain budget. */
export class WorkerStopTimeoutError extends Error {
  constructor(
    readonly worker: string,
    readonly timeoutMs: number,
  ) {
    super(`Worker "${worker}" stop timed out after ${timeoutMs}ms`);
    this.name = "WorkerStopTimeoutError";
  }
}

/** Registry lifecycle event (used for logging/metrics by the caller). */
export interface WorkerRegistryEvent {
  type: "start" | "stop" | "error" | "timeout";
  worker: string;
  error?: unknown;
}

export interface WorkerRegistryOptions {
  /** Total budget for `stopAll()` across all workers (default 30s). */
  drainTimeoutMs?: number;
  onEvent?: (event: WorkerRegistryEvent) => void;
}

/** Ordered collection of background workers. */
export class WorkerRegistry {
  private readonly workers: BackgroundWorker[] = [];
  private readonly byName = new Map<string, BackgroundWorker>();

  constructor(private readonly options: WorkerRegistryOptions = {}) {}

  /** Register a ready-made worker or a definition to wrap with `createWorker`. */
  register(workerOrDefinition: BackgroundWorker | WorkerDefinition): BackgroundWorker {
    const worker =
      typeof (workerOrDefinition as BackgroundWorker).health === "function" &&
      typeof (workerOrDefinition as BackgroundWorker).start === "function"
        ? (workerOrDefinition as BackgroundWorker)
        : createWorker(workerOrDefinition as WorkerDefinition);

    if (this.byName.has(worker.name)) {
      throw new Error(`Worker "${worker.name}" is already registered`);
    }
    this.workers.push(worker);
    this.byName.set(worker.name, worker);
    return worker;
  }

  /** Register several workers/definitions in one call. */
  registerAll(
    workers: ReadonlyArray<BackgroundWorker | WorkerDefinition>,
  ): BackgroundWorker[] {
    return workers.map((worker) => this.register(worker));
  }

  get(name: string): BackgroundWorker | undefined {
    return this.byName.get(name);
  }

  list(): readonly BackgroundWorker[] {
    return this.workers;
  }

  /**
   * Start enabled workers in registration order. If one fails, every worker
   * that did start is drained in reverse order before the error is rethrown.
   */
  async startAll(): Promise<void> {
    const started: BackgroundWorker[] = [];
    try {
      for (const worker of this.workers) {
        if (!worker.enabled) continue;
        await worker.start();
        started.push(worker);
      }
    } catch (error) {
      this.options.onEvent?.({ type: "error", worker: "startAll", error });
      await this.stopWorkers([...started].reverse());
      throw error;
    }
  }

  /** Drain started workers in reverse registration order, with a timeout. */
  async stopAll(): Promise<void> {
    const draining = [...this.workers].filter((worker) => worker.enabled).reverse();
    await this.stopWorkers(draining);
  }

  /** Health snapshot for every registered worker, keyed by name. */
  async healthAll(): Promise<Record<string, WorkerHealth>> {
    const result: Record<string, WorkerHealth> = {};
    for (const worker of this.workers) {
      result[worker.name] = await worker.health();
    }
    return result;
  }

  private async stopWorkers(workers: readonly BackgroundWorker[]): Promise<void> {
    const timeoutMs = Math.max(0, this.options.drainTimeoutMs ?? 30_000);
    const deadline = Date.now() + timeoutMs;
    const failures: Error[] = [];

    for (const worker of workers) {
      const remaining = Math.max(0, deadline - Date.now());
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        // Keep this timer referenced: a hung worker's stop promise must not
        // let the event loop drain before the timeout gets a chance to fire.
        timer = setTimeout(
          () => reject(new WorkerStopTimeoutError(worker.name, timeoutMs)),
          remaining,
        );
      });

      try {
        await Promise.race([Promise.resolve(worker.stop()), timeout]);
      } catch (error) {
        failures.push(
          error instanceof Error ? error : new Error(errorMessage(error)),
        );
        this.options.onEvent?.({
          type: error instanceof WorkerStopTimeoutError ? "timeout" : "error",
          worker: worker.name,
          error,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${failures.length} worker(s) failed to stop cleanly`,
      );
    }
  }
}

/** Convenience factory matching the other `create*` helpers in the codebase. */
export function createWorkerRegistry(
  options?: WorkerRegistryOptions,
): WorkerRegistry {
  return new WorkerRegistry(options);
}
