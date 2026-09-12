/**
 * Governance Analytics Aggregations (#322)
 *
 * Turnout and participation for the `/api/v1/analytics` API.
 *
 * Every figure here is computed by SQLite, never by reducing rows in Node.
 * That is a correctness requirement as much as a performance one: a DAO's
 * event partition grows without bound, so any aggregation that first
 * materialises rows in the relay's heap is a memory bug waiting for the first
 * busy DAO. The queries below therefore return one row per bucket or proposal,
 * already summed — the service layer only maps column names.
 *
 * Events live in per-DAO partitions (`events_{daoId}`, see `services/db.ts`),
 * so cross-DAO queries are assembled as a `UNION ALL` over the partition
 * registry and then aggregated once in SQL.
 */
export type ParticipationInterval = "hour" | "day" | "week" | "month";
export interface DaoOverview {
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
    /** Mean votes per proposal, or `null` when no proposal exists yet. */
    averageVotesPerProposal: number | null;
    /** Share of proposals that received at least one vote. */
    proposalParticipationRate: number | null;
}
export interface ProposalTurnout {
    daoId: number;
    proposalId: number;
    createdAt: string | null;
    closedAt: string | null;
    votesCast: number;
    eligibleVoters: number;
    /** `votesCast / eligibleVoters`, or `null` when the DAO has no members. */
    turnoutRatio: number | null;
    firstVoteAt: string | null;
    lastVoteAt: string | null;
}
export interface ParticipationBucket {
    bucket: string;
    votesCast: number;
    proposalsCreated: number;
    activeProposals: number;
    membersJoined: number;
}
export interface PlatformOverview {
    daoCount: number;
    proposalsCreated: number;
    votesCast: number;
    totalEvents: number;
    firstEventAt: string | null;
    lastEventAt: string | null;
}
export interface Paginated<T> {
    items: T[];
    total: number;
    limit: number;
    offset: number;
}
/**
 * Validate a DAO ID before it is interpolated into a table name.
 *
 * Partition tables cannot be parameterised, so this is the only thing standing
 * between a caller and SQL injection. It mirrors `validateDaoId` in
 * `services/db.ts` deliberately — analytics must not be a weaker door.
 */
export declare function assertValidDaoId(daoId: number): number;
/** Registered DAO partitions that actually have a table backing them. */
export declare function listAnalyticsPartitions(): number[];
/**
 * Whether a DAO has an event partition yet.
 *
 * A DAO with no indexed events has no table at all, which is not an error —
 * analytics reports zeros for it rather than failing the request.
 */
export declare function partitionExists(daoId: number): boolean;
/**
 * Create the composite indexes the analytics queries rely on.
 *
 * Partition tables are created at runtime, so these cannot live in a static
 * migration. Idempotent, and cheap enough to call on every analytics request.
 */
export declare function ensureAnalyticsIndexes(daoId: number): void;
/**
 * Headline counters for one DAO.
 *
 * A single pass over the partition with conditional aggregation — one scan,
 * one row back, regardless of how many events the DAO has accumulated.
 */
export declare function getDaoOverview(daoId: number): Promise<DaoOverview>;
export interface TurnoutQuery {
    limit?: number;
    offset?: number;
    /** Restrict to a single proposal. */
    proposalId?: number;
}
/**
 * Per-proposal turnout for one DAO.
 *
 * Three grouped CTEs — proposals, closures, votes — joined once. The turnout
 * ratio is divided in SQL against a bound `eligibleVoters` parameter so the
 * whole page arrives ready to serialise.
 */
export declare function getProposalTurnout(daoId: number, query?: TurnoutQuery): Promise<Paginated<ProposalTurnout>>;
export interface ParticipationQuery {
    interval?: ParticipationInterval;
    /** Inclusive lower bound, ISO-8601. */
    from?: string;
    /** Exclusive upper bound, ISO-8601. */
    to?: string;
    limit?: number;
}
/**
 * Participation bucketed over time for one DAO.
 *
 * `strftime` does the bucketing inside SQLite, so a year of hourly buckets is
 * one grouped scan rather than a year of rows crossing the process boundary.
 */
export declare function getParticipationTimeseries(daoId: number, query?: ParticipationQuery): Promise<ParticipationBucket[]>;
/**
 * Platform-wide totals across every DAO partition.
 *
 * The partitions are stitched with `UNION ALL` and aggregated once by SQLite;
 * the relay never holds more than the single summary row.
 */
export declare function getPlatformOverview(): Promise<PlatformOverview>;
/** Render turnout rows as CSV, header included. */
export declare function turnoutToCsv(rows: ProposalTurnout[]): string;
/**
 * Log a completed analytics query.
 *
 * Only shape and timing are recorded: analytics reads touch vote events, and
 * an operator log is not a place to accumulate per-proposal query patterns.
 */
export declare function logAnalyticsQuery(metric: string, daoId: number | null, durationMs: number, rowCount: number): void;
//# sourceMappingURL=analytics.d.ts.map