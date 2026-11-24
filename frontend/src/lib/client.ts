// Central ZkVote client — unified SDK
// Provides contract clients + proof orchestration + offline queue + drift guard

import { Client as DaoRegistryClient } from "../contracts/dao-registry/dist/index.js";
import { Client as MembershipSbtClient } from "../contracts/membership-sbt/dist/index.js";
import { Client as MembershipTreeClient } from "../contracts/membership-tree/dist/index.js";
import { Client as VotingClient } from "../contracts/voting/dist/index.js";
import { Client as CommentsClient } from "../contracts/comments/dist/index.js";
import { NETWORK_CONFIG, CONTRACTS } from "../config/contracts";
import { RELAYER_URL } from "../config/env";
import nacl from "tweetnacl";
import { StrKey } from "@stellar/stellar-sdk";
import { relayerFetch } from "./api";
import {
  generateVoteProof,
  generateEncryptedVoteProof,
  generateWeightedVoteProof,
  generateBridgeProof,
  formatProofForSoroban,
  calculateNullifier,
  fetchVersionedVK,
  detectVKMismatch,
  validateWeight,
  type VoteProofInput,
  type EncryptedVoteProofInput,
  type WeightedVoteProofInput,
  type BridgeProofInput,
  type GeneratedProof,
} from "./zkproof";
import {
  encryptBallot,
  pointToHex,
  randomScalar,
  type Point,
} from "./elgamal";
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
import { withMaskedTiming } from "./proofTiming";

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
    /** Bound into circuit public signals; defaults to 2 for binary ballots (#645) */
    numCandidates?: number;
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
    let secret: string, salt: string, blindingFactor: string, commitment: string, leafIndex: number;
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
      blindingFactor = (creds as unknown as { blindingFactor: string }).blindingFactor ?? "0";
      commitment = creds.commitment;
      storeZKCredentials(params.daoId, this.publicKey, creds, leafIndex);
    } else {
      secret = cached.secret;
      salt = cached.salt;
      blindingFactor = (cached as unknown as { blindingFactor: string }).blindingFactor ?? "0";
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
    // The circuit constrains `voteChoice < numCandidates` against this PUBLIC
    // signal, and the contract verifies the proof with the same value it
    // reports here. It is not optional: with numCandidates left at 0 the
    // constraint is unsatisfiable and no witness can be produced.
    //
    // The contract is the source of truth — it knows the configured candidate
    // count and floors the value at 2 for a binary ballot. A caller-supplied
    // `params.numCandidates` (#645) still wins when present, so a caller that
    // already knows the value does not pay for the read.
    let numCandidates = params.numCandidates;
    if (numCandidates === undefined) {
      const effective = await this.voting.get_effective_num_candidates({
        dao_id: BigInt(params.daoId),
        proposal_id: BigInt(params.proposalId),
      });
      numCandidates = (effective as unknown as { result: number }).result;
    }
    const proofInput: VoteProofInput = {
      secret,
      salt,
      blindingFactor,
      root: root.toString(),
      nullifier,
      daoId: params.daoId.toString(),
      proposalId: params.proposalId.toString(),
      voteChoice: params.choice ? "1" : "0",
      numCandidates: numCandidates.toString(),
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

  /**
   * Encrypted-ballot voting path (`vote_encrypted.circom`).
   *
   * The choice is encrypted client-side under the election's Baby Jubjub key;
   * only ciphertext is sent to the relayer. Totals stay hidden until the 2-of-3
   * ceremony finalizes after `end_time`.
   */
  async orchestrateEncryptedVote(params: {
    daoId: number;
    proposalId: number;
    choice: boolean;
    kit: {
      signMessage: (msg: string) => Promise<{ signedMessage: string }>;
      signTransaction: (tx: string) => Promise<string>;
    } | null;
    voteMode: "Fixed" | "Trailing";
    eligibleRoot: bigint;
    /** Election public key registered in `EncryptedTallyConfig`. */
    encryptionPublicKey: Point;
    /** Registry epoch the proposal was created at. */
    epoch: number;
    wasmPath?: string;
    zkeyPath?: string;
  }): Promise<{ txHash: string; ciphertext: { c1: string; cYes: string; cNo: string } }> {
    if (!this.publicKey) throw new Error("publicKey required for voting");

    await checkContractDrift().catch(() => {});

    let secret: string;
    let salt: string;
    let blindingFactor: string;
    let leafIndex: number;
    const cached = getZKCredentials(params.daoId, this.publicKey);
    if (!cached) {
      if (!params.kit) throw new Error("No voting credentials — register first");
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
      blindingFactor =
        (creds as unknown as { blindingFactor: string }).blindingFactor ?? "0";
      storeZKCredentials(params.daoId, this.publicKey, creds, leafIndex);
    } else {
      secret = cached.secret;
      salt = cached.salt;
      blindingFactor =
        (cached as unknown as { blindingFactor: string }).blindingFactor ?? "0";
      leafIndex = cached.leafIndex;
    }

    let root: bigint;
    if (params.voteMode === "Fixed") {
      root = params.eligibleRoot;
    } else {
      const cur = await this.membershipTree.current_root({
        dao_id: BigInt(params.daoId),
      });
      root = (cur as unknown as { result: bigint }).result;
    }

    const merkleRes = await this.membershipTree.get_merkle_path({
      dao_id: BigInt(params.daoId),
      leaf_index: leafIndex,
    });
    const raw = (merkleRes as unknown as { result: [bigint[], number[]] })
      .result;
    const pathElements = raw[0].map((e: bigint) => e.toString());
    const pathIndices = raw[1].map((i: number) => Number(i));

    const nullifier = await calculateNullifier(
      secret,
      params.daoId.toString(),
      params.proposalId.toString(),
    );

    const ballot = await encryptBallot(
      params.encryptionPublicKey,
      params.choice,
      randomScalar(),
    );
    const proofInput: EncryptedVoteProofInput = {
      root: root.toString(),
      nullifier,
      daoId: params.daoId.toString(),
      proposalId: params.proposalId.toString(),
      numCandidates: "2",
      epoch: params.epoch.toString(),
      publicKey: [
        params.encryptionPublicKey.x.toString(),
        params.encryptionPublicKey.y.toString(),
      ],
      c1: [ballot.c1.x.toString(), ballot.c1.y.toString()],
      cYes: [ballot.cYes.x.toString(), ballot.cYes.y.toString()],
      cNo: [ballot.cNo.x.toString(), ballot.cNo.y.toString()],
      relayerAddress: "0",
      voteChoice: params.choice ? "1" : "0",
      secret,
      salt,
      blindingFactor,
      randomness: ballot.randomness.toString(),
      pathElements,
      pathIndices,
    };

    const { proof } = await generateEncryptedVoteProof(
      proofInput,
      params.wasmPath ?? "/circuits/vote_encrypted.wasm",
      params.zkeyPath ?? "/circuits/vote_encrypted_final.zkey",
    );
    const { proof_a, proof_b, proof_c } = formatProofForSoroban(proof);
    const toHexBE = (v: string | bigint): string => {
      const bi = typeof v === "string" ? BigInt(v) : v;
      return bi.toString(16).padStart(64, "0");
    };

    const ciphertext = {
      c1: pointToHex(ballot.c1),
      cYes: pointToHex(ballot.cYes),
      cNo: pointToHex(ballot.cNo),
    };

    const res = await withMaskedTiming(async () =>
      relayerFetch("/vote-encrypted", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          daoId: params.daoId,
          proposalId: params.proposalId,
          nullifier: toHexBE(nullifier),
          root: toHexBE(root),
          epoch: params.epoch,
          c1: ciphertext.c1,
          cYes: ciphertext.cYes,
          cNo: ciphertext.cNo,
          proof: { a: proof_a, b: proof_b, c: proof_c },
        }),
      }),
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "unknown" }));
      throw new Error(err.error || "Encrypted vote submission failed");
    }
    const data = await res.json();
    return { txHash: data.txHash, ciphertext };
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

