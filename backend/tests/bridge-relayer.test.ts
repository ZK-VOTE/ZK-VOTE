/**
 * EVM → Soroban bridge relayer (ZV-038 / #887).
 *
 * A scriptable in-memory chain stands in for the EVM node; the VoteForwarded
 * log in fixtures/bridge-vote-forwarded.log.json was captured from Bridge.sol
 * on Hardhat, so decoding is checked against the real ABI encoding.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const TEST_DIR = fs.mkdtempSync(path.join(tmpdir(), "zkvote-bridge-relayer-"));
const here = path.dirname(fileURLToPath(import.meta.url));
const capturedLog = JSON.parse(fs.readFileSync(path.join(here, "fixtures/bridge-vote-forwarded.log.json"), "utf8"));

const { initDb, getDb } = await import("../src/services/db.ts");
initDb(path.join(TEST_DIR, "bridge.db"));
const evm = await import("../src/services/bridge-evm.ts");
const { BridgeRelayStore, decodeVoteForwardedLog, runRelayCycle, readBridgeRoots, createEvmRpc, VOTE_FORWARDED_TOPIC } = evm;
type EvmLog = import("../src/services/bridge-evm.ts").EvmLog;
type RelayRecord = import("../src/services/bridge-evm.ts").RelayRecord;

const CONTRACT = "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0";
const hex32 = (n: bigint | number) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;

/** A chain of blocks with hashes and logs; `reorg` replaces everything from a height on a new fork. */
class FakeChain {
  blocks: { hash: string; logs: EvmLog[] }[] = [{ hash: hex32(0xb0), logs: [] }];
  fork = 0;
  mine(logs: Omit<EvmLog, "blockNumber" | "blockHash">[] = []): number {
    const number = this.blocks.length;
    const hash = hex32(BigInt(this.fork) * 1_000_000n + BigInt(number) + 0xb000n);
    this.blocks.push({
      hash,
      logs: logs.map((l) => ({ ...l, blockNumber: `0x${number.toString(16)}`, blockHash: hash })),
    });
    return number;
  }
  mineEmpty(n: number) {
    for (let i = 0; i < n; i += 1) this.mine();
  }
  reorg(fromHeight: number) {
    this.fork += 1;
    this.blocks = this.blocks.slice(0, fromHeight);
  }
  rpc = {
    blockNumber: async () => this.blocks.length - 1,
    getBlockHash: async (n: number) => this.blocks[n]?.hash ?? null,
    getLogs: async (f: { address: string; fromBlock: number; toBlock: number; topics: string[] }) =>
      this.blocks
        .slice(f.fromBlock, f.toBlock + 1)
        .flatMap((b) => b.logs)
        .filter((l) => l.address.toLowerCase() === f.address.toLowerCase() && l.topics[0] === f.topics[0]),
    call: async () => hex32(0),
  };
}

function voteLog(nullifier: number, txIndex = nullifier): Omit<EvmLog, "blockNumber" | "blockHash"> {
  const words = [nullifier, 1, 0xabcdef, 98765, 31337].map((w) => BigInt(w).toString(16).padStart(64, "0"));
  return {
    address: CONTRACT,
    topics: [VOTE_FORWARDED_TOPIC, hex32(7), hex32(11)],
    data: `0x${words.join("")}`,
    transactionHash: hex32(0x7a00 + txIndex),
    logIndex: "0x0",
  };
}

function setup(confirmations = 2) {
  getDb().exec("DELETE FROM bridge_relay_votes; DELETE FROM bridge_relay_checkpoints;");
  const chain = new FakeChain();
  const store = new BridgeRelayStore();
  const relayed: RelayRecord[] = [];
  const logs: { level: string; event: string }[] = [];
  let failNext = 0;
  const cycle = () =>
    runRelayCycle({
      rpc: chain.rpc,
      store,
      contract: CONTRACT,
      confirmations,
      startBlock: 0,
      maxBlockRange: 100,
      maxAttempts: 3,
      relay: async (vote) => {
        if (failNext > 0) {
          failNext -= 1;
          return { success: false, error: "SIMULATION_FAILED" };
        }
        relayed.push(vote);
        return { success: true, stellarTxHash: `stellar-${vote.nullifier.slice(-4)}` };
      },
      log: (level, event) => void logs.push({ level, event }),
    });
  return { chain, store, relayed, logs, cycle, failOnce: (n = 1) => void (failNext = n) };
}

const status = (store: InstanceType<typeof BridgeRelayStore>, nullifier: number) =>
  store.get("7", "11", hex32(nullifier))?.status;

test("decodes the VoteForwarded log Bridge.sol emits", () => {
  const vote = decodeVoteForwardedLog(capturedLog);
  assert.equal(vote.daoId, "7");
  assert.equal(vote.proposalId, "11");
  assert.equal(vote.nullifier, hex32(0xdeadbeef));
  assert.equal(vote.voteChoice, 1);
  assert.equal(vote.voteRoot, hex32(0xabcdef));
  assert.equal(vote.memberAddr, hex32(98765));
  assert.equal(vote.chainId, "31337");
  assert.equal(vote.blockNumber, 6);
  assert.throws(() => decodeVoteForwardedLog({ ...capturedLog, topics: [hex32(1), ...capturedLog.topics.slice(1)] }), /not a VoteForwarded/);
  assert.throws(() => decodeVoteForwardedLog({ ...capturedLog, data: "0x1234" }), /malformed/);
});

