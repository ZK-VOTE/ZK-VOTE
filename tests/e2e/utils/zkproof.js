/**
 * ZK Proof utilities for e2e tests
 */

import fs from 'node:fs';
import path from 'node:path';
import { getCircuitsPath } from '../config.js';

// These will be lazily loaded
let poseidon = null;
let snarkjs = null;

/**
 * Initialize Poseidon hasher
 */
export async function initPoseidon() {
  if (!poseidon) {
    const circomlibjs = await import('circomlibjs');
    poseidon = await circomlibjs.buildPoseidon();
  }
  return poseidon;
}

/**
 * Initialize snarkjs
 */
export async function initSnarkjs() {
  if (!snarkjs) {
    snarkjs = await import('snarkjs');
  }
  return snarkjs;
}

/**
 * Generate random field element (< BN254 scalar field)
 */
export function randomFieldElement() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // Ensure it's less than the field modulus by zeroing top bits
  bytes[0] &= 0x1f;
  return BigInt('0x' + Buffer.from(bytes).toString('hex'));
}

/**
 * Compute Poseidon hash
 */
export async function poseidonHash(inputs) {
  const p = await initPoseidon();
  const hash = p(inputs.map(x => BigInt(x)));
  return p.F.toString(hash);
}

/**
 * Compute commitment = Poseidon(secret, salt)
 */
export async function computeCommitment(secret, salt) {
  return poseidonHash([secret, salt]);
}

/**
 * Compute nullifier = Poseidon(secret, daoId, proposalId)
 */
export async function computeNullifier(secret, daoId, proposalId) {
  return poseidonHash([secret, daoId, proposalId]);
}

/**
 * Generate ZK credentials for voting
 */
export async function generateCredentials() {
  const secret = randomFieldElement();
  const salt = randomFieldElement();
  const commitment = await computeCommitment(secret, salt);

  return { secret, salt, commitment };
}

// Circuit expects exactly 18 levels
const TREE_DEPTH = 18;

// Pre-computed zero hashes for Poseidon (will be computed lazily)
let zeroHashes = null;

/**
 * Compute zero hashes for empty tree levels
 * These are H(0,0), H(H(0,0), H(0,0)), etc.
 */
async function getZeroHashes() {
  if (zeroHashes) return zeroHashes;

  const p = await initPoseidon();
  zeroHashes = [BigInt(0)];

  for (let i = 0; i < TREE_DEPTH; i++) {
    const h = p([zeroHashes[i], zeroHashes[i]]);
    zeroHashes.push(BigInt(p.F.toString(h)));
  }

  return zeroHashes;
}

/**
 * Parse siblings from contract output
 * The contract returns U256 values which may be in various formats
 * @param rawSiblings - Either an array of strings/numbers, or a string representation
 * @returns Array of string values
 */
