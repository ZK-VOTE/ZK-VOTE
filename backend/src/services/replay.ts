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

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { digestValue, getActiveSpanContext } from "./tracing.js";

// ============================================
// TYPES
// ============================================

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

export const REPLAY_FIXTURE_VERSION = 1 as const;

// ============================================
// CANONICAL SERIALISATION
// ============================================

/**
 * JSON with deterministic key ordering.
 *
 * `JSON.stringify` preserves insertion order, which differs between a recorded
 * object and one rebuilt during replay. Sorting keys at every level removes
 * that as a source of spurious digest mismatches.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

/** SHA-256 over the canonical encoding of `value`. */
export function digestState(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

// ============================================
// REDACTION
// ============================================

const SENSITIVE_PAYLOAD_KEYS = new Set([
  "nullifier",
  "proof",
  "root",
  "commitment",
  "alias",
  "ciphertext",
  "plaintext",
  "creator",
  "admin",
  "address",
  "ip",
]);

/**
 * Replace anonymity-relevant payload fields with salted digests, recursively.
 *
 * Structure is preserved so a replay still reduces to the same shape — the
 * reducer never reads a redacted field — while the fixture carries no value
 * that links a ballot to a voter.
 */
export function redactInteractionPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (SENSITIVE_PAYLOAD_KEYS.has(key.toLowerCase())) {
      out[key] =
        typeof value === "string" ? `sha256:${digestValue(value)}` : "[redacted]";
      continue;
    }

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redactInteractionPayload(value as Record<string, unknown>);
      continue;
    }

    if (Array.isArray(value)) {
      out[key] = value.map((entry) =>
        entry !== null && typeof entry === "object"
          ? redactInteractionPayload(entry as Record<string, unknown>)
          : entry,
      );
      continue;
    }

    out[key] = value;
  }

  return out;
}

// ============================================
// REDUCER (shared by record and replay)
// ============================================

export function emptyReplayState(): ReplayState {
  return { latestLedger: 0, watermarkLedger: 0, events: [] };
}

