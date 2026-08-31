// Merkle tree path computation for Poseidon tree
// Lazy load circomlibjs
import { initializeContractClients } from "./contracts";

const TREE_DEPTH = 18;

// Leaf domain-separation tag (#167): every leaf is hashed with this fixed
// tag before entering the tree — leafHash = Poseidon(LEAF_DOMAIN, leaf) —
// so a raw commitment is never inserted directly as a tree value. Internal
// nodes keep the plain Poseidon(left, right) they always used. Must match
// LEAF_DOMAIN in circuits/merkle_tree.circom and the on-chain tree in
// contracts/membership-tree (whose `hash_pair` only has parameters for the
// 2-input Poseidon width, so this scheme deliberately avoids needing a
// wider hash for internal nodes).
const LEAF_DOMAIN = 1n;

// Cache for zero hashes at each level. zeros[0] is the domain-tagged hash
// of the empty leaf (commitment = 0); zeros[i+1] is the internal-node hash
// of two zeros[i] children.
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
    const circomlibjs = await import("circomlibjs");
    poseidonCache = await circomlibjs.buildPoseidon();
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
  // zeros[0]: domain-tagged hash of the empty leaf (commitment 0).
  const zeros: string[] = [poseidon.F.toString(poseidon([LEAF_DOMAIN, 0n]))];

  for (let i = 0; i < TREE_DEPTH; i++) {
    const prev = BigInt(zeros[i]);
    const hash = poseidon.F.toString(poseidon([prev, prev]));
    zeros.push(hash);
  }

  zeroCache = zeros;
  return zeros;
}

/**
 * Domain-tags a raw leaf commitment the same way the circuit's
 * `leafHasher` does: Poseidon(LEAF_DOMAIN, commitment).
 */
async function hashLeaf(commitment: string): Promise<string> {
  const poseidon = await getPoseidon();
  return poseidon.F.toString(poseidon([LEAF_DOMAIN, BigInt(commitment)]));
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

  // Build tree level by level. Level 0 is the domain-tagged leaf hashes
  // (matching the circuit's `leafHasher`), not the raw commitments —
  // pathElements[0] must be a sibling's *hashed* leaf, since the circuit
  // compares against currentHash[0], which is already leaf-domain-tagged.
  let currentLevel = await Promise.all(leaves.map(hashLeaf));
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
  // Unified client
  const client = getZkVoteClient(publicKey);

  // Call the on-chain get_merkle_path function
  const result = await client.membershipTree.get_merkle_path({
    dao_id: BigInt(daoId),
    leaf_index: leafIndex,
  });

  // Contract returns (Vec<U256>, Vec<u32>)
  // Convert to string arrays for circuit input
  const pathElements = result.result[0].map((elem: bigint) => elem.toString());
  const pathIndices = result.result[1].map((idx: number) => idx);

  return { pathElements, pathIndices };
}