function parseSiblings(rawSiblings) {
  // If it's already an array of strings/numbers, convert each to string
  if (Array.isArray(rawSiblings)) {
    return rawSiblings.map(s => {
      // Handle if it's already a string
      if (typeof s === 'string') {
        // Remove any quotes
        return s.replace(/"/g, '').trim();
      }
      // Handle BigInt-like values that may come as numbers
      return String(s);
    });
  }

  // If it's a string, try to parse it
  if (typeof rawSiblings === 'string') {
    const trimmed = rawSiblings.trim();

    // Try JSON parse first (handles ["val1", "val2", ...])
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map(s => String(s).replace(/"/g, '').trim());
      }
    } catch {
      // Not valid JSON, try other formats
    }

    // Handle comma-separated values: val1,val2,val3
    if (trimmed.includes(',')) {
      return trimmed
        .replace(/^\[|\]$/g, '') // Remove surrounding brackets if present
        .split(',')
        .map(s => s.replace(/"/g, '').trim())
        .filter(s => s.length > 0);
    }

    // Single value
    return [trimmed.replace(/"/g, '').trim()];
  }

  throw new Error(`Cannot parse siblings: ${typeof rawSiblings}`);
}

/**
 * Build Merkle proof for a commitment
 * @param leafIndex - Index of the leaf in the tree
 * @param contractOutput - Either siblings array, or tuple [siblings, indices] from contract
 * @returns {pathElements, pathIndices}
 */
export async function buildMerkleProof(leafIndex, contractOutput) {
  const zeros = await getZeroHashes();

  // Parse the contract output
  // Contract returns [[siblings], [indices]] as a JSON string
  let siblings;
  let contractIndices;

  if (typeof contractOutput === 'string') {
    try {
      const parsed = JSON.parse(contractOutput);
      // Check if it's a tuple [siblings, indices]
      if (Array.isArray(parsed) && parsed.length === 2 && Array.isArray(parsed[0]) && Array.isArray(parsed[1])) {
        siblings = parsed[0];
        contractIndices = parsed[1];
      } else if (Array.isArray(parsed)) {
        // Just an array of siblings
        siblings = parsed;
      } else {
        throw new Error('Unexpected format');
      }
    } catch {
      // Try to parse as comma-separated list
      siblings = parseSiblings(contractOutput);
    }
  } else if (Array.isArray(contractOutput)) {
    // Check if it's a tuple [siblings, indices]
    if (contractOutput.length === 2 && Array.isArray(contractOutput[0]) && Array.isArray(contractOutput[1])) {
      siblings = contractOutput[0];
      contractIndices = contractOutput[1];
    } else {
      siblings = contractOutput;
    }
  } else {
    throw new Error(`Cannot parse contract output: ${typeof contractOutput}`);
  }

  // Parse siblings to clean strings
  const parsedSiblings = parseSiblings(siblings);

  // Start with siblings from contract
  const pathElements = [...parsedSiblings];

  // Use contract indices if provided, otherwise compute from leafIndex
  let pathIndices;
  if (contractIndices && contractIndices.length === parsedSiblings.length) {
    pathIndices = contractIndices.map(i => Number(i));
  } else {
    pathIndices = [];
    let idx = leafIndex;
    for (let i = 0; i < parsedSiblings.length; i++) {
      pathIndices.push(idx & 1);
      idx = idx >> 1;
    }
  }

  // Pad to TREE_DEPTH with zero hashes
  while (pathElements.length < TREE_DEPTH) {
    const level = pathElements.length;
    pathElements.push(zeros[level].toString());
    pathIndices.push(0); // Left child (idx >> level is 0 for small indices)
  }

  return {
    pathElements,
    pathIndices,
  };
}

/**
 * Generate Groth16 proof for voting
 */
export async function generateVoteProof({
  secret,
  salt,
  commitment,
  root,
  nullifier,
  daoId,
  proposalId,
  voteChoice,
  pathElements,
  pathIndices,
}) {
  const snarky = await initSnarkjs();
  const circuitsPath = getCircuitsPath();

  const wasmPath = path.join(circuitsPath, 'vote.wasm');
  const zkeyPath = path.join(circuitsPath, 'vote_final.zkey');

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`Circuit WASM not found: ${wasmPath}`);
  }
  if (!fs.existsSync(zkeyPath)) {
    throw new Error(`Circuit zkey not found: ${zkeyPath}`);
  }

  const input = {
    // Public inputs
    root: root.toString(),
    nullifier: nullifier.toString(),
    daoId: daoId.toString(),
    proposalId: proposalId.toString(),
    voteChoice: voteChoice ? '1' : '0',
    // Private inputs
    secret: secret.toString(),
    salt: salt.toString(),
    pathElements: pathElements.map(x => x.toString()),
    pathIndices: pathIndices.map(x => x.toString()),
  };

  console.log('  Generating Groth16 proof...');
  const { proof, publicSignals } = await snarky.groth16.fullProve(input, wasmPath, zkeyPath);
  console.log('  Proof generated');

  // Verify locally
  const vkeyPath = path.join(circuitsPath, 'verification_key.json');
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, 'utf-8'));
  const valid = await snarky.groth16.verify(vkey, publicSignals, proof);

  if (!valid) {
    throw new Error('Generated proof failed local verification');
  }

  return { proof, publicSignals };
}

/**
 * Convert snarkjs proof to Soroban format
 */
export function proofToSoroban(proof) {
  // Helper to convert field element to big-endian hex
  const toHexBE = (value) => {
    const bigInt = BigInt(value);
    return bigInt.toString(16).padStart(64, '0');
  };

  // G1 point: X || Y (64 bytes each as BE)
  const encodeG1 = (point) => {
    return toHexBE(point[0]) + toHexBE(point[1]);
  };

  // G2 point: X_c1 || X_c0 || Y_c1 || Y_c0 (swap within pairs)
  const encodeG2 = (point) => {
    return toHexBE(point[0][1]) + toHexBE(point[0][0]) +
           toHexBE(point[1][1]) + toHexBE(point[1][0]);
  };

  return {
    a: encodeG1(proof.pi_a),
    b: encodeG2(proof.pi_b),
    c: encodeG1(proof.pi_c),
  };
}

export default {
  initPoseidon,
  initSnarkjs,
  randomFieldElement,
  poseidonHash,
  computeCommitment,
  computeNullifier,
  generateCredentials,
  buildMerkleProof,
  generateVoteProof,
  proofToSoroban,
};
