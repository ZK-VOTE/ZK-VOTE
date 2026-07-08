// Merkle tree path computation for Poseidon tree
import { buildPoseidon } from "circomlibjs";
import { initializeContractClients } from "./contracts";

const TREE_DEPTH = 18;

// Cache for zero hashes at each level
let zeroCache: string[] | null = null;

// Cache for the Poseidon hash function instance (expensive to initialize)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let poseidonCache: any = null;

/**
 * Get cached Poseidon instance (avoids re-initializing WASM on each call)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getPoseidon(): Promise<any> {
  if (!poseidonCache) {
    poseidonCache = await buildPoseidon();
  }
  return poseidonCache;
}

/**
 * Compute zero hash at each level of the tree
 * Zero hashes are: [0, H(0,0), H(H(0,0), H(0,0)), ...]
 */
async function getZeroHashes(): Promise<string[]> {
  if (zeroCache) return zeroCache;

  const poseidon = await getPoseidon();
  const zeros: string[] = ["0"];

  for (let i = 0; i < TREE_DEPTH; i++) {
    const prev = BigInt(zeros[i]);
    const hash = poseidon.F.toString(poseidon([prev, prev]));
    zeros.push(hash);
  }

  zeroCache = zeros;
  return zeros;
}

/**
 * Compute Merkle path for a leaf at given index
 * For a sparse tree (few leaves), most path elements will be zero hashes
 *
 * @param leafIndex Index of the leaf (0-based)
 * @param _totalLeaves Total number of leaves currently in tree
 * @param leaves All leaf values (commitments) in order
 * @returns Object with pathElements and pathIndices
 */
export async function computeMerklePath(
  leafIndex: number,
  _totalLeaves: number,
  leaves: string[],
): Promise<{ pathElements: string[]; pathIndices: number[] }> {
  const poseidon = await getPoseidon();
  const zeros = await getZeroHashes();

  const pathElements: string[] = [];
  const pathIndices: number[] = [];

  // Build tree level by level
  let currentLevel = [...leaves];
  let currentIndex = leafIndex;

  for (let level = 0; level < TREE_DEPTH; level++) {
    const isLeft = currentIndex % 2 === 0;
    pathIndices.push(isLeft ? 0 : 1);

    // Get sibling
    let sibling: string;
    if (isLeft) {
      // Right sibling
      const siblingIndex = currentIndex + 1;
      sibling =
        siblingIndex < currentLevel.length
          ? currentLevel[siblingIndex]
          : zeros[level];
    } else {
      // Left sibling
      const siblingIndex = currentIndex - 1;
      sibling = currentLevel[siblingIndex];
    }

    pathElements.push(sibling);

    // Compute next level
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right =
        i + 1 < currentLevel.length ? currentLevel[i + 1] : zeros[level];
      const hash = poseidon.F.toString(poseidon([BigInt(left), BigInt(right)]));
      nextLevel.push(hash);
    }

    // Pad next level to power of 2 if needed
    while (nextLevel.length < Math.ceil(currentLevel.length / 2)) {
      nextLevel.push(zeros[level + 1]);
    }

    currentLevel = nextLevel;
    currentIndex = Math.floor(currentIndex / 2);
  }

  return { pathElements, pathIndices };
}

/**
 * Simpler version: For the first leaf (index 0), path is all zeros on the right
 */
export async function getPathForFirstLeaf(): Promise<{
  pathElements: string[];
  pathIndices: number[];
}> {
  const zeros = await getZeroHashes();

  return {
    pathElements: zeros.slice(0, TREE_DEPTH),
    pathIndices: Array(TREE_DEPTH).fill(0), // Always left (0) for first leaf
  };
}

/**
 * Get path elements and indices for any leaf index from the on-chain Merkle tree
 * Queries the MembershipTree contract to get the correct sibling hashes
 *
 * @param leafIndex Index of the leaf in the tree
 * @param daoId DAO identifier
 * @param publicKey User's public key for contract client initialization
 * @returns Object with pathElements (sibling hashes) and pathIndices (0=left, 1=right)
 */
export async function getMerklePath(
  leafIndex: number,
  daoId: number,
  publicKey: string,
): Promise<{ pathElements: string[]; pathIndices: number[] }> {
  // Initialize contract clients
  const clients = initializeContractClients(publicKey);

  // Call the on-chain get_merkle_path function
  const result = await clients.membershipTree.get_merkle_path({
    dao_id: BigInt(daoId),
    leaf_index: leafIndex,
  });

  // Contract returns (Vec<U256>, Vec<u32>)
  // Convert to string arrays for circuit input
  const pathElements = result.result[0].map((elem: bigint) => elem.toString());
  const pathIndices = result.result[1].map((idx: number) => idx);

  return { pathElements, pathIndices };
}
