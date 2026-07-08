import { Buffer } from "buffer";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
} from "@stellar/stellar-sdk/contract";
import type { u32, u64, u256 } from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";
export declare const networks: {
  readonly testnet: {
    readonly networkPassphrase: "Test SDF Network ; September 2015";
    readonly contractId: "CCYGWEUNWOBHJ6JIHDMTK2XSSDVMQ7ZGBJQE6QR2VYD4FRQGZR5EYKJ2";
  };
};
export type DataKey =
  | {
      tag: "Proposal";
      values: readonly [u64, u64];
    }
  | {
      tag: "ProposalCount";
      values: readonly [u64];
    }
  | {
      tag: "Nullifier";
      values: readonly [u64, u64, u256];
    }
  | {
      tag: "VotingKey";
      values: readonly [u64];
    }
  | {
      tag: "VkVersion";
      values: readonly [u64];
    }
  | {
      tag: "VkByVersion";
      values: readonly [u64, u32];
    }
  | {
      tag: "VerifyOverride";
      values: void;
    };
export type VoteMode =
  | {
      tag: "Fixed";
      values: void;
    }
  | {
      tag: "Trailing";
      values: void;
    };
export declare const VotingError: {
  1: {
    message: string;
  };
  19: {
    message: string;
  };
  2: {
    message: string;
  };
  3: {
    message: string;
  };
  4: {
    message: string;
  };
  5: {
    message: string;
  };
  6: {
    message: string;
  };
  7: {
    message: string;
  };
  8: {
    message: string;
  };
  9: {
    message: string;
  };
  10: {
    message: string;
  };
  11: {
    message: string;
  };
  12: {
    message: string;
  };
  13: {
    message: string;
  };
  14: {
    message: string;
  };
  15: {
    message: string;
  };
  16: {
    message: string;
  };
  17: {
    message: string;
  };
  18: {
    message: string;
  };
  20: {
    message: string;
  };
  21: {
    message: string;
  };
  /**
   * Only DAO admin can create proposals (members_can_propose = false)
   */
  22: {
    message: string;
  };
  /**
   * G1 point not on BN254 curve (y² ≠ x³ + 3)
   */
  23: {
    message: string;
  };
  /**
   * Root predates member removal (invalid for Trailing mode after revocation)
   */
  24: {
    message: string;
  };
  /**
   * Public signal value >= BN254 scalar field modulus (invalid field element)
   */
  25: {
    message: string;
  };
  /**
   * Nullifier is zero (invalid)
   */
  26: {
    message: string;
  };
};
export interface ProposalInfo {
  content_cid: string;
  created_at: u64;
  created_by: string;
  dao_id: u64;
  earliest_root_index: u32;
  eligible_root: u256;
  end_time: u64;
  id: u64;
  no_votes: u64;
  state: ProposalState;
  title: string;
  vk_hash: Buffer;
  vk_version: u32;
  vote_mode: VoteMode;
  yes_votes: u64;
}
export type ProposalState =
  | {
      tag: "Active";
      values: void;
    }
  | {
      tag: "Closed";
      values: void;
    }
  | {
      tag: "Archived";
      values: void;
    };
/**
 * Groth16 Proof
 */
export interface Proof {
  a: Buffer;
  b: Buffer;
  c: Buffer;
}
export declare const Groth16Error: {
  /**
   * IC vector length doesn't match public signals + 1
   */
  30: {
    message: string;
  };
  /**
   * Public signal value >= BN254 scalar field modulus (invalid field element)
   */
  31: {
    message: string;
  };
  /**
   * Nullifier is zero (invalid)
   */
  32: {
    message: string;
  };
};
/**
 * Groth16 Verification Key for BN254
 */