// ============================================
// Sponsored (zero-fee) vote submission SDK
// ============================================
//
// The voter signs a short-lived authorization object and sends only that to
// the relayer — no funded Stellar transaction, no base fee, no resource fee.
// The canonical payload below MUST stay byte-identical to
// backend/src/services/relayer-fee-economics.ts (`canonicalVoteAuthPayload`).

export const VOTE_AUTH_DOMAIN = "zkvote.vote-authorization.v1";
export const VOTE_AUTH_VERSION = 1;

export interface VoteAuthorizationFields {
  version: number;
  domain: string;
  chainId: string;
  daoId: number | string;
  proposalId: number | string;
  voter: string;
  commitment?: string;
  nullifier: string;
  choice: boolean | number;
  relayer: string;
  /** Unix seconds. */
  expiry: number;
  nonce: string;
  signerPublicKey: string;
}

export interface VoteAuthorization extends VoteAuthorizationFields {
  /** Base64 Ed25519 detached signature over sha256(canonical payload). */
  signature: string;
}

export interface VoteAuthorizationSigner {
  /** Ed25519 public key as a G-address, 0x-hex or base64 string. */
  publicKey: string;
  sign: (digest: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}

export type DigestFn = (data: Uint8Array) => Promise<Uint8Array>;

function canonicalField(value: string): string {
  return `${new TextEncoder().encode(value).length}:${value}`;
}

/** Length-prefixed, domain-separated encoding shared with the backend. */
export function canonicalVoteAuthPayload(
  auth: VoteAuthorizationFields,
): string {
  const choice =
    typeof auth.choice === "boolean" ? (auth.choice ? 1 : 0) : auth.choice;
  return [
    "zkvote-vote-auth-canonical-v1",
    canonicalField(VOTE_AUTH_DOMAIN),
    canonicalField(String(auth.version)),
    canonicalField(auth.domain),
    canonicalField(auth.chainId),
    canonicalField(String(auth.daoId)),
    canonicalField(String(auth.proposalId)),
    canonicalField(auth.voter),
    canonicalField(auth.commitment ? auth.commitment.toLowerCase() : ""),
    canonicalField(auth.nullifier.toLowerCase()),
    canonicalField(String(choice)),
    canonicalField(auth.relayer),
    canonicalField(String(auth.expiry)),
    canonicalField(auth.nonce),
    canonicalField(auth.signerPublicKey),
  ].join("|");
}

function decodePublicKey(encoded: string): Uint8Array {
  if (encoded.startsWith("G") && encoded.length >= 50) {
    return StrKey.decodeEd25519PublicKey(encoded);
  }
  const hex = encoded.startsWith("0x") ? encoded.slice(2) : encoded;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  return Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
}

const webDigest: DigestFn = async (data) =>
  new Uint8Array(
    await globalThis.crypto.subtle.digest(
      "SHA-256",
      data as unknown as ArrayBuffer,
    ),
  );

/** Build and sign a vote authorization with an injected wallet signer. */
export async function authorizeVote(
  fields: VoteAuthorizationFields,
  signer: VoteAuthorizationSigner,
  digest: DigestFn = webDigest,
): Promise<VoteAuthorization> {
  const complete: VoteAuthorizationFields = {
    ...fields,
    version: VOTE_AUTH_VERSION,
    domain: VOTE_AUTH_DOMAIN,
    signerPublicKey: signer.publicKey,
  };
  // Reject a mis-bound key early instead of letting the relayer pay to verify
  // a signature that can never match the advertised signer.
  if (decodePublicKey(signer.publicKey).length !== 32) {
    throw new Error("signerPublicKey must be a 32-byte Ed25519 key");
  }
  const payload = new TextEncoder().encode(canonicalVoteAuthPayload(complete));
  const digestBytes = await digest(payload);
  const signature = await signer.sign(digestBytes);
  if (signature.length !== nacl.sign.signatureLength) {
    throw new Error("Vote authorization signature must be 64 bytes");
  }
  return {
    ...complete,
    signature: btoa(String.fromCharCode(...signature)),
  };
}

/** Convenience signer for wallets that expose a deterministic Ed25519 seed. */
export function seedVoteSigner(seed: Uint8Array): VoteAuthorizationSigner {
  const keypair = nacl.sign.keyPair.fromSeed(seed);
  return {
    publicKey: StrKey.encodeEd25519PublicKey(keypair.publicKey),
    sign: (digest) => nacl.sign.detached(digest, keypair.secretKey),
  };
}

export interface SponsorshipQuota {
  limitStroops: number;
  remainingStroops: number;
  resetSeconds: number;
}

export interface RateLimitQuota {
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export interface SponsoredVoteResult {
  ok: boolean;
  txHash?: string;
  innerTxHash?: string;
  feeStroops?: number;
  /** True when a valid authorization was accepted but the relayer is low. */
  degraded: boolean;
  code?: string;
  error?: string;
  /** Seconds to wait before retrying (rate limit, budget or reserve). */
  retryAfterSeconds?: number;
  sponsorship?: SponsorshipQuota;
  rateLimit?: RateLimitQuota;
}

export interface SponsoredVoteClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  chainId?: string;
}

/**
 * Small typed client for POST /pay/vote. Reads the sponsorship/rate-limit
 * headers and converts graceful-degradation responses (503 reserve low, 429
 * quota exhausted) into structured results instead of throwing.
 */
export class SponsoredVoteClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly chainId: string;

