/**
 * Off-chain Groth16 verification for bridge votes.
 *
 * Soroban `relay_vote` does not accept a proof — authenticity for the HTTP
 * bridge endpoint must be checked here before the relayer co-signs.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { config } from "../config.js";
import { log } from "./logger.js";
import { zkv1ToSnarkjs } from "../generated/zkv1.js";

const require = createRequire(import.meta.url);

export interface FlattenedGroth16Proof {
  a: string;
  b: string;
  c: string;
}

export interface BridgePublicInputs {
  sbtContractAddr: string;
  memberAddr: string;
  daoId: number;
  proposalId: number;
  nullifier: string;
  voteChoice: number;
  voteRoot: string;
  sbtRoot: string;
  /** EVM chain id — required public signal (#649) */
  chainId: string | number;
}

type SnarkjsProof = {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
};

let cachedVkey: Record<string, unknown> | null | undefined;

function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

function hexToDecString(hex: string): string {
  const cleaned = strip0x(hex);
  if (!cleaned || !/^[0-9a-fA-F]+$/.test(cleaned)) {
    throw new Error("invalid_hex");
  }
  return BigInt(`0x${cleaned}`).toString();
}

function fieldToSignal(value: string | number): string {
  if (typeof value === "number") {
    return BigInt(value).toString();
  }
  const cleaned = strip0x(value);
  if (/^[0-9]+$/.test(value)) {
    return BigInt(value).toString();
  }
  return hexToDecString(cleaned);
}

/**
 * Convert flattened Soroban/EVM-style a/b/c hex back to snarkjs proof shape.
 * Inverse of frontend `formatProofForSoroban` (G2 pairs stored as c1,c0).
 */
export function flattenedProofToSnarkjs(
  proof: FlattenedGroth16Proof,
): SnarkjsProof {
  const a = strip0x(proof.a);
  const b = strip0x(proof.b);
  const c = strip0x(proof.c);

  if (a.length !== 128 || b.length !== 256 || c.length !== 128) {
    throw new Error("invalid_proof_length");
  }

  // Reject all-zero proofs early (common forge vector)
  if (/^0+$/.test(a) && /^0+$/.test(b) && /^0+$/.test(c)) {
    throw new Error("zero_proof");
  }

  // Reverse conversion is performed by the same generated ZKV1 adapter used
  // by the SDK and frontend; no second hand-rolled c0/c1 swap remains here.
  return zkv1ToSnarkjs({
    a: proof.a,
    b: proof.b,
    c: proof.c,
  }) as SnarkjsProof;
}

export function buildBridgePublicSignals(inputs: BridgePublicInputs): string[] {
  return [
    fieldToSignal(inputs.sbtContractAddr),
    fieldToSignal(inputs.memberAddr),
    fieldToSignal(inputs.daoId),
    fieldToSignal(inputs.proposalId),
    fieldToSignal(inputs.nullifier),
    fieldToSignal(inputs.voteChoice),
    fieldToSignal(inputs.voteRoot),
    fieldToSignal(inputs.sbtRoot),
    fieldToSignal(inputs.chainId),
  ];
}

function resolveBridgeVkeyPath(): string {
  if (config.bridgeVkeyPath) {
    return config.bridgeVkeyPath;
  }
  return path.resolve(process.cwd(), "circuits/build/bridge_verification_key.json");
}

function loadBridgeVkey(): Record<string, unknown> | null {
  if (cachedVkey !== undefined) {
    return cachedVkey;
  }
  const vkeyPath = resolveBridgeVkeyPath();
  try {
    if (!fs.existsSync(vkeyPath)) {
      log("error", "bridge_vkey_missing", { path: vkeyPath });
      cachedVkey = null;
      return null;
    }
    cachedVkey = JSON.parse(fs.readFileSync(vkeyPath, "utf8")) as Record<
      string,
      unknown
    >;
    return cachedVkey;
  } catch (err) {
    log("error", "bridge_vkey_load_failed", {
      path: vkeyPath,
      error: (err as Error).message,
    });
    cachedVkey = null;
    return null;
  }
}

/** Test helper — clear cached VK between unit tests. */
export function resetBridgeVkeyCache(): void {
  cachedVkey = undefined;
}

/**
 * Verify a bridge Groth16 proof against the dedicated bridge verification key.
 * Returns true only when the proof is cryptographically valid for the signals.
 * Fail-closed: missing VK, malformed proof, or snarkjs errors all return false.
 */
export async function verifyBridgeProof(
  proof: FlattenedGroth16Proof,
  inputs: BridgePublicInputs,
): Promise<boolean> {
  try {
    const vkey = loadBridgeVkey();
    if (!vkey) {
      return false;
    }

    const snarkProof = flattenedProofToSnarkjs(proof);
    const publicSignals = buildBridgePublicSignals(inputs);

    // snarkjs is a runtime dependency; resolve lazily so import-time failures
    // surface as verification failure rather than crashing the process.
    const snarkjs = require("snarkjs") as {
      groth16: {
        verify: (
          vkey: unknown,
          publicSignals: string[],
          proof: SnarkjsProof,
        ) => Promise<boolean>;
      };
    };

    const ok = await snarkjs.groth16.verify(vkey, publicSignals, snarkProof);
    if (!ok) {
      log("warn", "bridge_proof_invalid", {
        daoId: inputs.daoId,
        proposalId: inputs.proposalId,
      });
    }
    return ok === true;
  } catch (err) {
    log("warn", "bridge_proof_verify_error", {
      daoId: inputs.daoId,
      proposalId: inputs.proposalId,
      error: (err as Error).message,
    });
    return false;
  }
}
