// Offline queue for ZKVote — persists failed actions to localStorage and retries when online
import { NETWORK_CONFIG } from "../config/contracts";
import { relayerFetch } from "./api";

export interface QueuedAction {
  id: string;
  type: "vote" | "comment" | "bridgeVote" | "createProposal";
  payload: Record<string, unknown>;
  timestamp: number;
  retries: number;
  daoId: number;
}

const OFFLINE_QUEUE_KEY = `zkvote_offline_queue_${NETWORK_CONFIG.networkName}`;
export const MAX_QUEUE_RETRIES = 5;
let memoryQueue: QueuedAction[] = [];
let activeFlush: Promise<{ processed: number; failed: number }> | null = null;

function getStorage(): Storage | undefined {
  return globalThis.localStorage;
}

/**
 * Clears all pending actions from both memory and localStorage queue.
 */
export function clearOfflineQueue(): void {
  memoryQueue = [];
  try {
    getStorage()?.removeItem(OFFLINE_QUEUE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Retrieves the current list of pending offline actions.
 * @returns Array of queued actions
 */
export function getOfflineQueue(): QueuedAction[] {
  try {
    const raw = getStorage()?.getItem(OFFLINE_QUEUE_KEY);
    const items = raw ? (JSON.parse(raw) as QueuedAction[]) : memoryQueue;
    if (!Array.isArray(items)) return [];
    // Local storage can contain old duplicates from racing tabs.
    const byId = new Map<string, QueuedAction>();
    for (const item of items) {
      if (item && typeof item.id === "string" && !byId.has(item.id)) {
        byId.set(item.id, item);
      }
    }
    return [...byId.values()];
  } catch {
    return memoryQueue;
  }
}

export const MAX_PROPOSAL_TITLE_BYTES = 100;
export const MAX_DAO_NAME_CHARS = 24;

export interface ProposalTitleState {
  title: string;
  timestamp: number;
  clientId?: string;
}

/**
 * Normalizes a string into Unicode Normalization Form C (NFC).
 * @param input String to normalize
 * @returns NFC-normalized string
 */
export function normalizeNFC(input: string): string {
  return typeof input === "string" ? input.normalize("NFC") : "";
}

/**
 * Calculates the UTF-8 byte length of a string.
 * @param input Input string
 * @returns Byte count in UTF-8
 */
export function getUtf8ByteLength(input: string): number {
  return new TextEncoder().encode(input).length;
}

/**
 * Validates that a proposal title is non-empty and does not exceed 100 UTF-8 bytes.
 * @param title Proposal title string to validate
 * @returns Validation result with NFC-normalized title and byte count
 */
export function validateProposalTitle(title: string): {
  valid: boolean;
  normalized: string;
  bytes: number;
  error?: string;
} {
  const normalized = normalizeNFC(title);
  const bytes = getUtf8ByteLength(normalized);
  if (bytes === 0) {
    return { valid: false, normalized, bytes, error: "Title cannot be empty" };
  }
  if (bytes > MAX_PROPOSAL_TITLE_BYTES) {
    return {
      valid: false,
      normalized,
      bytes,
      error: `Title exceeds max limit of ${MAX_PROPOSAL_TITLE_BYTES} UTF-8 bytes (got ${bytes} bytes)`,
    };
  }
  return { valid: true, normalized, bytes };
}

/**
 * Validates that a DAO name is non-empty and does not exceed 24 characters / bytes.
 * @param name DAO name string to validate
 * @returns Validation result with NFC-normalized name, character length, and byte count
 */
export function validateDaoName(name: string): {
  valid: boolean;
  normalized: string;
  length: number;
  bytes: number;
  error?: string;
} {
  const normalized = normalizeNFC(name);
  const length = [...normalized].length;
  const bytes = getUtf8ByteLength(normalized);
  if (length === 0) {
    return {
      valid: false,
      normalized,
      length,
      bytes,
      error: "DAO name cannot be empty",
    };
  }
  if (length > MAX_DAO_NAME_CHARS || bytes > MAX_DAO_NAME_CHARS) {
    return {
      valid: false,
      normalized,
      length,
      bytes,
      error: `DAO name exceeds max limit of ${MAX_DAO_NAME_CHARS} characters/bytes (got ${length} chars, ${bytes} bytes)`,
    };
  }
  return { valid: true, normalized, length, bytes };
}

/**
 * Merges local and remote proposal title states using Last-Write-Wins (LWW) CRDT semantics,
 * enforcing Unicode NFC normalization and truncating to max 100 UTF-8 bytes.
 * @param local Local title state
 * @param remote Remote title state
 * @returns The winning proposal title state
 */
export function mergeProposalTitleCRDT(
  local: ProposalTitleState,
  remote: ProposalTitleState,
): ProposalTitleState {
  const normLocal = normalizeNFC(local.title);
  const normRemote = normalizeNFC(remote.title);

  let winning: ProposalTitleState;
  if (local.timestamp > remote.timestamp) {
    winning = { ...local, title: normLocal };
  } else if (remote.timestamp > local.timestamp) {
    winning = { ...remote, title: normRemote };
  } else {
    // Deterministic tie-breaking on equal timestamps
    winning =
      normLocal >= normRemote
        ? { ...local, title: normLocal }
        : { ...remote, title: normRemote };
  }

  // Ensure title is bounded strictly within max 100 UTF-8 bytes
  if (getUtf8ByteLength(winning.title) > MAX_PROPOSAL_TITLE_BYTES) {
    let truncated = "";
    for (const char of winning.title) {
      if (getUtf8ByteLength(truncated + char) <= MAX_PROPOSAL_TITLE_BYTES) {
        truncated += char;
      } else {
        break;
      }
    }
    winning.title = truncated;
  }

  return winning;
}

/**
 * Recursively serializes an arbitrary object to a deterministic canonical JSON string
 * with sorted keys to prevent false duplicates across nested objects.
 * @param obj Value to serialize
 * @returns Deterministic canonical JSON string
 */
export function canonicalizeJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalizeJson).join(",") + "]";
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) =>
      `${JSON.stringify(k)}:${canonicalizeJson((obj as Record<string, unknown>)[k])}`,
  );
  return "{" + pairs.join(",") + "}";
}

