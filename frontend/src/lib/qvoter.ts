// ZK Quadratic Voting proof generation (issue #50)
//
// Builds the witness for `circuits/quadratic_vote.circom` and produces a Groth16
// proof with snarkjs. A single proof lets a member allocate voice credits across
// several proposals under a quadratic cost function while keeping the individual
// allocations private.
//
// Proof generation is slow (~2-5 minutes for a full ballot): the circuit runs a
// bit-decomposition range proof per allocation plus a Merkle-membership proof.

import { groth16 } from "snarkjs";
import type { CircuitSignals, Groth16Proof } from "snarkjs";
import { buildPoseidon } from "circomlibjs";

// Must match circuits/quadratic_vote_main.circom and the voting contract.
export const QV_MAX_BUDGET = 100;
export const QV_MAX_CREDITS = 10;
export const QV_NUM_ALLOCATIONS = 5; // circuit template parameter N

export interface QvAllocation {
  proposalId: string; // decimal string
  voiceCredits: number;
}

export interface QvProposalCost {
  proposalId: string;
  voiceCredits: number;
  credits: number; // voiceCredits^2
}

export interface QvCostBreakdown {
  perProposal: QvProposalCost[];
  totalCreditsSpent: number;
  budget: number;
  remaining: number;
  withinBudget: boolean;
  withinRange: boolean;
}

/**
 * Quadratic cost of a set of allocations: sum(voiceCredits_i^2). Used to drive
 * the budget UI as sliders move (no proving required).
 */
export function calculateQuadraticCost(
  allocations: QvAllocation[],
  budget: number = QV_MAX_BUDGET,
  maxCredits: number = QV_MAX_CREDITS,
): QvCostBreakdown {
  const perProposal: QvProposalCost[] = allocations.map((a) => ({
    proposalId: a.proposalId,
    voiceCredits: a.voiceCredits,
    credits: a.voiceCredits * a.voiceCredits,
  }));
  const totalCreditsSpent = perProposal.reduce((s, p) => s + p.credits, 0);
  const withinRange = allocations.every(
    (a) => a.voiceCredits >= 0 && a.voiceCredits <= maxCredits,
  );
  return {
    perProposal,
    totalCreditsSpent,
    budget,
    remaining: budget - totalCreditsSpent,
    withinBudget: totalCreditsSpent <= budget,
    withinRange,
  };
}

// Cache the (expensive to build) Poseidon instance, reusing circomlibjs's types.
type Poseidon = Awaited<ReturnType<typeof buildPoseidon>>;
let poseidonPromise: Promise<Poseidon> | null = null;
async function getPoseidon(): Promise<Poseidon> {
  if (!poseidonPromise) {
    poseidonPromise = buildPoseidon();
  }
  return poseidonPromise;
}

/**
 * Nullifier = Poseidon(secret, daoId, proposalId). Domain-separated so a member
 * casts at most one quadratic ballot per round.
 */
export async function computeQvNullifier(
  secret: string,
  daoId: string,
  proposalId: string,
): Promise<string> {
  const poseidon = await getPoseidon();
  return poseidon.F.toString(
    poseidon([BigInt(secret), BigInt(daoId), BigInt(proposalId)]),
  );
}

/**
 * allocationsHash = Poseidon(vc_0, pid_0, vc_1, pid_1, ...) over the padded
 * allocation list. Binds the (hidden) allocations for later reveal + tally.
 */
export async function computeAllocationsHash(
  voiceCredits: number[],
  proposalIds: string[],
): Promise<string> {
  const poseidon = await getPoseidon();
  const flat: bigint[] = [];
  for (let i = 0; i < voiceCredits.length; i++) {
    flat.push(BigInt(voiceCredits[i]));
    flat.push(BigInt(proposalIds[i]));
  }
  return poseidon.F.toString(poseidon(flat));
}

export interface QvProofInput {
  secret: string;
  salt: string;
  root: string;
  daoId: string;
  proposalId: string;
  allocations: QvAllocation[];
  pathElements: string[];
  pathIndices: number[];
}

export interface GeneratedQvProof {
  proof: Groth16Proof;
  publicSignals: string[];
  nullifier: string;
  totalCreditsSpent: string;
  allocationsHash: string;
}

// Pad an allocation list to exactly QV_NUM_ALLOCATIONS entries with zero-credit,
// zero-proposal fillers (which contribute 0 to both cost and tally).
function padAllocations(
  allocations: QvAllocation[],
): { voiceCredits: number[]; proposalIds: string[] } {
  if (allocations.length > QV_NUM_ALLOCATIONS) {
    throw new Error(
      `Too many allocations: ${allocations.length} > ${QV_NUM_ALLOCATIONS}`,
    );
  }
  const voiceCredits: number[] = [];
  const proposalIds: string[] = [];
  for (let i = 0; i < QV_NUM_ALLOCATIONS; i++) {
    if (i < allocations.length) {
      voiceCredits.push(allocations[i].voiceCredits);
      proposalIds.push(allocations[i].proposalId);
    } else {
      voiceCredits.push(0);
      proposalIds.push("0");
    }
  }
  return { voiceCredits, proposalIds };
}

/**
 * Generate a Groth16 proof for a quadratic ballot.
 *
 * Validates the budget/range locally (the circuit enforces the same, but failing
 * fast avoids a multi-minute proving run on an invalid ballot), then builds the
 * witness and proves.
 */
export async function generateQuadraticVoteProof(
  input: QvProofInput,
  wasmPath = "/circuits/quadratic_vote/quadratic_vote.wasm",
  zkeyPath = "/circuits/quadratic_vote/quadratic_vote_final.zkey",
): Promise<GeneratedQvProof> {
  const cost = calculateQuadraticCost(input.allocations);
  if (!cost.withinRange) {
    throw new Error(
      `Allocation out of range: each must be in [0, ${QV_MAX_CREDITS}]`,
    );
  }
  if (!cost.withinBudget) {
    throw new Error(
      `Over budget: ${cost.totalCreditsSpent} credits > ${QV_MAX_BUDGET}`,
    );
  }

  const { voiceCredits, proposalIds } = padAllocations(input.allocations);
  const totalCreditsSpent = voiceCredits.reduce((s, v) => s + v * v, 0);

  const nullifier = await computeQvNullifier(
    input.secret,
    input.daoId,
    input.proposalId,
  );
  const allocationsHash = await computeAllocationsHash(voiceCredits, proposalIds);

  const circuitInput: CircuitSignals = {
    root: input.root,
    daoId: input.daoId,
    proposalId: input.proposalId,
    nullifier,
    totalCreditsSpent: totalCreditsSpent.toString(),
    allocationsHash,
    secret: input.secret,
    salt: input.salt,
    pathElements: input.pathElements,
    pathIndices: input.pathIndices,
    voiceCredits: voiceCredits.map((v) => v.toString()),
    allocProposalIds: proposalIds,
  };

  try {
    const { proof, publicSignals } = await groth16.fullProve(
      circuitInput,
      wasmPath,
      zkeyPath,
    );
    return {
      proof,
      publicSignals,
      nullifier,
      totalCreditsSpent: totalCreditsSpent.toString(),
      allocationsHash,
    };
  } catch (error) {
    console.error("Failed to generate quadratic vote proof:", error);
    throw new Error(
      `Quadratic vote proof generation failed: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }
}
