/**
 * Explicit startup phases (#358 follow-up).
 *
 * Startup is a strict sequence:
 *
 *   config -> infrastructure -> services -> routes -> workers -> ready
 *
 * Every phase records its timing and a failed phase is terminal: the helper
 * refuses to advance past it. Failures are surfaced to the caller (which may
 * turn them into a non-zero process exit) instead of being silently swallowed.
 */

/** Ordered startup phases. */
export const STARTUP_PHASES = [
  "config",
  "infrastructure",
  "services",
  "routes",
  "workers",
  "ready",
] as const;

export type StartupPhase = (typeof STARTUP_PHASES)[number];

export type PhaseStatus = "ok" | "failed";

/** Timing record for a single phase. */
export interface PhaseTiming {
  phase: StartupPhase;
  status: PhaseStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  error?: string;
}

/** Why a phase transition was refused. */
export type StartupPhaseErrorReason = "failed" | "out-of-order" | "completed";

/** Thrown when a phase fails or when an invalid transition is attempted. */
export class StartupPhaseError extends Error {
  constructor(
    readonly phase: StartupPhase,
    readonly reason: StartupPhaseErrorReason,
    readonly originalError?: unknown,
    message?: string,
  ) {
    super(
      message ??
        (reason === "failed"
          ? `Startup phase "${phase}" failed`
          : `Invalid startup phase transition at "${phase}" (${reason})`),
    );
    this.name = "StartupPhaseError";
  }
}

export interface StartupPhasesOptions {
  onPhase?: (timing: PhaseTiming) => void;
}

/**
 * Tracks startup phase order and timings. Both `run` and `checkpoint` enforce
 * the same ordering and fail-closed semantics.
 */
export class StartupPhases {
  private readonly records: PhaseTiming[] = [];
  private index = -1;
  private failedPhase: StartupPhase | null = null;
  private activePhase: StartupPhase | null = null;
  /** Start of the timing window for the next synchronous phase. */
  private windowStart = Date.now();

  constructor(private readonly options: StartupPhasesOptions = {}) {}

  /** The last phase that finished successfully. */
  get phase(): StartupPhase | null {
    return this.index >= 0 ? STARTUP_PHASES[this.index] : null;
  }

  /** The phase that failed, if any. */
  get failed(): StartupPhase | null {
    return this.failedPhase;
  }

  /** The phase currently executing, if any. */
  get active(): StartupPhase | null {
    return this.activePhase;
  }

  /** Recorded timings, in execution order. */
  get timings(): readonly PhaseTiming[] {
    return this.records;
  }

  /** True once the `ready` phase has completed successfully. */
  get isReady(): boolean {
    return this.failedPhase === null && this.phase === "ready";
  }

  /** Throw if a previous phase failed. */
  assertNotFailed(): void {
    if (this.failedPhase) {
      throw new StartupPhaseError(
        this.failedPhase,
        "failed",
        undefined,
        `Startup already failed at phase "${this.failedPhase}"; refusing to advance`,
      );
    }
  }

  private assertNext(phase: StartupPhase): void {
    this.assertNotFailed();
    const expectedIndex = this.index + 1;
    const expected = STARTUP_PHASES[expectedIndex];
    if (phase !== expected) {
      throw new StartupPhaseError(
        phase,
        expected === undefined ? "completed" : "out-of-order",
        undefined,
        expected === undefined
          ? `Startup already complete; cannot run phase "${phase}"`
          : `Expected startup phase "${expected}" but got "${phase}"`,
      );
    }
  }

  private record(
    phase: StartupPhase,
    status: PhaseStatus,
    startedAtMs: number,
    error?: unknown,
  ): void {
    const endedAtMs = Date.now();
    const timing: PhaseTiming = {
      phase,
      status,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(0, endedAtMs - startedAtMs),
      ...(error !== undefined
        ? { error: error instanceof Error ? error.message : String(error) }
        : {}),
    };
    this.records.push(timing);
    this.options.onPhase?.(timing);
    this.windowStart = endedAtMs;
  }

  /**
   * Run a phase around an async (or synchronous) operation. On success the
   * phase is recorded as `ok`; on failure it is recorded as `failed`, the
   * failure is terminal, and the original error is rethrown.
   */
  async run<T>(phase: StartupPhase, operation: () => T | Promise<T>): Promise<T> {
    this.assertNext(phase);
    this.activePhase = phase;
    const startedAtMs = Date.now();
    try {
      const result = await operation();
      this.record(phase, "ok", startedAtMs);
      this.index = STARTUP_PHASES.indexOf(phase);
      return result;
    } catch (error) {
      this.record(phase, "failed", startedAtMs, error);
      this.failedPhase = phase;
      throw error;
    } finally {
      this.activePhase = null;
    }
  }

  /**
   * Mark a synchronous phase complete. Timing covers work done since the
   * previous phase finished (or since the helper was created).
   */
  checkpoint(phase: StartupPhase): void {
    this.assertNext(phase);
    this.record(phase, "ok", this.windowStart);
    this.index = STARTUP_PHASES.indexOf(phase);
  }

  /** Summary useful for startup logs and health endpoints. */
  report(): {
    phase: StartupPhase | null;
    failed: StartupPhase | null;
    ready: boolean;
    totalDurationMs: number;
    timings: readonly PhaseTiming[];
  } {
    const first = this.records[0];
    const last = this.records[this.records.length - 1];
    return {
      phase: this.phase,
      failed: this.failed,
      ready: this.isReady,
      totalDurationMs:
        first && last
          ? new Date(last.endedAt).getTime() - new Date(first.startedAt).getTime()
          : 0,
      timings: this.timings,
    };
  }
}

/** Convenience factory. */
export function createStartupPhases(
  options?: StartupPhasesOptions,
): StartupPhases {
  return new StartupPhases(options);
}