/**
 * Computes a deterministic idempotency ID for an action.
 * For vote actions, uses the cryptographic nullifier (`vote_<nullifier>`).
 * For non-vote actions, uses the collision-free canonical identity (`<type>_<type>:<daoId>:<canonicalPayload>`).
 * @param action Action details
 * @param action.type Action type identifier
 * @param action.daoId Target DAO identifier
 * @param action.payload Action payload object
 * @returns Unique deterministic action identifier
 */
export function computeActionHash(action: {
  type: string;
  daoId: number;
  payload: Record<string, unknown>;
}): string {
  if (action.type === "vote" && action.payload?.nullifier) {
    return `vote_${String(action.payload.nullifier)}`;
  }
  const payloadStr = canonicalizeJson(action.payload || {});
  const combined = `${action.type}:${action.daoId}:${payloadStr}`;
  // Collision-free: the canonical string is the identity.
  return `${action.type}_${combined}`;
}

/**
 * Adds an action to the offline queue with deterministic hash ID deduplication.
 * @param action Action to enqueue without ID/timestamp/retries
 * @returns The enqueued or existing queued action
 */
export function enqueueOfflineAction(
  action: Omit<QueuedAction, "id" | "timestamp" | "retries">,
): QueuedAction {
  const queue = getOfflineQueue();
  const id = computeActionHash(action);

  // Avoid duplicate queue entries for the same action/nullifier
  const existing = queue.find((a) => a.id === id);
  if (existing) {
    return existing;
  }

  const payload = { ...action.payload };
  if (typeof payload.title === "string") {
    payload.title = normalizeNFC(payload.title);
  }
  if (typeof payload.name === "string") {
    payload.name = normalizeNFC(payload.name);
  }

  const entry: QueuedAction = {
    ...action,
    payload,
    id,
    timestamp: Date.now(),
    retries: 0,
  };
  queue.push(entry);
  memoryQueue = queue;
  try {
    getStorage()?.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // ignore quota errors
  }
  return entry;
}

