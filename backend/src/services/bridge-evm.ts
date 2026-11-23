/**
 * EVM side of the bridge relayer (ZV-038 / #887).
 *
 * Reads `VoteForwarded` logs from Bridge.sol over plain JSON-RPC (no client
 * library: eth_blockNumber, eth_getLogs, eth_getBlockByNumber, eth_call),
 * persists a block checkpoint, and drives each forwarded vote to a Soroban
 * `relay_vote` submission exactly once.
 *
 * Finality and reorgs:
 * - Only blocks at least `confirmations` deep are scanned, so an ordinary
 *   reorg never reaches the relayer.
 * - The checkpoint stores the scanned block's hash. If the chain no longer
 *   has that hash at that height, a deeper reorg happened: the relayer
 *   rewinds by a reorg window, marks votes from the orphaned blocks that were
 *   not yet relayed as `rolled_back`, and rescans. A vote that reappears on
 *   the canonical chain goes back to `pending`; one that was already relayed
 *   is flagged `orphaned` for an operator, never relayed again.
 * - Votes are keyed by (dao, proposal, nullifier), the same key the Soroban
 *   bridge uses, so nothing is relayed twice.
 */
import type { Database as DatabaseType } from "better-sqlite3";
import { getDb } from "./db.js";

/** keccak256("VoteForwarded(uint256,uint256,uint256,uint256,uint256,uint256,uint256)") — checked against the compiled ABI in contracts/bridge/evm/test/RelayerAbi.test.js. */
export const VOTE_FORWARDED_TOPIC =
  "0xfdfc70c1df53e42ab4151c64a25e4de557d833429ff38fcae423633de3fd16ef";

/** Function selectors of Bridge.sol views (first 4 bytes of keccak256 of the signature). */
export const BRIDGE_SELECTORS = {
  getSbtRoot: "0xe57808ed", // getSbtRoot(uint256)
  getVoteRoot: "0x08e0e64d", // getVoteRoot(uint256,uint256)
  sbtRootBlock: "0x43162e32", // sbtRootBlock(uint256)
} as const;

export interface EvmLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

export interface ForwardedVote {
  daoId: string;
  proposalId: string;
  nullifier: string;
  voteChoice: number;
  voteRoot: string;
  memberAddr: string;
  chainId: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
}

const word = (hex: string, index: number): string => hex.slice(2 + index * 64, 2 + (index + 1) * 64);
const toBigInt = (hex: string): bigint => BigInt(hex.startsWith("0x") ? hex : `0x${hex}`);
const toHex32 = (value: bigint): string => `0x${value.toString(16).padStart(64, "0")}`;
const toQuantity = (n: number): string => `0x${n.toString(16)}`;

/** Decodes a Bridge.sol `VoteForwarded` log. Throws on anything else. */
export function decodeVoteForwardedLog(log: EvmLog): ForwardedVote {
  if (log.topics[0]?.toLowerCase() !== VOTE_FORWARDED_TOPIC || log.topics.length !== 3) {
    throw new Error("not a VoteForwarded log");
  }
  if (!/^0x[0-9a-fA-F]{320}$/.test(log.data)) throw new Error("malformed VoteForwarded data");
  const voteChoice = toBigInt(word(log.data, 1));
  if (voteChoice > 1n) throw new Error("VoteForwarded voteChoice out of range");
  return {
    daoId: toBigInt(log.topics[1]).toString(),
    proposalId: toBigInt(log.topics[2]).toString(),
    nullifier: toHex32(toBigInt(word(log.data, 0))),
    voteChoice: Number(voteChoice),
    voteRoot: toHex32(toBigInt(word(log.data, 2))),
    memberAddr: toHex32(toBigInt(word(log.data, 3))),
    chainId: toBigInt(word(log.data, 4)).toString(),
    txHash: log.transactionHash,
    logIndex: Number(toBigInt(log.logIndex)),
    blockNumber: Number(toBigInt(log.blockNumber)),
    blockHash: log.blockHash.toLowerCase(),
  };
}

/** The JSON-RPC calls the relayer needs. */
export interface EvmRpc {
  blockNumber(): Promise<number>;
  getBlockHash(blockNumber: number): Promise<string | null>;
  getLogs(filter: { address: string; fromBlock: number; toBlock: number; topics: string[] }): Promise<EvmLog[]>;
  call(to: string, data: string): Promise<string>;
}

