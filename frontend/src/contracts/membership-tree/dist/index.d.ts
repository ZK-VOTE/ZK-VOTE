import { Buffer } from "buffer";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
} from "@stellar/stellar-sdk/contract";
import type { u32, u64, u256, Option } from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";
export declare const networks: {
  readonly testnet: {
    readonly networkPassphrase: "Test SDF Network ; September 2015";
    readonly contractId: "CAZC3WSRGE3PI6AZ3NHRKIZFVBEOOLFDP7RD6BMHIMRYV4VEYC42ARQZ";
  };
};
export type DataKey =
  | {
      tag: "TreeDepth";
      values: readonly [u64];
    }
  | {
      tag: "NextLeafIndex";
      values: readonly [u64];
    }
  | {
      tag: "FilledSubtrees";
      values: readonly [u64];
    }
  | {
      tag: "Roots";
      values: readonly [u64];
    }
  | {
      tag: "LeafIndex";
      values: readonly [u64, u256];
    }
  | {
      tag: "MemberLeafIndex";
      values: readonly [u64, string];
    }
  | {
      tag: "LeafValue";
      values: readonly [u64, u32];
    }
  | {
      tag: "NextRootIndex";
      values: readonly [u64];
    }
  | {
      tag: "RootIndex";
      values: readonly [u64, u256];
    }
  | {
      tag: "RevokedAt";
      values: readonly [u64, u256];
    }
  | {
      tag: "ReinstatedAt";
      values: readonly [u64, u256];
    }
  | {
      tag: "NodeHash";
      values: readonly [u64, u32, u32];
    }
  | {
      tag: "MinValidRootIdx";
      values: readonly [u64];
    }
  | {
      tag: "LastRegistrationAt";
      values: readonly [u64, string];
    };
