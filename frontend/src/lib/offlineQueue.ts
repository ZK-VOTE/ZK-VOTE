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

function getStorage(): Storage | undefined {
  return globalThis.localStorage;
}

export function getOfflineQueue(): QueuedAction[] {
  try {
    const raw = getStorage()?.getItem(OFFLINE_QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedAction[]) : memoryQueue;
  } catch {
    return memoryQueue;
  }
}

export function enqueueOfflineAction(
  action: Omit<QueuedAction, "id" | "timestamp" | "retries">,
): QueuedAction {
  const queue = getOfflineQueue();
  const entry: QueuedAction = {
    ...action,
    id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
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

export function dequeueOfflineAction(id: string): void {
  const queue = getOfflineQueue().filter((a) => a.id !== id);
  memoryQueue = queue;
  try {
    getStorage()?.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // ignore
  }
}

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

export async function processOfflineQueue(): Promise<{
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action.payload),
      });
      if (res.ok) {
        dequeueOfflineAction(action.id);
        processed++;
      } else {
        updateQueueRetries(action.id);
        failed++;
      }
    } catch {
      updateQueueRetries(action.id);
      failed++;
    }
  }
  return { processed, failed };
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