export function createEvmRpc(url: string, fetchImpl: typeof fetch = fetch): EvmRpc {
  let nextId = 1;
  async function request<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`EVM RPC ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(`EVM RPC ${method}: ${body.error.message ?? "error"}`);
    return body.result as T;
  }
  return {
    blockNumber: async () => Number(BigInt(await request<string>("eth_blockNumber", []))),
    getBlockHash: async (n) => {
      const block = await request<{ hash: string } | null>("eth_getBlockByNumber", [toQuantity(n), false]);
      return block?.hash?.toLowerCase() ?? null;
    },
    getLogs: (filter) =>
      request<EvmLog[]>("eth_getLogs", [
        {
          address: filter.address,
          fromBlock: toQuantity(filter.fromBlock),
          toBlock: toQuantity(filter.toBlock),
          topics: filter.topics,
        },
      ]),
    call: (to, data) => request<string>("eth_call", [{ to, data }, "latest"]),
  };
}

/** Reads the roots Bridge.sol has anchored for a DAO and proposal (what castVote checks against). */
export async function readBridgeRoots(
  rpc: EvmRpc,
  contract: string,
  daoId: bigint,
  proposalId: bigint,
): Promise<{ sbtRoot: string; voteRoot: string; sbtRootBlock: number }> {
  const arg = (v: bigint) => v.toString(16).padStart(64, "0");
  const [sbt, vote, block] = await Promise.all([
    rpc.call(contract, `${BRIDGE_SELECTORS.getSbtRoot}${arg(daoId)}`),
    rpc.call(contract, `${BRIDGE_SELECTORS.getVoteRoot}${arg(daoId)}${arg(proposalId)}`),
    rpc.call(contract, `${BRIDGE_SELECTORS.sbtRootBlock}${arg(daoId)}`),
  ]);
  return { sbtRoot: toHex32(toBigInt(sbt)), voteRoot: toHex32(toBigInt(vote)), sbtRootBlock: Number(toBigInt(block)) };
}

// ── Persistence ──────────────────────────────────────────────────────────────

export type RelayStatus = "pending" | "relayed" | "failed" | "rolled_back" | "orphaned";

export interface RelayRecord {
  daoId: string;
  proposalId: string;
  nullifier: string;
  voteChoice: number;
  voteRoot: string;
  evmTxHash: string;
  evmLogIndex: number;
  blockNumber: number;
  blockHash: string;
  status: RelayStatus;
  attempts: number;
  lastError: string | null;
  stellarTxHash: string | null;
  updatedAt: number;
}

interface VoteRow {
  dao_id: string;
  proposal_id: string;
  nullifier: string;
  vote_choice: number;
  vote_root: string;
  evm_tx_hash: string;
  evm_log_index: number;
  block_number: number;
  block_hash: string;
  status: RelayStatus;
  attempts: number;
  last_error: string | null;
  stellar_tx_hash: string | null;
  updated_at: number;
}

const toRecord = (r: VoteRow): RelayRecord => ({
  daoId: r.dao_id,
  proposalId: r.proposal_id,
  nullifier: r.nullifier,
  voteChoice: r.vote_choice,
  voteRoot: r.vote_root,
  evmTxHash: r.evm_tx_hash,
  evmLogIndex: r.evm_log_index,
  blockNumber: r.block_number,
  blockHash: r.block_hash,
  status: r.status,
  attempts: r.attempts,
  lastError: r.last_error,
  stellarTxHash: r.stellar_tx_hash,
  updatedAt: r.updated_at,
});

export class BridgeRelayStore {
  constructor(private readonly db: () => DatabaseType = getDb) {}

  getCheckpoint(contract: string): { blockNumber: number; blockHash: string } | null {
    const row = this.db()
      .prepare("SELECT block_number, block_hash FROM bridge_relay_checkpoints WHERE contract_address = ?")
      .get(contract.toLowerCase()) as { block_number: number; block_hash: string } | undefined;
    return row ? { blockNumber: row.block_number, blockHash: row.block_hash } : null;
  }

  setCheckpoint(contract: string, blockNumber: number, blockHash: string): void {
    this.db()
      .prepare(
        `INSERT INTO bridge_relay_checkpoints (contract_address, block_number, block_hash, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(contract_address) DO UPDATE SET
           block_number = excluded.block_number, block_hash = excluded.block_hash, updated_at = excluded.updated_at`,
      )
      .run(contract.toLowerCase(), blockNumber, blockHash, Date.now());
  }

  /**
   * Records an observed vote. A new vote is `pending`; a rolled-back vote seen
   * again on the canonical chain returns to `pending` at its new position; a
   * vote already relayed (or pending) is left alone, so it is never relayed twice.
   */
  observe(vote: ForwardedVote): void {
    const now = Date.now();
    this.db()
      .prepare(
        `INSERT INTO bridge_relay_votes
           (dao_id, proposal_id, nullifier, vote_choice, vote_root, evm_tx_hash, evm_log_index,
            block_number, block_hash, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT(dao_id, proposal_id, nullifier) DO UPDATE SET
           status = 'pending', attempts = 0, last_error = NULL,
           evm_tx_hash = excluded.evm_tx_hash, evm_log_index = excluded.evm_log_index,
           block_number = excluded.block_number, block_hash = excluded.block_hash,
           vote_choice = excluded.vote_choice, vote_root = excluded.vote_root,
           updated_at = excluded.updated_at
         WHERE bridge_relay_votes.status = 'rolled_back'`,
      )
      .run(
        vote.daoId,
        vote.proposalId,
        vote.nullifier,
        vote.voteChoice,
        vote.voteRoot,
        vote.txHash,
        vote.logIndex,
        vote.blockNumber,
        vote.blockHash,
        now,
        now,
      );
  }

  /** Votes from blocks above `blockNumber` were orphaned by a reorg. */
  rollBackAbove(blockNumber: number): { rolledBack: number; orphaned: number } {
    const db = this.db();
    const now = Date.now();
    const rolledBack = db
      .prepare(
        `UPDATE bridge_relay_votes SET status = 'rolled_back', updated_at = ?
         WHERE block_number > ? AND status IN ('pending', 'failed')`,
      )
      .run(now, blockNumber).changes;
    // Already on Soroban: cannot be undone here. Flag for an operator.
    const orphaned = db
      .prepare(
        `UPDATE bridge_relay_votes SET status = 'orphaned', updated_at = ?
         WHERE block_number > ? AND status = 'relayed'`,
      )
      .run(now, blockNumber).changes;
    return { rolledBack, orphaned };
  }

  /** A relayed vote seen again on the canonical chain is no longer orphaned. */
  confirmRelayed(vote: ForwardedVote): void {
    this.db()
      .prepare(
        `UPDATE bridge_relay_votes SET status = 'relayed', block_number = ?, block_hash = ?, updated_at = ?
         WHERE dao_id = ? AND proposal_id = ? AND nullifier = ? AND status = 'orphaned'`,
      )
      .run(vote.blockNumber, vote.blockHash, Date.now(), vote.daoId, vote.proposalId, vote.nullifier);
  }

  pending(limit = 50): RelayRecord[] {
    return (
      this.db()
        .prepare(
          `SELECT * FROM bridge_relay_votes WHERE status = 'pending'
           ORDER BY block_number ASC, evm_log_index ASC LIMIT ?`,
        )
        .all(limit) as VoteRow[]
    ).map(toRecord);
  }

  markRelayed(record: RelayRecord, stellarTxHash: string): void {
    this.db()
      .prepare(
        `UPDATE bridge_relay_votes SET status = 'relayed', stellar_tx_hash = ?, attempts = attempts + 1,
           last_error = NULL, updated_at = ?
         WHERE dao_id = ? AND proposal_id = ? AND nullifier = ? AND status = 'pending'`,
      )
      .run(stellarTxHash, Date.now(), record.daoId, record.proposalId, record.nullifier);
  }

  markFailed(record: RelayRecord, error: string, maxAttempts: number): void {
    this.db()
      .prepare(
        `UPDATE bridge_relay_votes
         SET attempts = attempts + 1, last_error = ?, updated_at = ?,
             status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
         WHERE dao_id = ? AND proposal_id = ? AND nullifier = ? AND status = 'pending'`,
      )
      .run(error, Date.now(), maxAttempts, record.daoId, record.proposalId, record.nullifier);
  }

  get(daoId: string, proposalId: string, nullifier: string): RelayRecord | null {
    const row = this.db()
      .prepare("SELECT * FROM bridge_relay_votes WHERE dao_id = ? AND proposal_id = ? AND nullifier = ?")
      .get(daoId, proposalId, nullifier) as VoteRow | undefined;
    return row ? toRecord(row) : null;
  }

  counts(): Record<RelayStatus, number> {
    const counts: Record<RelayStatus, number> = { pending: 0, relayed: 0, failed: 0, rolled_back: 0, orphaned: 0 };
    for (const row of this.db()
      .prepare("SELECT status, COUNT(*) AS n FROM bridge_relay_votes GROUP BY status")
      .all() as { status: RelayStatus; n: number }[]) {
      counts[row.status] = row.n;
    }
    return counts;
  }
}

// ── Relay cycle ──────────────────────────────────────────────────────────────

export interface RelayCycleDeps {
  rpc: EvmRpc;
  store: BridgeRelayStore;
  contract: string;
  confirmations: number;
  startBlock: number;
  maxBlockRange: number;
  maxAttempts: number;
  /** Submits one vote to Soroban `relay_vote`; resolves with the Stellar tx hash or an error. */
  relay(vote: RelayRecord): Promise<{ success: boolean; stellarTxHash?: string; error?: string }>;
  log(level: "info" | "warn" | "error", event: string, meta?: Record<string, unknown>): void;
}

export interface RelayCycleResult {
  scannedFrom: number | null;
  scannedTo: number | null;
  observed: number;
  relayed: number;
  failed: number;
  reorg: { rewoundTo: number; rolledBack: number; orphaned: number } | null;
}

/**
 * One relayer pass: detect reorgs, scan newly finalized blocks for
 * VoteForwarded logs, then submit pending votes to Soroban.
 */
export async function runRelayCycle(deps: RelayCycleDeps): Promise<RelayCycleResult> {
  const { rpc, store, contract } = deps;
  const result: RelayCycleResult = { scannedFrom: null, scannedTo: null, observed: 0, relayed: 0, failed: 0, reorg: null };

  const head = await rpc.blockNumber();
  const finalized = head - deps.confirmations;
  let checkpoint = store.getCheckpoint(contract);

  // 1. Reorg detection: the scanned block must still be canonical (a chain
  //    that got shorter than the checkpoint is a reorg too).
  if (checkpoint && checkpoint.blockNumber >= 0) {
    const canonical = await rpc.getBlockHash(checkpoint.blockNumber);
    if (canonical !== checkpoint.blockHash) {
      const window = Math.max(deps.confirmations * 2, 1);
      const rewoundTo = Math.max(deps.startBlock - 1, checkpoint.blockNumber - window);
      const { rolledBack, orphaned } = store.rollBackAbove(rewoundTo);
      const rewoundHash = rewoundTo >= 0 ? ((await rpc.getBlockHash(rewoundTo)) ?? "") : "";
      store.setCheckpoint(contract, rewoundTo, rewoundHash);
      result.reorg = { rewoundTo, rolledBack, orphaned };
      deps.log(orphaned > 0 ? "error" : "warn", "bridge_evm_reorg", {
        checkpoint: checkpoint.blockNumber,
        rewoundTo,
        rolledBack,
        orphaned,
      });
      checkpoint = store.getCheckpoint(contract);
    }
  }

  // 2. Scan newly finalized blocks.
  const from = checkpoint ? checkpoint.blockNumber + 1 : deps.startBlock;
  if (from <= finalized) {
    const to = Math.min(finalized, from + deps.maxBlockRange - 1);
    const logs = await rpc.getLogs({ address: contract, fromBlock: from, toBlock: to, topics: [VOTE_FORWARDED_TOPIC] });
    for (const log of logs) {
      if (log.removed) continue;
      let vote: ForwardedVote;
      try {
        vote = decodeVoteForwardedLog(log);
      } catch (err) {
        deps.log("warn", "bridge_evm_log_skipped", { txHash: log.transactionHash, error: (err as Error).message });
        continue;
      }
      store.observe(vote);
      store.confirmRelayed(vote);
      result.observed += 1;
    }
    const toHash = await rpc.getBlockHash(to);
    if (!toHash) throw new Error(`EVM block ${to} not found`);
    store.setCheckpoint(contract, to, toHash);
    result.scannedFrom = from;
    result.scannedTo = to;
  }

  // 3. Relay what is pending, oldest first.
  for (const vote of store.pending()) {
    const outcome = await deps.relay(vote);
    if (outcome.success && outcome.stellarTxHash) {
      store.markRelayed(vote, outcome.stellarTxHash);
      result.relayed += 1;
    } else {
      store.markFailed(vote, outcome.error ?? "relay failed", deps.maxAttempts);
      result.failed += 1;
    }
  }
  return result;
}