/**
 * Removes an action from the offline queue by its unique ID.
 * @param id Unique identifier of the queued action
 */
export function dequeueOfflineAction(id: string): void {
  const queue = getOfflineQueue().filter((a) => a.id !== id);
  memoryQueue = queue;
  try {
    getStorage()?.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // ignore
  }
}

/**
 * Increments the retry count for a queued action and drops it if max retries exceeded.
 * @param id Unique identifier of the queued action
 */
export function updateQueueRetries(id: string): void {
  const queue = getOfflineQueue();
  const idx = queue.findIndex((a) => a.id === id);
  if (idx >= 0) {
    queue[idx].retries += 1;
    if (queue[idx].retries >= MAX_QUEUE_RETRIES) {
      queue.splice(idx, 1);
    }
    memoryQueue = queue;
    try {
      getStorage()?.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
    } catch {
      // ignore
    }
  }
}

/**
 * Iterates through queued offline actions and sends them to the relayer.
 * Handles vote 409 responses as idempotent successes.
 * @returns Summary with count of processed and failed actions
 */
async function drainOfflineQueue(): Promise<{
  processed: number;
  failed: number;
}> {
  const queue = getOfflineQueue();
  let processed = 0;
  let failed = 0;
  for (const action of [...queue]) {
    try {
      const endpoint =
        action.type === "vote"
          ? "/vote"
          : action.type === "bridgeVote"
            ? "/bridge/vote"
            : action.type === "comment"
              ? "/comment/anonymous"
              : "/daos";
      const res = await relayerFetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Offline-Retry": "true",
          "Idempotency-Key": action.id,
        },
        body: JSON.stringify(action.payload),
      });

      // HTTP 2xx success, or 409 Conflict specifically for votes (idempotently already accepted)
      const isVoteDuplicate = action.type === "vote" && res.status === 409;
      if (res.ok || isVoteDuplicate) {
        dequeueOfflineAction(action.id);
        processed++;
      } else {
        updateQueueRetries(action.id);
        failed++;
      }
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (action.type === "vote" && status === 409) {
        dequeueOfflineAction(action.id);
        processed++;
      } else {
        updateQueueRetries(action.id);
        failed++;
      }
    }
  }
  return { processed, failed };
}

/**
 * Only one drain per browser context. Duplicate online events and timers
 * join the same promise rather than POSTing the same nullifier twice.
 */
export function processOfflineQueue(): Promise<{ processed: number; failed: number }> {
  if (activeFlush) return activeFlush;
  activeFlush = drainOfflineQueue().finally(() => { activeFlush = null; });
  return activeFlush;
}

if (typeof window !== "undefined" && import.meta.env.MODE !== "test") {
  window.addEventListener("online", () => {
    processOfflineQueue().catch(() => {});
  });
  setInterval(() => {
    if (
      typeof navigator !== "undefined" &&
      navigator.onLine &&
      getOfflineQueue().length > 0
    ) {
      processOfflineQueue().catch(() => {});
    }
  }, 30_000);
}

/**
 * ZV-132: offline title edits with exactly equal logical clocks are genuine
 * concurrent edits, not a lexicographic tie-break the user never approved.
 */
export type OfflineTitleResolution =
  | { kind: "merged"; value: ProposalTitleState }
  | { kind: "conflict"; local: ProposalTitleState; remote: ProposalTitleState };

export function resolveOfflineTitleEdit(
  local: ProposalTitleState,
  remote: ProposalTitleState,
): OfflineTitleResolution {
  if (local.timestamp === remote.timestamp &&
      normalizeNFC(local.title) !== normalizeNFC(remote.title)) {
    return { kind: "conflict", local, remote };
  }
  return { kind: "merged", value: mergeProposalTitleCRDT(local, remote) };
}
