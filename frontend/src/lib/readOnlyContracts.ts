import { Client as DaoRegistryClient } from "../contracts/dao-registry/dist/index.js";
import { Client as MembershipSbtClient } from "../contracts/membership-sbt/dist/index.js";
import { Client as MembershipTreeClient } from "../contracts/membership-tree/dist/index.js";
import { Client as VotingClient } from "../contracts/voting/dist/index.js";
import { NETWORK_CONFIG, CONTRACTS } from "../config/contracts";

// Create read-only contract clients (no wallet needed)
export function getReadOnlyDaoRegistry() {
  return new DaoRegistryClient({
    contractId: CONTRACTS.REGISTRY_ID,
    rpcUrl: NETWORK_CONFIG.rpcUrl,
    networkPassphrase: NETWORK_CONFIG.networkPassphrase,
    allowHttp: true,
  });
}

export function getReadOnlyMembershipSbt() {
  return new MembershipSbtClient({
    contractId: CONTRACTS.SBT_ID,
    rpcUrl: NETWORK_CONFIG.rpcUrl,
    networkPassphrase: NETWORK_CONFIG.networkPassphrase,
    allowHttp: true,
  });
}

export function getReadOnlyMembershipTree() {
  return new MembershipTreeClient({
    contractId: CONTRACTS.TREE_ID,
    rpcUrl: NETWORK_CONFIG.rpcUrl,
    networkPassphrase: NETWORK_CONFIG.networkPassphrase,
    allowHttp: true,
  });
}

export function getReadOnlyVoting() {
  return new VotingClient({
    contractId: CONTRACTS.VOTING_ID,
    rpcUrl: NETWORK_CONFIG.rpcUrl,
    networkPassphrase: NETWORK_CONFIG.networkPassphrase,
    allowHttp: true,
  });
}

// Helper function to get all DAOs
export async function getAllDaos(): Promise<
  Array<{
    id: number;
    name: string;
    creator: string;
    membership_open: boolean;
    metadata_cid?: string;
  }>
> {
  try {
    const registry = getReadOnlyDaoRegistry();

    // Get DAO count first
    const countResult = await registry.dao_count();
    const daoCount = Number(countResult.result);

    if (daoCount === 0) {
      return [];
    }

    // Fetch all DAOs
    const daos: Array<{
      id: number;
      name: string;
      creator: string;
      membership_open: boolean;
      metadata_cid?: string;
    }> = [];

    for (let i = 1; i <= daoCount; i++) {
      try {
        const daoResult = await registry.get_dao({ dao_id: BigInt(i) });
        const dao = daoResult.result;

        daos.push({
          id: i,
          name: dao.name,
          creator: dao.admin,
          membership_open: dao.membership_open,
          metadata_cid: dao.metadata_cid ?? undefined,
        });
      } catch (err) {
        console.warn(`Failed to fetch DAO ${i}:`, err);
        // Continue to next DAO even if one fails
      }
    }

    return daos;
  } catch (err) {
    console.error("Failed to fetch DAOs:", err);
    return [];
  }
}

// Helper function to get user's DAOs with their role
export async function getUserDaos(userAddress: string): Promise<
  Array<{
    id: number;
    name: string;
    creator: string;
    role: "admin" | "member";
    membership_open: boolean;
    metadata_cid?: string;
  }>
> {
  try {
    const registry = getReadOnlyDaoRegistry();
    const sbtClient = getReadOnlyMembershipSbt();

    // Get DAO count first
    const countResult = await registry.dao_count();
    const daoCount = Number(countResult.result);

    if (daoCount === 0) {
      return [];
    }

    // Fetch all DAOs and check user's role in each
    const userDaos: Array<{
      id: number;
      name: string;
      creator: string;
      role: "admin" | "member";
      membership_open: boolean;
      metadata_cid?: string;
    }> = [];

    for (let i = 1; i <= daoCount; i++) {
      try {
        const daoResult = await registry.get_dao({ dao_id: BigInt(i) });
        const dao = daoResult.result;

        // Check if user is admin
        const isAdmin = dao.admin === userAddress;

        // Check if user has SBT (is member)
        let isMember = false;
        try {
          const hasResult = await sbtClient.has({
            dao_id: BigInt(i),
            of: userAddress,
          });
          isMember = hasResult.result;
        } catch (err) {
          // If checking membership fails, assume not a member
          console.warn(`Failed to check membership for DAO ${i}:`, err);
        }

        // Add to user's DAOs if they are admin or member
        if (isAdmin || isMember) {
          userDaos.push({
            id: i,
            name: dao.name,
            creator: dao.admin,
            role: isAdmin ? "admin" : "member",
            membership_open: dao.membership_open,
            metadata_cid: dao.metadata_cid ?? undefined,
          });
        }
      } catch (err) {
        console.warn(`Failed to fetch DAO ${i}:`, err);
        // Continue to next DAO even if one fails
      }
    }

    return userDaos;
  } catch (err) {
    console.error("Failed to fetch user DAOs:", err);
    return [];
  }
}