  constructor(options: SponsoredVoteClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? RELAYER_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.chainId = options.chainId ?? NETWORK_CONFIG.networkPassphrase;
  }

  private static intHeader(headers: Headers, name: string): number | undefined {
    const raw = headers.get(name);
    if (raw === null) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private static quotas(headers: Headers): {
    sponsorship?: SponsorshipQuota;
    rateLimit?: RateLimitQuota;
  } {
    const limit = SponsoredVoteClient.intHeader(
      headers,
      "X-Sponsorship-Limit",
    );
    const remaining = SponsoredVoteClient.intHeader(
      headers,
      "X-Sponsorship-Remaining",
    );
    const reset = SponsoredVoteClient.intHeader(headers, "X-Sponsorship-Reset");
    const rateLimit = SponsoredVoteClient.intHeader(headers, "X-RateLimit-Limit");
    const rateRemaining = SponsoredVoteClient.intHeader(
      headers,
      "X-RateLimit-Remaining",
    );
    const rateReset = SponsoredVoteClient.intHeader(headers, "X-RateLimit-Reset");
    return {
      sponsorship:
        limit !== undefined && remaining !== undefined && reset !== undefined
          ? { limitStroops: limit, remainingStroops: remaining, resetSeconds: reset }
          : undefined,
      rateLimit:
        rateLimit !== undefined &&
        rateRemaining !== undefined &&
        rateReset !== undefined
          ? { limit: rateLimit, remaining: rateRemaining, resetSeconds: rateReset }
          : undefined,
    };
  }

  async submit(
    fields: Omit<VoteAuthorizationFields, "version" | "domain" | "chainId">,
    signer: VoteAuthorizationSigner,
    digest?: DigestFn,
  ): Promise<SponsoredVoteResult> {
    const auth = await authorizeVote(
      { ...fields, version: VOTE_AUTH_VERSION, domain: VOTE_AUTH_DOMAIN, chainId: this.chainId },
      signer,
      digest,
    );
    const res = await this.fetchImpl(`${this.baseUrl}/pay/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(auth),
    });
    const { sponsorship, rateLimit } = SponsoredVoteClient.quotas(res.headers);
    const retryAfter = Number(res.headers.get("Retry-After"));
    const retryAfterSeconds = Number.isFinite(retryAfter) ? retryAfter : undefined;
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (!res.ok) {
      return {
        ok: false,
        degraded: res.status === 503 || res.status === 429,
        code: typeof body.code === "string" ? body.code : undefined,
        error: typeof body.error === "string" ? body.error : `HTTP ${res.status}`,
        retryAfterSeconds,
        sponsorship,
        rateLimit,
      };
    }

    return {
      ok: true,
      degraded: false,
      txHash: typeof body.txHash === "string" ? body.txHash : undefined,
      innerTxHash:
        typeof body.innerTxHash === "string" ? body.innerTxHash : undefined,
      feeStroops:
        typeof body.feeStroops === "number" ? body.feeStroops : undefined,
      sponsorship,
      rateLimit,
    };
  }
}

export function getSponsoredVoteClient(
  options?: SponsoredVoteClientOptions,
): SponsoredVoteClient {
  return new SponsoredVoteClient(options);
}