export declare const TreeError: {
  1: {
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
};
export interface Client {
  /**
   * Construct and simulate a root_ok transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Check if a root is valid (in history)
   */
  root_ok: (
    {
      dao_id,
      root,
    }: {
      dao_id: u64;
      root: u256;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<boolean>>;
  /**
   * Construct and simulate a version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Contract version for upgrade tracking.
   */
  version: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>;
  /**
   * Construct and simulate a curr_idx transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get current root index (for proposal creation)
   */
  curr_idx: (
    {
      dao_id,
    }: {
      dao_id: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u32>>;
  /**
   * Construct and simulate a get_root transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get current root (short alias for cross-contract calls)
   */
  get_root: (
    {
      dao_id,
    }: {
      dao_id: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u256>>;
  /**
   * Construct and simulate a min_root transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get the minimum valid root index for a DAO
   * Roots with index < min_valid_root_index are invalid for Trailing mode proposals
   * Returns 0 if no members have been removed
   */
  min_root: (
    {
      dao_id,
    }: {
      dao_id: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u32>>;
  /**
   * Construct and simulate a revok_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get revocation timestamp for a commitment (returns None if never revoked)
   * Used by voting contract to check if member was revoked
   */
  revok_at: (
    {
      dao_id,
      commitment,
    }: {
      dao_id: u64;
      commitment: u256;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Option<u64>>>;
  /**
   * Construct and simulate a root_idx transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get root index for a specific root (for vote mode validation)
   */
  root_idx: (
    {
      dao_id,
      root,
    }: {
      dao_id: u64;
      root: u256;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u32>>;
  /**
   * Construct and simulate a init_tree transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Initialize a tree for a specific DAO
   * Only DAO admin can initialize (via SBT contract which checks registry)
   */
  init_tree: (
    {
      dao_id,
      depth,
      admin,
    }: {
      dao_id: u64;
      depth: u32;
      admin: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a reinst_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get reinstatement timestamp for a commitment (returns None if never reinstated)
   * Used by voting contract to check if member was reinstated after revocation
   */
  reinst_at: (
    {
      dao_id,
      commitment,
    }: {
      dao_id: u64;
      commitment: u256;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Option<u64>>>;
  /**
   * Construct and simulate a sbt_contr transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get SBT contract address
   */
  sbt_contr: (options?: MethodOptions) => Promise<AssembledTransaction<string>>;
  /**
   * Construct and simulate a current_root transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get current root for a DAO
   */
  current_root: (
    {
      dao_id,
    }: {
      dao_id: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u256>>;
  /**
   * Construct and simulate a get_tree_info transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get tree info for a DAO
   */
  get_tree_info: (
    {
      dao_id,
    }: {
      dao_id: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<readonly [u32, u32, u256]>>;
  /**
   * Construct and simulate a remove_member transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Remove a member by zeroing their leaf and recomputing the root
   * Only callable by DAO admin
   * This zeros the leaf in the Merkle tree, preventing proofs against new roots
   */
  remove_member: (
    {
      dao_id,
      member,
      admin,
    }: {
      dao_id: u64;
      member: string;
      admin: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a self_register transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Self-register a commitment in a public DAO (requires SBT membership)
   * For public DAOs, anyone with an SBT can register their commitment
   */
  self_register: (
    {
      dao_id,
      commitment,
      member,
    }: {
      dao_id: u64;
      commitment: u256;
      member: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a get_leaf_index transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get leaf index for a commitment
   */
  get_leaf_index: (
    {
      dao_id,
      commitment,
    }: {
      dao_id: u64;
      commitment: u256;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u32>>;
  /**
   * Construct and simulate a get_merkle_path transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get Merkle path for a specific leaf index
   * Returns (pathElements, pathIndices) where:
   * - pathElements[i] is the sibling hash at level i
   * - pathIndices[i] is 0 if leaf is left child, 1 if right child
   *
   * This optimized version reads stored node hashes directly (O(depth) reads)
   * instead of reconstructing subtrees (which was O(n * log n) hashes).
   */
  get_merkle_path: (
    {
      dao_id,
      leaf_index,
    }: {
      dao_id: u64;
      leaf_index: u32;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<readonly [Array<u256>, Array<u32>]>>;
  /**
   * Construct and simulate a init_zeros_cache transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pre-initialize the zeros cache to avoid budget issues during first tree operations.
   * This should be called once during deployment to precompute zero values for all levels.
   */
  init_zeros_cache: (
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a reinstate_member transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reinstate a previously removed member
   * Clears their leaf index mapping so they can re-register with a new commitment
   * The admin should also re-mint their SBT via the membership-sbt contract
   */
  reinstate_member: (
    {
      dao_id,
      member,
      admin,
    }: {
      dao_id: u64;
      member: string;
      admin: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a register_with_caller transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Register a commitment with explicit caller (requires SBT membership)
   */
  register_with_caller: (
    {
      dao_id,
      commitment,
      caller,
    }: {
      dao_id: u64;
      commitment: u256;
      caller: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a register_from_registry transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Register a commitment from registry during DAO initialization
   * This function is called by the registry contract during create_and_init_dao
   * to automatically register the creator's commitment.
   * The registry is trusted to have already verified SBT ownership.
   */
  register_from_registry: (
    {
      dao_id,
      commitment,
      member,
    }: {
      dao_id: u64;
      commitment: u256;
      member: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a init_tree_from_registry transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Initialize tree from registry during DAO initialization
   * This function is called by the registry contract during create_and_init_dao
   * to avoid re-entrancy issues. The registry is a trusted system contract.
   */
  init_tree_from_registry: (
    {
      dao_id,
      depth,
    }: {
      dao_id: u64;
      depth: u32;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
}
export declare class Client extends ContractClient {
  readonly options: ContractClientOptions;
  static deploy<T = Client>(
    /** Constructor/Initialization Args for the contract's `__constructor` method */
    {
      sbt_contract,
      registry,
    }: {
      sbt_contract: string;
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
    root_ok: (json: string) => AssembledTransaction<boolean>;
    version: (json: string) => AssembledTransaction<number>;
    curr_idx: (json: string) => AssembledTransaction<number>;
    get_root: (json: string) => AssembledTransaction<bigint>;
    min_root: (json: string) => AssembledTransaction<number>;
    revok_at: (json: string) => AssembledTransaction<Option<bigint>>;
    root_idx: (json: string) => AssembledTransaction<number>;
    init_tree: (json: string) => AssembledTransaction<null>;
    reinst_at: (json: string) => AssembledTransaction<Option<bigint>>;
    sbt_contr: (json: string) => AssembledTransaction<string>;
    current_root: (json: string) => AssembledTransaction<bigint>;
    get_tree_info: (
      json: string,
    ) => AssembledTransaction<readonly [number, number, bigint]>;
    remove_member: (json: string) => AssembledTransaction<null>;
    self_register: (json: string) => AssembledTransaction<null>;
    get_leaf_index: (json: string) => AssembledTransaction<number>;
    get_merkle_path: (
      json: string,
    ) => AssembledTransaction<readonly [bigint[], number[]]>;
    init_zeros_cache: (json: string) => AssembledTransaction<null>;
    reinstate_member: (json: string) => AssembledTransaction<null>;
    register_with_caller: (json: string) => AssembledTransaction<null>;
    register_from_registry: (json: string) => AssembledTransaction<null>;
    init_tree_from_registry: (json: string) => AssembledTransaction<null>;
  };
}
