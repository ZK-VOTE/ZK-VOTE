/**
 * Deterministic Replay of the Relay Pipeline (#321)
 *
 * A poll cycle is normally impossible to reproduce: it depends on live RPC
 * responses and on wall-clock timestamps. This module records the *inputs and
 * decisions* of a cycle into a fixture, then re-derives the resulting state
 * from that fixture alone.
 *
 * The guarantee is a shared reducer. {@link applyInteraction} is the only code
 * that turns an interaction into state, and it runs both while recording and
 * while replaying. If a replay's digest matches the fixture's, the recorded
 * interactions fully explain the state the indexer reached — which is what
 * makes an incident in the anonymity-critical path auditable after the fact.
 *
 * Recording is off unless explicitly enabled, so production pays nothing.
 * Every payload is normalised through {@link redactInteractionPayload} before
 * it reaches the fixture: a fixture is a debugging artifact that may be shared,
 * and must not become a voter deanonymisation oracle.
 */
export type InteractionKind = "rpc" | "db" | "cycle";
export interface RelayInteraction {
    /** Monotonic index within the fixture; replay order is this order. */
    seq: number;
    kind: InteractionKind;
    /** Stable operation name, e.g. `rpc.getLatestLedger`, `db.addEvent`. */
    label: string;
    traceId: string;
    spanId: string;
    payload: Record<string, unknown>;
}
/** A single indexed event as it appears in replayed state. */
export interface ReplayEventRecord {
    daoId: number;
    type: string;
    ledger: number;
    txHash: string | null;
    timestamp: string;
}
/** The subset of indexer state a replay reconstructs. */
export interface ReplayState {
    latestLedger: number;
    watermarkLedger: number;
    events: ReplayEventRecord[];
}
export interface RelayReplayFixture {
    version: 1;
    traceId: string;
    /** Cycle description, e.g. `indexer.poll_cycle`. */
    pipeline: string;
    interactions: RelayInteraction[];
    finalState: ReplayState;
    /** Digest of `finalState`; a replay must reproduce it exactly. */
    digest: string;
}
export interface ReplayResult {
    state: ReplayState;
    digest: string;
    /** True when the replayed digest equals the digest stored in the fixture. */
    matches: boolean;
}
export declare const REPLAY_FIXTURE_VERSION: 1;
/**
 * JSON with deterministic key ordering.
 *
 * `JSON.stringify` preserves insertion order, which differs between a recorded
 * object and one rebuilt during replay. Sorting keys at every level removes
 * that as a source of spurious digest mismatches.
 */
export declare function canonicalJson(value: unknown): string;
/** SHA-256 over the canonical encoding of `value`. */
export declare function digestState(value: unknown): string;
/**
 * Replace anonymity-relevant payload fields with salted digests, recursively.
 *
 * Structure is preserved so a replay still reduces to the same shape — the
 * reducer never reads a redacted field — while the fixture carries no value
 * that links a ballot to a voter.
 */
export declare function redactInteractionPayload(payload: Record<string, unknown>): Record<string, unknown>;
export declare function emptyReplayState(): ReplayState;
/**
 * Fold one interaction into the pipeline state.
 *
 * This is deliberately total and side-effect free: unknown labels are ignored
 * rather than throwing, so a fixture recorded by a newer build still replays
 * against an older reducer (the digest will differ, which is the signal).
 */
export declare function applyInteraction(state: ReplayState, interaction: RelayInteraction): ReplayState;
export declare class RelayReplayRecorder {
    readonly traceId: string;
    readonly pipeline: string;
    private readonly interactions;
    private state;
    private seq;
    constructor(traceId: string, pipeline: string);
    /** Record an interaction and fold it into the running state. */
    record(kind: InteractionKind, label: string, payload: Record<string, unknown>, spanId?: string): void;
    /** Freeze the recording into a fixture. */
    toFixture(): RelayReplayFixture;
}
/**
 * Begin capturing the current pipeline run.
 *
 * Only one recording is active at a time; the indexer runs a single poll cycle
 * at a time by construction (see `WatermarkScheduler`), so this does not need
 * to be re-entrant.
 */
export declare function startRecording(pipeline: string, traceId?: string): RelayReplayRecorder;
/** Finish the active recording and return its fixture, if any. */
export declare function stopRecording(): RelayReplayFixture | null;
export declare function getActiveRecorder(): RelayReplayRecorder | null;
/**
 * Record an interaction against the active recorder.
 *
 * A no-op when nothing is recording, which is the production default — call
 * sites can invoke this unconditionally without a feature check.
 */
export declare function recordInteraction(kind: InteractionKind, label: string, payload: Record<string, unknown>): void;
/** True when `RELAY_REPLAY_CAPTURE` opts this process into recording. */
export declare function isReplayCaptureEnabled(): boolean;
/**
 * Re-derive pipeline state from a fixture's interactions.
 *
 * Nothing outside the fixture is consulted — no clock, no network, no
 * database — so the result is a pure function of the fixture.
 */
export declare function replayFixture(fixture: RelayReplayFixture): ReplayResult;
export declare function writeFixture(filePath: string, fixture: RelayReplayFixture): void;
export declare function loadFixture(filePath: string): RelayReplayFixture;
//# sourceMappingURL=replay.d.ts.map