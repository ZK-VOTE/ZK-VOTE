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

import { sql } from "kysely";

import { kysely } from "./kysely.js";
import { getDb } from "./db.js";
import { log } from "./logger.js";

// ============================================
// TYPES
// ============================================

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

// ============================================
// PARTITION HELPERS
// ============================================

/** Event types that count as a member joining the electorate. */
const JOIN_EVENT_TYPES = ["member_added", "voter_registered", "voter_reinstated"];
/** Event types that count as a member leaving it. */
const LEAVE_EVENT_TYPES = ["member_revoked", "member_left", "voter_removed"];

/**
 * SQL fragment extracting a proposal ID from an event's JSON payload.
 *
 * The indexer writes `proposalId`; events indexed before that lift existed, and
 * anything synthesised by hand, may carry `proposal_id`. Coalescing both keeps
 * historical partitions queryable without a backfill.
 */
const PROPOSAL_ID_SQL = sql`CAST(COALESCE(json_extract(data, '$.proposalId'), json_extract(data, '$.proposal_id')) AS INTEGER)`;

/**
 * Validate a DAO ID before it is interpolated into a table name.
 *
 * Partition tables cannot be parameterised, so this is the only thing standing
 * between a caller and SQL injection. It mirrors `validateDaoId` in
 * `services/db.ts` deliberately — analytics must not be a weaker door.
 */
export function assertValidDaoId(daoId: number): number {
  if (!Number.isSafeInteger(daoId) || daoId < 0) {
    throw new Error(`Invalid DAO ID: ${String(daoId)}`);
  }
  return daoId;
}

function partitionTable(daoId: number): string {
  return `events_${assertValidDaoId(daoId)}`;
}

