// Central ZkVote client — unified SDK
// Provides contract clients + proof orchestration + offline queue + drift guard

import { Client as DaoRegistryClient } from "../contracts/dao-registry/dist/index.js";
import { Client as MembershipSbtClient } from "../contracts/membership-sbt/dist/index.js";
import { Client as MembershipTreeClient } from "../contracts/membership-tree/dist/index.js";
import { Client as VotingClient } from "../contracts/voting/dist/index.js";
import { Client as CommentsClient } from "../contracts/comments/dist/index.js";
import { NETWORK_CONFIG, CONTRACTS } from "../config/contracts";
import { relayerFetch } from "./api";
import {
  generateVoteProof,
  generateWeightedVoteProof,
  generateBridgeProof,
  formatProofForSoroban,
  calculateNullifier,
  fetchVersionedVK,
  detectVKMismatch,
  validateWeight,
  type VoteProofInput,
  type WeightedVoteProofInput,
  type BridgeProofInput,
} from "./zkproof";
import {
  getZKCredentials,
  generateDeterministicZKCredentials,
  storeZKCredentials,
} from "./zk";
import {
  getOfflineQueue,
  enqueueOfflineAction,
  dequeueOfflineAction,
  updateQueueRetries,
  processOfflineQueue,
} from "./offlineQueue";
import { checkContractDrift } from "./driftGuard";

export interface ContractClients {
  daoRegistry: DaoRegistryClient;
  membershipSbt: MembershipSbtClient;
  membershipTree: MembershipTreeClient;
  voting: VotingClient;
  comments: CommentsClient;
}

// Re-export queue helpers for convenience
export {
  getOfflineQueue,
  enqueueOfflineAction,
  dequeueOfflineAction,
  updateQueueRetries,
  processOfflineQueue,
};

export {
  checkContractDrift,
  assertNoDrift,
  type DriftReport,
} from "./driftGuard";

// ============================================
// Central Client
// ============================================

export class ZkVoteClient {
  public readonly daoRegistry: DaoRegistryClient;
  public readonly membershipSbt: MembershipSbtClient;
  public readonly membershipTree: MembershipTreeClient;
  public readonly voting: VotingClient;
  public readonly comments: CommentsClient;
  public readonly publicKey: string | null;

  constructor(publicKey: string | null) {
    this.publicKey = publicKey;
    const baseOpts = {
      networkPassphrase: NETWORK_CONFIG.networkPassphrase,
      rpcUrl: NETWORK_CONFIG.rpcUrl,
      allowHttp: true,
    };
    if (publicKey) {
      const opts = { ...baseOpts, publicKey };
      this.daoRegistry = new DaoRegistryClient({
        ...opts,
        contractId: CONTRACTS.REGISTRY_ID,
      });
      this.membershipSbt = new MembershipSbtClient({
        ...opts,
        contractId: CONTRACTS.SBT_ID,
      });
      this.membershipTree = new MembershipTreeClient({
        ...opts,
        contractId: CONTRACTS.TREE_ID,
      });
      this.voting = new VotingClient({
        ...opts,
        contractId: CONTRACTS.VOTING_ID,
      });
      this.comments = new CommentsClient({
        ...opts,
        contractId: CONTRACTS.COMMENTS_ID,
      });
    } else {
      // Read-only mode (no publicKey)
      this.daoRegistry = new DaoRegistryClient({
        ...baseOpts,
        contractId: CONTRACTS.REGISTRY_ID,
      }) as unknown as DaoRegistryClient;
      this.membershipSbt = new MembershipSbtClient({
        ...baseOpts,
        contractId: CONTRACTS.SBT_ID,
      }) as unknown as MembershipSbtClient;
      this.membershipTree = new MembershipTreeClient({
        ...baseOpts,
        contractId: CONTRACTS.TREE_ID,
      }) as unknown as MembershipTreeClient;
      this.voting = new VotingClient({
        ...baseOpts,
        contractId: CONTRACTS.VOTING_ID,
      }) as unknown as VotingClient;
      this.comments = new CommentsClient({
        ...baseOpts,
        contractId: CONTRACTS.COMMENTS_ID,
      }) as unknown as CommentsClient;
    }
  }

