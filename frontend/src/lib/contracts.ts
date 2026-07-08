// Contract client initialization using generated TypeScript bindings
import { Client as DaoRegistryClient } from "../contracts/dao-registry/dist/index.js";
import { Client as MembershipSbtClient } from "../contracts/membership-sbt/dist/index.js";
import { Client as MembershipTreeClient } from "../contracts/membership-tree/dist/index.js";
import { Client as VotingClient } from "../contracts/voting/dist/index.js";
import { Client as CommentsClient } from "../contracts/comments/dist/index.js";
import { NETWORK_CONFIG, CONTRACTS } from "../config/contracts";

export interface ContractClients {
  daoRegistry: DaoRegistryClient;
  membershipSbt: MembershipSbtClient;
  membershipTree: MembershipTreeClient;
  voting: VotingClient;
  comments: CommentsClient;
}

/**
 * Initialize contract clients for a given public key
 * @param publicKey User's public key (Stellar address)
 * @returns Initialized contract clients
 */
export function initializeContractClients(publicKey: string): ContractClients {
  const clientOptions = {
    publicKey,
    networkPassphrase: NETWORK_CONFIG.networkPassphrase,
    rpcUrl: NETWORK_CONFIG.rpcUrl,
    allowHttp: true, // Required for local development
  };

  return {
    daoRegistry: new DaoRegistryClient({
      ...clientOptions,
      contractId: CONTRACTS.REGISTRY_ID,
    }),
    membershipSbt: new MembershipSbtClient({
      ...clientOptions,
      contractId: CONTRACTS.SBT_ID,
    }),
    membershipTree: new MembershipTreeClient({
      ...clientOptions,
      contractId: CONTRACTS.TREE_ID,
    }),
    voting: new VotingClient({
      ...clientOptions,
      contractId: CONTRACTS.VOTING_ID,
    }),
    comments: new CommentsClient({
      ...clientOptions,
      contractId: CONTRACTS.COMMENTS_ID,
    }),
  };
}