function eventKey(event: ReplayEventRecord): string {
  return `${event.daoId}|${event.ledger}|${event.txHash ?? ""}|${event.type}`;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Fold one interaction into the pipeline state.
 *
 * This is deliberately total and side-effect free: unknown labels are ignored
 * rather than throwing, so a fixture recorded by a newer build still replays
 * against an older reducer (the digest will differ, which is the signal).
 */
export function applyInteraction(
  state: ReplayState,
  interaction: RelayInteraction,
): ReplayState {
  const { label, payload } = interaction;

  switch (label) {
    case "rpc.getLatestLedger":
      return { ...state, latestLedger: asNumber(payload.sequence) };

    case "db.addEvent": {
      const event: ReplayEventRecord = {
        daoId: asNumber(payload.daoId),
        type: String(payload.type ?? "unknown"),
        ledger: asNumber(payload.ledger),
        txHash: typeof payload.txHash === "string" ? payload.txHash : null,
        timestamp: String(payload.timestamp ?? ""),
      };
      // The indexer's UNIQUE(ledger, tx_hash, type) constraint makes duplicate
      // inserts no-ops on chain replays; the reducer mirrors that.
      const key = eventKey(event);
      if (state.events.some((existing) => eventKey(existing) === key)) {
        return state;
      }
      return { ...state, events: [...state.events, event] };
    }

    case "db.setWatermark":
      return { ...state, watermarkLedger: asNumber(payload.ledger) };

    default:
      return state;
  }
}

/** Sort events into a canonical order so digests ignore insertion order. */
function normaliseState(state: ReplayState): ReplayState {
  return {
    ...state,
    events: [...state.events].sort((a, b) =>
      eventKey(a) < eventKey(b) ? -1 : eventKey(a) > eventKey(b) ? 1 : 0,
    ),
  };
}

// ============================================
// RECORDER
// ============================================

export class RelayReplayRecorder {
  private readonly interactions: RelayInteraction[] = [];
  private state: ReplayState = emptyReplayState();
  private seq = 0;

  constructor(
    readonly traceId: string,
    readonly pipeline: string,
  ) {}

  /** Record an interaction and fold it into the running state. */
  record(
    kind: InteractionKind,
    label: string,
    payload: Record<string, unknown>,
    spanId = "",
  ): void {
    const interaction: RelayInteraction = {
      seq: this.seq++,
      kind,
      label,
      traceId: this.traceId,
      spanId,
      payload: redactInteractionPayload(payload),
    };
    this.interactions.push(interaction);
    this.state = applyInteraction(this.state, interaction);
  }

  /** Freeze the recording into a fixture. */
  toFixture(): RelayReplayFixture {
    const finalState = normaliseState(this.state);
    return {
      version: REPLAY_FIXTURE_VERSION,
      traceId: this.traceId,
      pipeline: this.pipeline,
      interactions: this.interactions,
      finalState,
      digest: digestState(finalState),
    };
  }
}

// ============================================
// AMBIENT CAPTURE
// ============================================

let activeRecorder: RelayReplayRecorder | null = null;

/**
 * Begin capturing the current pipeline run.
 *
 * Only one recording is active at a time; the indexer runs a single poll cycle
 * at a time by construction (see `WatermarkScheduler`), so this does not need
 * to be re-entrant.
 */
export function startRecording(
  pipeline: string,
  traceId?: string,
): RelayReplayRecorder {
  const resolvedTraceId =
    traceId ?? getActiveSpanContext()?.traceId ?? "0".repeat(32);
  activeRecorder = new RelayReplayRecorder(resolvedTraceId, pipeline);
  return activeRecorder;
}

/** Finish the active recording and return its fixture, if any. */
export function stopRecording(): RelayReplayFixture | null {
  const recorder = activeRecorder;
  activeRecorder = null;
  return recorder ? recorder.toFixture() : null;
}

export function getActiveRecorder(): RelayReplayRecorder | null {
  return activeRecorder;
}

/**
 * Record an interaction against the active recorder.
 *
 * A no-op when nothing is recording, which is the production default — call
 * sites can invoke this unconditionally without a feature check.
 */
export function recordInteraction(
  kind: InteractionKind,
  label: string,
  payload: Record<string, unknown>,
): void {
  const recorder = activeRecorder;
  if (!recorder) return;
  recorder.record(kind, label, payload, getActiveSpanContext()?.spanId ?? "");
}

/** True when `RELAY_REPLAY_CAPTURE` opts this process into recording. */
export function isReplayCaptureEnabled(): boolean {
  return process.env.RELAY_REPLAY_CAPTURE === "true";
}

// ============================================
// REPLAY
// ============================================

/**
 * Re-derive pipeline state from a fixture's interactions.
 *
 * Nothing outside the fixture is consulted — no clock, no network, no
 * database — so the result is a pure function of the fixture.
 */
export function replayFixture(fixture: RelayReplayFixture): ReplayResult {
  let state = emptyReplayState();
  for (const interaction of [...fixture.interactions].sort(
    (a, b) => a.seq - b.seq,
  )) {
    state = applyInteraction(state, interaction);
  }

  const normalised = normaliseState(state);
  const digest = digestState(normalised);

  return { state: normalised, digest, matches: digest === fixture.digest };
}

// ============================================
// FIXTURE I/O
// ============================================

export function writeFixture(
  filePath: string,
  fixture: RelayReplayFixture,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${canonicalJson(fixture)}\n`, "utf8");
}

export function loadFixture(filePath: string): RelayReplayFixture {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as RelayReplayFixture;

  if (parsed.version !== REPLAY_FIXTURE_VERSION) {
    throw new Error(
      `Unsupported replay fixture version ${String(parsed.version)} (expected ${REPLAY_FIXTURE_VERSION})`,
    );
  }

  return parsed;
}