/** Registered DAO partitions that actually have a table backing them. */
export function listAnalyticsPartitions(): number[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT r.dao_id AS dao_id
         FROM partition_registry r
         JOIN sqlite_master m
           ON m.type = 'table' AND m.name = 'events_' || r.dao_id
        ORDER BY r.dao_id ASC`,
    )
    .all() as Array<{ dao_id: number }>;
  return rows.map((row) => row.dao_id);
}

/**
 * Whether a DAO has an event partition yet.
 *
 * A DAO with no indexed events has no table at all, which is not an error —
 * analytics reports zeros for it rather than failing the request.
 */
export function partitionExists(daoId: number): boolean {
  const row = getDb()
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(partitionTable(daoId)) as { ok: number } | undefined;
  return row !== undefined;
}

/**
 * Create the composite indexes the analytics queries rely on.
 *
 * Partition tables are created at runtime, so these cannot live in a static
 * migration. Idempotent, and cheap enough to call on every analytics request.
 */
export function ensureAnalyticsIndexes(daoId: number): void {
  if (!partitionExists(daoId)) return;
  const table = partitionTable(daoId);
  getDb().exec(`
    CREATE INDEX IF NOT EXISTS idx_${table}_type_timestamp
      ON ${table}(type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_${table}_verified_type
      ON ${table}(verified, type);
  `);
}

/** Zeroed overview for a DAO that has never been indexed. */
function emptyOverview(daoId: number, memberCount: number): DaoOverview {
  return {
    daoId,
    memberCount,
    proposalsCreated: 0,
    proposalsClosed: 0,
    proposalsWithVotes: 0,
    votesCast: 0,
    membersJoined: 0,
    membersLeft: 0,
    totalEvents: 0,
    firstEventAt: null,
    lastEventAt: null,
    averageVotesPerProposal: null,
    proposalParticipationRate: null,
  };
}

/** SQLite `strftime` format for each supported bucket width. */
const INTERVAL_FORMATS: Record<ParticipationInterval, string> = {
  hour: "%Y-%m-%dT%H:00",
  day: "%Y-%m-%d",
  week: "%Y-W%W",
  month: "%Y-%m",
};

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ============================================
// DAO OVERVIEW
// ============================================

interface OverviewRow {
  proposals_created: number | null;
  proposals_closed: number | null;
  votes_cast: number | null;
  members_joined: number | null;
  members_left: number | null;
  proposals_with_votes: number | null;
  total_events: number | null;
  first_event_at: string | null;
  last_event_at: string | null;
}

/**
 * Headline counters for one DAO.
 *
 * A single pass over the partition with conditional aggregation — one scan,
 * one row back, regardless of how many events the DAO has accumulated.
 */
export async function getDaoOverview(daoId: number): Promise<DaoOverview> {
  const table = partitionTable(daoId);
  if (!partitionExists(daoId)) {
    return emptyOverview(daoId, await getMemberCount(daoId));
  }
  ensureAnalyticsIndexes(daoId);

  const result = await sql<OverviewRow>`
    SELECT
      SUM(CASE WHEN type = 'proposal_created' THEN 1 ELSE 0 END) AS proposals_created,
      SUM(CASE WHEN type IN ('proposal_closed', 'proposal_archived') THEN 1 ELSE 0 END) AS proposals_closed,
      SUM(CASE WHEN type = 'vote_cast' THEN 1 ELSE 0 END) AS votes_cast,
      SUM(CASE WHEN type IN (${sql.join(JOIN_EVENT_TYPES)}) THEN 1 ELSE 0 END) AS members_joined,
      SUM(CASE WHEN type IN (${sql.join(LEAVE_EVENT_TYPES)}) THEN 1 ELSE 0 END) AS members_left,
      COUNT(DISTINCT CASE WHEN type = 'vote_cast' THEN ${PROPOSAL_ID_SQL} END) AS proposals_with_votes,
      COUNT(*) AS total_events,
      MIN(timestamp) AS first_event_at,
      MAX(timestamp) AS last_event_at
    FROM ${sql.table(table)}
    WHERE verified = 1
  `.execute(kysely);

  const row = result.rows[0];
  const proposalsCreated = toNumber(row?.proposals_created);
  const votesCast = toNumber(row?.votes_cast);
  const proposalsWithVotes = toNumber(row?.proposals_with_votes);

  const memberCount = await getMemberCount(daoId);

  return {
    daoId,
    memberCount,
    proposalsCreated,
    proposalsClosed: toNumber(row?.proposals_closed),
    proposalsWithVotes,
    votesCast,
    membersJoined: toNumber(row?.members_joined),
    membersLeft: toNumber(row?.members_left),
    totalEvents: toNumber(row?.total_events),
    firstEventAt: toNullableString(row?.first_event_at),
    lastEventAt: toNullableString(row?.last_event_at),
    averageVotesPerProposal:
      proposalsCreated > 0 ? votesCast / proposalsCreated : null,
    proposalParticipationRate:
      proposalsCreated > 0 ? proposalsWithVotes / proposalsCreated : null,
  };
}

/** Cached member count for the DAO, used as the turnout denominator. */
async function getMemberCount(daoId: number): Promise<number> {
  const row = await kysely
    .selectFrom("daos")
    .select("member_count")
    .where("id", "=", daoId)
    .executeTakeFirst();
  return toNumber(row?.member_count);
}

// ============================================
// PROPOSAL TURNOUT
// ============================================

interface TurnoutRow {
  proposal_id: number;
  created_at: string | null;
  closed_at: string | null;
  votes_cast: number | null;
  turnout_ratio: number | null;
  first_vote_at: string | null;
  last_vote_at: string | null;
}

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
export async function getProposalTurnout(
  daoId: number,
  query: TurnoutQuery = {},
): Promise<Paginated<ProposalTurnout>> {
  const table = partitionTable(daoId);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);

  if (!partitionExists(daoId)) {
    return { items: [], total: 0, limit, offset };
  }
  ensureAnalyticsIndexes(daoId);

  const eligibleVoters = await getMemberCount(daoId);
  // `sql.raw("")` rather than an empty tagged template: an explicit no-op
  // fragment is unambiguous when it is spliced into the WHERE clause below.
  const proposalFilter =
    query.proposalId === undefined
      ? sql.raw("")
      : sql`AND p.proposal_id = ${query.proposalId}`;

  const result = await sql<TurnoutRow>`
    WITH proposals AS (
      SELECT ${PROPOSAL_ID_SQL} AS proposal_id, MIN(timestamp) AS created_at
        FROM ${sql.table(table)}
       WHERE type = 'proposal_created' AND verified = 1
       GROUP BY 1
    ),
    closures AS (
      SELECT ${PROPOSAL_ID_SQL} AS proposal_id, MIN(timestamp) AS closed_at
        FROM ${sql.table(table)}
       WHERE type IN ('proposal_closed', 'proposal_archived') AND verified = 1
       GROUP BY 1
    ),
    votes AS (
      SELECT ${PROPOSAL_ID_SQL} AS proposal_id,
             COUNT(*) AS votes_cast,
             MIN(timestamp) AS first_vote_at,
             MAX(timestamp) AS last_vote_at
        FROM ${sql.table(table)}
       WHERE type = 'vote_cast' AND verified = 1
       GROUP BY 1
    )
    SELECT p.proposal_id AS proposal_id,
           p.created_at AS created_at,
           c.closed_at AS closed_at,
           COALESCE(v.votes_cast, 0) AS votes_cast,
           CASE WHEN ${eligibleVoters} > 0
                THEN CAST(COALESCE(v.votes_cast, 0) AS REAL) / ${eligibleVoters}
                ELSE NULL END AS turnout_ratio,
           v.first_vote_at AS first_vote_at,
           v.last_vote_at AS last_vote_at
      FROM proposals p
      LEFT JOIN votes v ON v.proposal_id = p.proposal_id
      LEFT JOIN closures c ON c.proposal_id = p.proposal_id
     WHERE p.proposal_id IS NOT NULL ${proposalFilter}
     ORDER BY p.proposal_id DESC
     LIMIT ${limit} OFFSET ${offset}
  `.execute(kysely);

  // `total` counts the rows the same filter matches, not every proposal in the
  // DAO — otherwise a single-proposal query would report a page of 1 out of N.
  const totalFilter =
    query.proposalId === undefined
      ? sql.raw("")
      : sql`AND ${PROPOSAL_ID_SQL} = ${query.proposalId}`;

  const totalResult = await sql<{ total: number }>`
    SELECT COUNT(DISTINCT ${PROPOSAL_ID_SQL}) AS total
      FROM ${sql.table(table)}
     WHERE type = 'proposal_created'
       AND verified = 1
       AND ${PROPOSAL_ID_SQL} IS NOT NULL ${totalFilter}
  `.execute(kysely);

  return {
    items: result.rows.map((row) => ({
      daoId,
      proposalId: toNumber(row.proposal_id),
      createdAt: toNullableString(row.created_at),
      closedAt: toNullableString(row.closed_at),
      votesCast: toNumber(row.votes_cast),
      eligibleVoters,
      turnoutRatio:
        row.turnout_ratio === null ? null : Number(row.turnout_ratio),
      firstVoteAt: toNullableString(row.first_vote_at),
      lastVoteAt: toNullableString(row.last_vote_at),
    })),
    total: toNumber(totalResult.rows[0]?.total),
    limit,
    offset,
  };
}

// ============================================
// PARTICIPATION TIME SERIES
// ============================================

interface ParticipationRow {
  bucket: string;
  votes_cast: number | null;
  proposals_created: number | null;
  active_proposals: number | null;
  members_joined: number | null;
}

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
export async function getParticipationTimeseries(
  daoId: number,
  query: ParticipationQuery = {},
): Promise<ParticipationBucket[]> {
  const table = partitionTable(daoId);
  if (!partitionExists(daoId)) return [];
  ensureAnalyticsIndexes(daoId);

  const interval: ParticipationInterval = query.interval ?? "day";
  const format = INTERVAL_FORMATS[interval];
  if (!format) throw new Error(`Unsupported interval: ${interval}`);

  const limit = Math.min(Math.max(query.limit ?? 365, 1), 1000);
  const from = query.from ?? "0000-01-01T00:00:00.000Z";
  const to = query.to ?? "9999-12-31T23:59:59.999Z";

  const result = await sql<ParticipationRow>`
    SELECT strftime(${format}, timestamp) AS bucket,
           SUM(CASE WHEN type = 'vote_cast' THEN 1 ELSE 0 END) AS votes_cast,
           SUM(CASE WHEN type = 'proposal_created' THEN 1 ELSE 0 END) AS proposals_created,
           COUNT(DISTINCT CASE WHEN type = 'vote_cast' THEN ${PROPOSAL_ID_SQL} END) AS active_proposals,
           SUM(CASE WHEN type IN (${sql.join(JOIN_EVENT_TYPES)}) THEN 1 ELSE 0 END) AS members_joined
      FROM ${sql.table(table)}
     WHERE verified = 1
       AND timestamp >= ${from}
       AND timestamp < ${to}
     GROUP BY bucket
     HAVING bucket IS NOT NULL
     ORDER BY bucket ASC
     LIMIT ${limit}
  `.execute(kysely);

  return result.rows.map((row) => ({
    bucket: row.bucket,
    votesCast: toNumber(row.votes_cast),
    proposalsCreated: toNumber(row.proposals_created),
    activeProposals: toNumber(row.active_proposals),
    membersJoined: toNumber(row.members_joined),
  }));
}

// ============================================
// CROSS-DAO OVERVIEW
// ============================================

interface PlatformRow {
  proposals_created: number | null;
  votes_cast: number | null;
  total_events: number | null;
  first_event_at: string | null;
  last_event_at: string | null;
}

/**
 * Platform-wide totals across every DAO partition.
 *
 * The partitions are stitched with `UNION ALL` and aggregated once by SQLite;
 * the relay never holds more than the single summary row.
 */
export async function getPlatformOverview(): Promise<PlatformOverview> {
  const daoIds = listAnalyticsPartitions();

  if (daoIds.length === 0) {
    return {
      daoCount: 0,
      proposalsCreated: 0,
      votesCast: 0,
      totalEvents: 0,
      firstEventAt: null,
      lastEventAt: null,
    };
  }

  const partitionSelects = daoIds.map(
    (daoId) =>
      sql`SELECT type, timestamp FROM ${sql.table(partitionTable(daoId))} WHERE verified = 1`,
  );

  const result = await sql<PlatformRow>`
    SELECT
      SUM(CASE WHEN type = 'proposal_created' THEN 1 ELSE 0 END) AS proposals_created,
      SUM(CASE WHEN type = 'vote_cast' THEN 1 ELSE 0 END) AS votes_cast,
      COUNT(*) AS total_events,
      MIN(timestamp) AS first_event_at,
      MAX(timestamp) AS last_event_at
    FROM (${sql.join(partitionSelects, sql` UNION ALL `)})
  `.execute(kysely);

  const row = result.rows[0];
  return {
    daoCount: daoIds.length,
    proposalsCreated: toNumber(row?.proposals_created),
    votesCast: toNumber(row?.votes_cast),
    totalEvents: toNumber(row?.total_events),
    firstEventAt: toNullableString(row?.first_event_at),
    lastEventAt: toNullableString(row?.last_event_at),
  };
}

// ============================================
// CSV EXPORT
// ============================================

const CSV_COLUMNS = [
  "dao_id",
  "proposal_id",
  "created_at",
  "closed_at",
  "votes_cast",
  "eligible_voters",
  "turnout_ratio",
] as const;

/**
 * Escape one CSV field.
 *
 * Values are quoted whenever they contain a delimiter, quote or newline, and a
 * leading `=`, `+`, `-` or `@` is prefixed so a spreadsheet does not evaluate
 * the cell as a formula.
 */
function csvField(value: string | number | null): string {
  if (value === null) return "";
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Render turnout rows as CSV, header included. */
export function turnoutToCsv(rows: ProposalTurnout[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        csvField(row.daoId),
        csvField(row.proposalId),
        csvField(row.createdAt),
        csvField(row.closedAt),
        csvField(row.votesCast),
        csvField(row.eligibleVoters),
        csvField(row.turnoutRatio === null ? null : row.turnoutRatio.toFixed(6)),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Log a completed analytics query.
 *
 * Only shape and timing are recorded: analytics reads touch vote events, and
 * an operator log is not a place to accumulate per-proposal query patterns.
 */
export function logAnalyticsQuery(
  metric: string,
  daoId: number | null,
  durationMs: number,
  rowCount: number,
): void {
  log("info", "analytics_query", { metric, daoId, durationMs, rowCount });
}
