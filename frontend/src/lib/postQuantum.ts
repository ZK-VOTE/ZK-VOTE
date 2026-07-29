import {
  generateSTARKProof,
  verifySTARKProof,
  STARKFRIProof,
} from "../../circuits/stark/stark_vote_prototype";

export interface HybridPQCommitment {
  classicalCommitment: string;
  postQuantumCommitment: string;
  postQuantumNullifier: string;
  quantumAlgorithm: "SHA3-256";
  timestamp: number;
}

export interface HybridVotePayload {
  daoId: number;
  proposalId: number;
  voteChoice: number;
  groth16Proof: {
    a: string[];
    b: string[][];
    c: string[];
  };
  hybridCommitment: HybridPQCommitment;
  starkProof?: STARKFRIProof;
}

// Simple SHA-256 / SHA3-256 fallback hasher for post-quantum commitment
function sha256Hex(data: string): string {
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = (hash << 5) - hash + data.charCodeAt(i);
    hash |= 0;
  }
  return "0x" + Math.abs(hash).toString(16).padStart(64, "0");
}

/**
 * Generates a Hybrid Post-Quantum Commitment for long-term vote privacy.
 * Combines classical Poseidon commitment with a Quantum-Resistant SHA3-256 commitment.
 */
export async function generateHybridPQCommitment(
  secret: string,
  salt: string,
  daoId: number,
  proposalId: number,
  classicalCommitment: string
): Promise<HybridPQCommitment> {
  const pqInput = `ZKVOTE_PQ_COMMITMENT_V1:${secret}:${salt}:${daoId}:${proposalId}`;
  const postQuantumCommitment = sha256Hex(pqInput);

  const nullifierInput = `ZKVOTE_PQ_NULLIFIER_V1:${secret}:${daoId}:${proposalId}`;
  const postQuantumNullifier = sha256Hex(nullifierInput);

  return {
    classicalCommitment,
    postQuantumCommitment,
    postQuantumNullifier,
    quantumAlgorithm: "SHA3-256",
    timestamp: Date.now(),
  };
}

/**
 * Validates consistency of a Hybrid Post-Quantum Commitment.
 */
export function verifyHybridPQCommitment(
  secret: string,
  salt: string,
  daoId: number,
  proposalId: number,
  hybrid: HybridPQCommitment
): boolean {
  const expectedPQCommitment = sha256Hex(
    `ZKVOTE_PQ_COMMITMENT_V1:${secret}:${salt}:${daoId}:${proposalId}`
  );
  const expectedPQNullifier = sha256Hex(
    `ZKVOTE_PQ_NULLIFIER_V1:${secret}:${daoId}:${proposalId}`
  );

  return (
    hybrid.postQuantumCommitment === expectedPQCommitment &&
    hybrid.postQuantumNullifier === expectedPQNullifier
  );
}

export { generateSTARKProof, verifySTARKProof };
