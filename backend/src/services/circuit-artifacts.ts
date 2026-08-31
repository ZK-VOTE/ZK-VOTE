/**
 * Depth-aware circuit artifact resolution (#93).
 *
 * `component main` fixes the Merkle depth at compile time, so each supported
 * depth is a separate compiled circuit living in its own build directory. A
 * proof for a depth-N election is a proof for `Vote(N)` and only verifies
 * against the verification key registered for depth N — picking the wrong
 * artifact produces a proof that is valid for the wrong circuit and is
 * rejected on-chain. This module is the single place that maps a depth to the
 * files that belong to it.
 *
 * The depth set and the default depth mirror
 * `circuits/utils/gen_depth_circuits.js`; the parity test keeps them honest.
 */

import fs from "fs";
import path from "path";
import * as StellarSdk from "@stellar/stellar-sdk";

import { config } from "../config.js";
import { logger } from "./logger.js";
import { server, relayerKeypair, callWithTimeout } from "./stellar.js";

/**
 * The depth `vote.circom` itself instantiates. Elections at this depth use the
 * DAO's version-pinned verification key and the unsuffixed build outputs, which
 * is why the contract encodes it as `merkle_depth == 0` rather than `18`.
 */
export const DEFAULT_CIRCUIT_DEPTH = 18;

/** Depths compiled as `vote_d<N>.circom` wrappers alongside the default. */
export const GENERATED_DEPTHS = [10, 15, 20, 25] as const;

/** Every depth the protocol accepts, including the default circuit. */
export const SUPPORTED_DEPTHS: readonly number[] = [
  ...GENERATED_DEPTHS,
  DEFAULT_CIRCUIT_DEPTH,
].sort((a, b) => a - b);

/** Mirrors `MAX_MERKLE_DEPTH` in the voting contract. */
export const MAX_MERKLE_DEPTH = 32;
export const MIN_MERKLE_DEPTH = 1;

export interface CircuitArtifacts {
  /** The real tree depth, with the contract's `0` sentinel already resolved. */
  depth: number;
  /** True when this is `vote.circom` rather than a generated depth wrapper. */
  isDefault: boolean;
  wasmPath: string;
  zkeyPath: string;
  vkeyPath: string;
  r1csPath: string;
}

/**
 * Root of the compiled circuit tree. Overridable so a deployment can point at
 * artifacts shipped outside the repo checkout.
 */
export function circuitsBuildDir(): string {
  const override = process.env.CIRCUITS_BUILD_DIR;
  if (override) return path.resolve(override);
  return path.resolve(process.cwd(), "..", "circuits", "build");
}

/**
 * Resolves the contract's `merkle_depth` field to a real tree depth.
 *
 * The contract stores `0` for "this election uses the default circuit", so that
 * existing elections — written before depths existed — keep verifying against
 * the key they were created with. Callers that need a depth to index artifacts
 * with must go through here rather than trusting the raw field.
 */
export function resolveDepth(merkleDepth: number): number {
  if (!Number.isInteger(merkleDepth) || merkleDepth < 0) {
    throw new Error(`merkle_depth must be a non-negative integer, got ${merkleDepth}`);
  }
  if (merkleDepth === 0) return DEFAULT_CIRCUIT_DEPTH;
  if (merkleDepth > MAX_MERKLE_DEPTH) {
    throw new Error(
      `merkle_depth ${merkleDepth} exceeds the maximum of ${MAX_MERKLE_DEPTH}`,
    );
  }
  return merkleDepth;
}

/**
 * Maps a depth to its compiled artifacts.
 *
 * Accepts the contract's `0` sentinel as well as a real depth. Throws for a
 * depth that is inside the contract's accepted range but has no compiled
 * circuit: that combination means the election was configured against a depth
 * this deployment cannot prove for, and silently falling back to the default
 * circuit would produce proofs that fail on-chain for no stated reason.
 */