test("a VoteForwarded event becomes one Soroban submission with a recorded hash, after finality", async () => {
  const { chain, store, relayed, cycle } = setup(2);
  chain.mine([voteLog(1)]);
  assert.equal((await cycle()).observed, 0, "not final yet");
  chain.mineEmpty(2);
  const result = await cycle();
  assert.equal(result.observed, 1);
  assert.equal(result.relayed, 1);
  assert.equal(relayed.length, 1);
  const record = store.get("7", "11", hex32(1))!;
  assert.equal(record.status, "relayed");
  assert.equal(record.stellarTxHash, "stellar-0001");
  assert.equal(record.evmTxHash, hex32(0x7a01));

  // The checkpoint persists: nothing is relayed again.
  chain.mineEmpty(3);
  await cycle();
  assert.equal(relayed.length, 1);
  assert.deepEqual(store.counts(), { pending: 0, relayed: 1, failed: 0, rolled_back: 0, orphaned: 0 });
});

test("failed submissions are retried, then marked failed", async () => {
  const { chain, store, cycle, failOnce } = setup(0);
  chain.mine([voteLog(2)]);
  failOnce(1);
  assert.equal((await cycle()).failed, 1);
  assert.equal(status(store, 2), "pending");
  assert.equal((await cycle()).relayed, 1, "retried on the next pass");

  chain.mine([voteLog(3)]);
  failOnce(3);
  await cycle();
  await cycle();
  await cycle();
  const record = store.get("7", "11", hex32(3))!;
  assert.equal(record.status, "failed");
  assert.equal(record.attempts, 3);
  assert.equal(record.lastError, "SIMULATION_FAILED");
});

test("votes orphaned by a reorg before relay are rolled back and relayed once from the new fork", async () => {
  const { chain, store, relayed, logs, cycle, failOnce } = setup(1);
  chain.mine([voteLog(4)]); // block 1
  chain.mineEmpty(1); // block 2: block 1 is final
  failOnce(1); // the relay is still pending when the fork happens
  await cycle();
  assert.equal(status(store, 4), "pending");

  // A deep reorg replaces blocks 1.. ; the vote is re-included later, in another tx.
  chain.reorg(1);
  chain.mineEmpty(1);
  const result = await cycle();
  assert.ok(result.reorg, "reorg detected from the checkpoint hash");
  assert.equal(result.reorg!.rolledBack, 1);
  assert.equal(status(store, 4), "rolled_back");
  assert.equal(relayed.length, 0, "an orphaned vote is not relayed");
  assert.ok(logs.some((l) => l.event === "bridge_evm_reorg"));

  chain.mine([voteLog(4, 0x44)]);
  chain.mineEmpty(1);
  await cycle();
  assert.equal(status(store, 4), "relayed");
  assert.equal(relayed.length, 1, "relayed exactly once");
  assert.equal(store.get("7", "11", hex32(4))!.evmTxHash, hex32(0x7a44), "tracks the canonical transaction");
});

test("a reorg after relay flags the vote instead of relaying it again", async () => {
  const { chain, store, relayed, logs, cycle } = setup(0);
  chain.mine([voteLog(5)]);
  await cycle();
  assert.equal(status(store, 5), "relayed");

  chain.reorg(1);
  chain.mineEmpty(1);
  const result = await cycle();
  assert.equal(result.reorg!.orphaned, 1);
  assert.equal(status(store, 5), "orphaned");
  assert.ok(logs.some((l) => l.event === "bridge_evm_reorg" && l.level === "error"));

  // The same vote re-included on the new fork: recognised, still not relayed twice.
  chain.mine([voteLog(5, 0x55)]);
  await cycle();
  assert.equal(status(store, 5), "relayed");
  assert.equal(relayed.length, 1);
});

test("roots are read from Bridge.sol with eth_call", async () => {
  const calls: string[] = [];
  const rpc = createEvmRpc("http://evm.test", (async (_url: string, init: RequestInit) => {
    const { method, params, id } = JSON.parse(String(init.body));
    assert.equal(method, "eth_call");
    calls.push(params[0].data);
    const value = params[0].data.startsWith("0xe57808ed") ? 0x1234 : params[0].data.startsWith("0x08e0e64d") ? 0xabcdef : 42;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: hex32(value) }));
  }) as unknown as typeof fetch);
  const roots = await readBridgeRoots(rpc, CONTRACT, 7n, 11n);
  assert.deepEqual(roots, { sbtRoot: hex32(0x1234), voteRoot: hex32(0xabcdef), sbtRootBlock: 42 });
  assert.ok(calls.includes(`0xe57808ed${"7".padStart(64, "0")}`));
  assert.ok(calls.includes(`0x08e0e64d${"7".padStart(64, "0")}${"b".padStart(64, "0")}`));
});