  /**
   * Proof orchestration: generates vote proof with versioned VK handling and submits via relayer,
   * with offline queue fallback.
   */
  async orchestrateVote(params: {
    daoId: number;
    proposalId: number;
    choice: boolean;
    kit: {
      signMessage: (msg: string) => Promise<{ signedMessage: string }>;
      signTransaction: (tx: string) => Promise<string>;
    } | null;
    voteMode: "Fixed" | "Trailing";
    eligibleRoot: bigint;
    vkVersion?: number | null;
  }): Promise<{ txHash: string; queued?: boolean }> {
    if (!this.publicKey) throw new Error("publicKey required for voting");

    // 1. Drift guard check (non-blocking warning)
    await checkContractDrift().catch(() => {});

    // 2. VK version mismatch detection
    if (params.vkVersion != null) {
      try {
        const cachedVK = await fetchVersionedVK(
          "vote_v1",
          params.vkVersion,
        ).catch(() => null);
        const currentVer = cachedVK?.version ?? params.vkVersion;
        detectVKMismatch(params.vkVersion, currentVer);
      } catch (e) {
        if (
          (e as Error).name === "VKMismatchError" ||
          (e as Error).name === "StaleVKError"
        )
          throw e;
      }
    }

    // 3. Load or regenerate credentials
    let secret: string, salt: string, commitment: string, leafIndex: number;
    const cached = getZKCredentials(params.daoId, this.publicKey);
    if (!cached) {
      if (!params.kit)
        throw new Error("No voting credentials — register first");
      const creds = await generateDeterministicZKCredentials(
        params.kit as never,
        params.daoId,
      );
      const leafRes = await this.membershipTree.get_leaf_index({
        dao_id: BigInt(params.daoId),
        commitment: BigInt(creds.commitment),
      });
      leafIndex = Number((leafRes as unknown as { result: bigint }).result);
      secret = creds.secret;
      salt = creds.salt;
      commitment = creds.commitment;
      storeZKCredentials(params.daoId, this.publicKey, creds, leafIndex);
    } else {
      secret = cached.secret;
      salt = cached.salt;
      commitment = cached.commitment;
      leafIndex = cached.leafIndex;
    }

    // 4. Root selection
    let root: bigint;
    if (params.voteMode === "Fixed") {
      root = params.eligibleRoot;
    } else {
      const cur = await this.membershipTree.current_root({
        dao_id: BigInt(params.daoId),
      });
      root = (cur as unknown as { result: bigint }).result;
    }

    // 5. Merkle path (via client to avoid circular dependency)
    const merkleRes = await this.membershipTree.get_merkle_path({
      dao_id: BigInt(params.daoId),
      leaf_index: leafIndex,
    });
    const raw = (merkleRes as unknown as { result: [bigint[], number[]] })
      .result;
    const pathElements = raw[0].map((e: bigint) => e.toString());
    const pathIndices = raw[1].map((i: number) => Number(i));

    // 6. Nullifier
    const nullifier = await calculateNullifier(
      secret,
      params.daoId.toString(),
      params.proposalId.toString(),
    );

    // 7. Generate proof
    const wasmPath = "/circuits/vote.wasm";
    const zkeyPath = "/circuits/vote_final.zkey";
    const proofInput: VoteProofInput = {
      secret,
      salt,
      root: root.toString(),
      nullifier,
      daoId: params.daoId.toString(),
      proposalId: params.proposalId.toString(),
      voteChoice: params.choice ? "1" : "0",
      commitment,
      pathElements,
      pathIndices,
    };
    const { proof, redundantProof } = await generateVoteProof(
      proofInput,
      wasmPath,
      zkeyPath,
    );
    const { proof_a, proof_b, proof_c } = formatProofForSoroban(proof);
    const formattedRedundantProof = redundantProof
      ? formatProofForSoroban(redundantProof)
      : null;

    const toHexBE = (v: string | bigint): string => {
      const bi = typeof v === "string" ? BigInt(v) : v;
      return bi.toString(16).padStart(64, "0");
    };

    const payload = {
      daoId: params.daoId,
      proposalId: params.proposalId,
      choice: params.choice,
      nullifier: toHexBE(nullifier),
      root: toHexBE(root),
      proof: { a: proof_a, b: proof_b, c: proof_c },
      ...(formattedRedundantProof
        ? {
            redundantProof: {
              a: formattedRedundantProof.proof_a,
              b: formattedRedundantProof.proof_b,
              c: formattedRedundantProof.proof_c,
            },
          }
        : {}),
    };

    // 8. Submit with offline queue fallback
    const isOnline = typeof navigator !== "undefined" ? navigator.onLine : true;
    if (!isOnline) {
      enqueueOfflineAction({
        type: "vote",
        payload: payload as unknown as Record<string, unknown>,
        daoId: params.daoId,
      });
      return { txHash: "queued_offline", queued: true };
    }

    try {
      const res = await relayerFetch("/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }));
        throw new Error(err.error || "Vote submission failed");
      }
      const data = await res.json();
      return { txHash: data.txHash };
    } catch (e) {
      const stillOnline =
        typeof navigator !== "undefined" ? navigator.onLine : true;
      if (
        (e as Error).message.includes("fetch") ||
        (e as Error).message.includes("Network") ||
        !stillOnline
      ) {
        enqueueOfflineAction({
          type: "vote",
          payload: payload as unknown as Record<string, unknown>,
          daoId: params.daoId,
        });
        return { txHash: "queued_offline", queued: true };
      }
      throw e;
    }
  }

  async orchestrateWeightedVote(params: {
    daoId: number;
    proposalId: number;
    choice: boolean;
    weight: string;
    maxWeight: string;
    kit: unknown;
    voteMode: "Fixed" | "Trailing";
    eligibleRoot: bigint;
  }): Promise<{ txHash: string; queued?: boolean }> {
    validateWeight(params.weight, params.maxWeight);
    return this.orchestrateVote(params as never);
  }

  async orchestrateBridgeVote(
    input: BridgeProofInput,
  ): Promise<GeneratedProof> {
    return generateBridgeProof(input);
  }
}

// Singleton cache per publicKey
const clientCache = new Map<string, ZkVoteClient>();
const readOnlySingleton = new ZkVoteClient(null);

export function getZkVoteClient(publicKey: string | null): ZkVoteClient {
  if (!publicKey) return readOnlySingleton;
  const existing = clientCache.get(publicKey);
  if (existing) return existing;
  const c = new ZkVoteClient(publicKey);
  clientCache.set(publicKey, c);
  return c;
}

// For tests: clear cache
export function __clearClientCache(): void {
  clientCache.clear();
}