export function resolveArtifacts(merkleDepth: number): CircuitArtifacts {
  const depth = resolveDepth(merkleDepth);
  const base = circuitsBuildDir();

  if (depth === DEFAULT_CIRCUIT_DEPTH) {
    return {
      depth,
      isDefault: true,
      wasmPath: path.join(base, "vote_js", "vote.wasm"),
      zkeyPath: path.join(base, "vote_final.zkey"),
      vkeyPath: path.join(base, "verification_key.json"),
      r1csPath: path.join(base, "vote.r1cs"),
    };
  }

  if (!SUPPORTED_DEPTHS.includes(depth)) {
    throw new Error(
      `no circuit compiled for Merkle depth ${depth} ` +
        `(compiled depths: ${SUPPORTED_DEPTHS.join(", ")})`,
    );
  }

  const dir = path.join(base, `depth_${depth}`);
  const name = `vote_d${depth}`;
  return {
    depth,
    isDefault: false,
    wasmPath: path.join(dir, `${name}_js`, `${name}.wasm`),
    zkeyPath: path.join(dir, `${name}_final.zkey`),
    vkeyPath: path.join(dir, "verification_key.json"),
    r1csPath: path.join(dir, `${name}.r1cs`),
  };
}

/** Which of an election's artifacts are actually present on disk. */
export function missingArtifacts(artifacts: CircuitArtifacts): string[] {
  return [artifacts.wasmPath, artifacts.zkeyPath, artifacts.vkeyPath].filter(
    (p) => !fs.existsSync(p),
  );
}

const depthCache = new Map<string, { depth: number; fetchedAt: number }>();
const DEPTH_TTL_MS = 60_000;

export function invalidateDepthCache(daoId?: number, proposalId?: number): void {
  if (daoId === undefined || proposalId === undefined) depthCache.clear();
  else depthCache.delete(`${daoId}:${proposalId}`);
}

/**
 * Reads an election's declared Merkle depth from the voting contract.
 *
 * Returns the raw contract value (`0` meaning the default circuit) so callers
 * can distinguish "default" from "explicitly depth 18"; pass it through
 * {@link resolveDepth} or {@link resolveArtifacts} to get a usable depth.
 * Returns `null` when the depth cannot be read, so a caller can fall back
 * rather than treat an RPC failure as "default depth".
 */
export async function getProposalMerkleDepth(
  daoId: number,
  proposalId: number,
): Promise<number | null> {
  const key = `${daoId}:${proposalId}`;
  const cached = depthCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < DEPTH_TTL_MS) {
    return cached.depth;
  }

  const contractId = config.votingContractId;
  if (!contractId) {
    logger.error("voting_contract_not_configured");
    return null;
  }

  try {
    const rpcServer = server as StellarSdk.rpc.Server;
    const account = await rpcServer.getAccount(relayerKeypair.publicKey());
    const contract = new StellarSdk.Contract(contractId);

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100000",
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "get_merkle_depth",
          StellarSdk.nativeToScVal(daoId, { type: "u64" }),
          StellarSdk.nativeToScVal(proposalId, { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();

    const result = await callWithTimeout(
      () => rpcServer.simulateTransaction(tx),
      "get_merkle_depth",
    );

    if (StellarSdk.rpc.Api.isSimulationError(result)) {
      logger.error("merkle_depth_sim_error", { daoId, proposalId });
      return null;
    }

    const retval = (
      result as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse
    ).result?.retval;
    if (!retval) return null;

    const depth = Number(retval.u32() ?? 0);
    depthCache.set(key, { depth, fetchedAt: Date.now() });
    return depth;
  } catch (error) {
    logger.error("merkle_depth_fetch_failed", {
      daoId,
      proposalId,
      error: (error as Error).message,
    });
    return null;
  }
}

/**
 * Resolves the artifacts an election's proofs must be generated against,
 * falling back to the default circuit when the depth cannot be read.
 */
export async function resolveArtifactsForProposal(
  daoId: number,
  proposalId: number,
): Promise<CircuitArtifacts> {
  const depth = await getProposalMerkleDepth(daoId, proposalId);
  return resolveArtifacts(depth ?? 0);
}
