/**
 * Where notifications come from (ZV-037 / #886): indexed contract events and
 * dispute resolutions, mapped onto {@link NotificationEvent}s.
 *
 * Only named, non-identifying fields are copied: a proposal's id and end
 * time, a DAO id, a dispute's resolution text. Creator addresses, nullifiers
 * and vote choices never reach a notification.
 */
import type { NotificationEvent } from "./types.js";

interface IndexedEventLike {
  daoId: number | string;
  type: string;
  data: Record<string, unknown> | null;
  txHash?: string | null;
  ledger?: number | null;
}

const asId = (value: unknown): string | null =>
  typeof value === "number" || typeof value === "bigint" || (typeof value === "string" && /^\d+$/.test(value))
    ? String(value)
    : null;

/** Seconds since the epoch (ledger timestamps) to ISO, or null. */
const ledgerTime = (value: unknown): string | null => {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
};

/** `proposal_created` → election_started, `proposal_closed` → election_ended; anything else → null. */
export function notificationFromIndexedEvent(event: IndexedEventLike): NotificationEvent | null {
  const type =
    event.type === "proposal_created"
      ? "election_started"
      : event.type === "proposal_closed"
        ? "election_ended"
        : null;
  if (!type) return null;
  const data = event.data ?? {};
  const proposalId = asId(data.proposalId ?? data.proposal_id);
  const daoId = String(event.daoId);
  return {
    // Stable across re-indexing, so the outbox's business key dedupes it.
    id: `${event.type}:${daoId}:${proposalId ?? event.txHash ?? event.ledger ?? "unknown"}`,
    type,
    daoId,
    data: {
      proposalId,
      proposalTitle: proposalId ? `Proposal #${proposalId}` : null,
      at: type === "election_started" ? ledgerTime(data.end_time ?? data.endTime) : null,
    },
  };
}

/** A resolved dispute case. */
export function notificationFromDisputeResolution(input: {
  caseId: string;
  daoId?: string | null;
  resolution: string;
}): NotificationEvent {
  return {
    id: `dispute_outcome:${input.caseId}`,
    type: "dispute_outcome",
    daoId: input.daoId ?? null,
    data: { outcome: input.resolution },
  };
}