export interface VerificationKey {
  alpha: Buffer;
  beta: Buffer;
  delta: Buffer;
  gamma: Buffer;
  ic: Array<Buffer>;
}
export interface Client {
  /**
   * Construct and simulate a vote transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Submit a vote with ZK proof
   * Privacy-preserving: commitment is NOT a public parameter
   * Revocation is enforced by zeroing leaves in the Merkle tree
   */
  vote: (
    {
      dao_id,
      proposal_id,
      vote_choice,
      nullifier,
      root,
      proof,
    }: {
      dao_id: u64;
      proposal_id: u64;
      vote_choice: boolean;
      nullifier: u256;
      root: u256;
      proof: Proof;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a get_vk transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get the current VK for a DAO (used by other contracts like comments)
   */
  get_vk: (
    {
      dao_id,
    }: {
      dao_id: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<VerificationKey>>;
  /**
   * Construct and simulate a set_vk transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set verification key for a DAO (admin only)
   */
  set_vk: (
    {
      dao_id,
      vk,
      admin,
    }: {
      dao_id: u64;
      vk: VerificationKey;
      admin: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Contract version for upgrade tracking.
   */
  version: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>;
  /**
   * Construct and simulate a registry transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get registry contract address (cached at construction)
   */
  registry: (options?: MethodOptions) => Promise<AssembledTransaction<string>>;
  /**
   * Construct and simulate a vk_version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get current VK version for a DAO
   */
  vk_version: (
    {
      dao_id,
    }: {
      dao_id: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u32>>;
  /**
   * Construct and simulate a get_results transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get results for a proposal (yes_votes, no_votes)
   */
  get_results: (
    {
      dao_id,
      proposal_id,
    }: {
      dao_id: u64;
      proposal_id: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<readonly [u64, u64]>>;
  /**
   * Construct and simulate a get_proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get proposal info
   */
  get_proposal: (
    {
      dao_id,
      proposal_id,
    }: {
      dao_id: u64;
      proposal_id: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<ProposalInfo>>;
  /**
   * Construct and simulate a get_vote_mode transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get vote mode for a proposal
   * Returns VoteMode enum directly for type safety
   * Used by comments contract for eligibility checks
   */
  get_vote_mode: (
    {
      dao_id,
      proposal_id,
    }: {
      dao_id: u64;
      proposal_id: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<VoteMode>>;
  /**
   * Construct and simulate a tree_contract transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get tree contract address
   */
  tree_contract: (
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<string>>;
  /**
   * Construct and simulate a close_proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Close a proposal explicitly (idempotent). End time still enforced in vote.
   */
  close_proposal: (
    {
      dao_id,
      proposal_id,
      admin,
    }: {
      dao_id: u64;
      proposal_id: u64;
      admin: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a proposal_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get proposal count for a DAO
   */
  proposal_count: (
    {
      dao_id,
    }: {
      dao_id: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u64>>;
  /**
   * Construct and simulate a vk_for_version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get a specific VK version for observability/off-chain verification
   */
  vk_for_version: (
    {
      dao_id,
      version,
    }: {
      dao_id: u64;
      version: u32;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<VerificationKey>>;
  /**
   * Construct and simulate a create_proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Create a new proposal for a DAO
   * Voting starts immediately upon creation (Merkle root snapshot taken now)
   * title: Short display title (max 100 bytes)
   * content_cid: IPFS CID pointing to rich content (or legacy plain text description)
   * end_time: Unix timestamp for when voting closes (must be in the future, or 0 for no deadline)
   */
  create_proposal: (
    {
      dao_id,
      title,
      content_cid,
      end_time,
      creator,
      vote_mode,
    }: {
      dao_id: u64;
      title: string;
      content_cid: string;
      end_time: u64;
      creator: string;
      vote_mode: VoteMode;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u64>>;
  /**
   * Construct and simulate a archive_proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Archive a proposal (idempotent). Prevents further votes and signals off-chain cleanup.
   */
  archive_proposal: (
    {
      dao_id,
      proposal_id,
      admin,
    }: {
      dao_id: u64;
      proposal_id: u64;
      admin: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a get_earliest_idx transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get earliest root index for a proposal (for Trailing mode)
   * Used by comments contract for Trailing mode eligibility checks
   */
  get_earliest_idx: (
    {
      dao_id,
      proposal_id,
    }: {
      dao_id: u64;
      proposal_id: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u32>>;
  /**
   * Construct and simulate a get_eligible_root transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get eligible root for a proposal (merkle root at snapshot)
   * Used by comments contract for Fixed mode eligibility checks
   */
  get_eligible_root: (
    {
      dao_id,
      proposal_id,
    }: {
      dao_id: u64;
      proposal_id: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u256>>;
  /**
   * Construct and simulate a is_nullifier_used transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Check if nullifier has been used
   */
  is_nullifier_used: (
    {
      dao_id,
      proposal_id,
      nullifier,
    }: {
      dao_id: u64;
      proposal_id: u64;
      nullifier: u256;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<boolean>>;
  /**
   * Construct and simulate a set_vk_from_registry transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set verification key from registry during DAO initialization
   * This function is called by the registry contract during create_and_init_dao
   * to avoid re-entrancy issues. The registry is a trusted system contract.
   */
  set_vk_from_registry: (
    {
      dao_id,
      vk,
    }: {
      dao_id: u64;
      vk: VerificationKey;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a create_proposal_with_vk_version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Create proposal with a specific VK version (must be <= current and exist)
   */
  create_proposal_with_vk_version: (
    {
      dao_id,
      title,
      content_cid,
      end_time,
      creator,
      vote_mode,
      vk_version,
    }: {
      dao_id: u64;
      title: string;
      content_cid: string;
      end_time: u64;
      creator: string;
      vote_mode: VoteMode;
      vk_version: u32;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u64>>;
}
export declare class Client extends ContractClient {
  readonly options: ContractClientOptions;
  static deploy<T = Client>(
    /** Constructor/Initialization Args for the contract's `__constructor` method */
    {
      tree_contract,
      registry,
    }: {
      tree_contract: string;
      registry: string;
    },
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      },
  ): Promise<AssembledTransaction<T>>;
  constructor(options: ContractClientOptions);
  readonly fromJSON: {
    vote: (json: string) => AssembledTransaction<null>;
    get_vk: (json: string) => AssembledTransaction<VerificationKey>;
    set_vk: (json: string) => AssembledTransaction<null>;
    version: (json: string) => AssembledTransaction<number>;
    registry: (json: string) => AssembledTransaction<string>;
    vk_version: (json: string) => AssembledTransaction<number>;
    get_results: (
      json: string,
    ) => AssembledTransaction<readonly [bigint, bigint]>;
    get_proposal: (json: string) => AssembledTransaction<ProposalInfo>;
    get_vote_mode: (json: string) => AssembledTransaction<VoteMode>;
    tree_contract: (json: string) => AssembledTransaction<string>;
    close_proposal: (json: string) => AssembledTransaction<null>;
    proposal_count: (json: string) => AssembledTransaction<bigint>;
    vk_for_version: (json: string) => AssembledTransaction<VerificationKey>;
    create_proposal: (json: string) => AssembledTransaction<bigint>;
    archive_proposal: (json: string) => AssembledTransaction<null>;
    get_earliest_idx: (json: string) => AssembledTransaction<number>;
    get_eligible_root: (json: string) => AssembledTransaction<bigint>;
    is_nullifier_used: (json: string) => AssembledTransaction<boolean>;
    set_vk_from_registry: (json: string) => AssembledTransaction<null>;
    create_proposal_with_vk_version: (
      json: string,
    ) => AssembledTransaction<bigint>;
  };
}
