/**
 * Governance Analytics Client (#322)
 *
 * Typed wrappers over `/api/v1/analytics`. The relay already aggregates in
 * SQL, so these deliberately return the server's shape untouched — any
 * re-derivation here would be the in-memory reduce the API exists to avoid.
 */

import { relayerFetch } from "./api";

export type ParticipationInterval = "hour" | "day" | "week" | "month";

export interface DaoAnalyticsOverview {
  daoId: number;
  memberCount: number;
  proposalsCreated: number;
  proposalsClosed: number;
  proposalsWithVotes: number;
  votesCast: number;
  membersJoined: number;
  membersLeft: number;
  totalEvents: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  averageVotesPerProposal: number | null;
  proposalParticipationRate: number | null;
}

export interface ProposalTurnout {
  daoId: number;
  proposalId: number;
  createdAt: string | null;
  closedAt: string | null;
  votesCast: number;
  eligibleVoters: number;
  turnoutRatio: number | null;
  firstVoteAt: string | null;
  lastVoteAt: string | null;
}

export interface TurnoutPage {
  items: ProposalTurnout[];
  total: number;
  limit: number;
  offset: number;
}

export interface ParticipationBucket {
  bucket: string;
  votesCast: number;
  proposalsCreated: number;
  activeProposals: number;
  membersJoined: number;
}

export interface ParticipationSeries {
  daoId: number;
  interval: ParticipationInterval;
  buckets: ParticipationBucket[];
}

const ANALYTICS_BASE = "/api/v1/analytics";

async function getJson<T>(path: string): Promise<T> {
  const response = await relayerFetch(path);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Analytics request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

/** Build a query string, omitting undefined values. */
function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

/** Headline governance counters for one DAO. */
export async function fetchDaoAnalytics(
  daoId: number,
): Promise<DaoAnalyticsOverview> {
  return getJson(`${ANALYTICS_BASE}/daos/${daoId}/overview`);
}

/** Per-proposal turnout, newest proposal first. */
export async function fetchProposalTurnout(
  daoId: number,
  options: { limit?: number; offset?: number; proposalId?: number } = {},
): Promise<TurnoutPage> {
  return getJson(
    `${ANALYTICS_BASE}/daos/${daoId}/turnout${query({
      limit: options.limit,
      offset: options.offset,
      proposalId: options.proposalId,
    })}`,
  );
}

/** Participation bucketed over time. */
export async function fetchParticipation(
  daoId: number,
  options: {
    interval?: ParticipationInterval;
    from?: string;
    to?: string;
    limit?: number;
  } = {},
): Promise<ParticipationSeries> {
  return getJson(
    `${ANALYTICS_BASE}/daos/${daoId}/participation${query({
      interval: options.interval,
      from: options.from,
      to: options.to,
      limit: options.limit,
    })}`,
  );
}

/**
 * Format a turnout ratio for display.
 *
 * `null` means the DAO has no recorded members, which is different from 0%
 * turnout and must not be rendered as if it were.
 */
export function formatTurnout(ratio: number | null): string {
  if (ratio === null) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}
