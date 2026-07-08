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
    readonly contractId: "CCUZNVADC24GEOPRD5A6PBCZGOQ6QOKJU6E5UBXI6RKDC7AWN5ATXNFF";
  };
};
export type DataKey =
  | {
      tag: "Comment";
      values: readonly [u64, u64, u64];
    }
  | {
      tag: "CommentCount";
      values: readonly [u64, u64];
    }
  | {
      tag: "CommentNullifier";
      values: readonly [u64, u64, u256];
    }
  | {
      tag: "CommitmentNonce";
      values: readonly [u64, u64, u256];
    }
  | {
      tag: "VotingContract";
      values: void;
    };
/**
 * Vote mode for proposal eligibility (mirrors voting contract)
 */
export type VoteMode =
  | {
      tag: "Fixed";
      values: void;
    }
  | {
      tag: "Trailing";
      values: void;
    };
/**
 * Comment on a proposal
 */
export interface CommentInfo {
  author: Option<string>;
  comment_nonce: Option<u64>;
  content_cid: string;
  created_at: u64;
  dao_id: u64;
  deleted: boolean;
  deleted_by: u32;
  id: u64;
  nullifier: Option<u256>;
  parent_id: Option<u64>;
  proposal_id: u64;
  revision_cids: Array<string>;
  updated_at: u64;
}
export declare const CommentsError: {
  1: {
    message: string;
  };
  19: {
    message: string;
  };
  5: {
    message: string;
  };
  9: {
    message: string;
  };
  12: {
    message: string;
  };
  15: {
    message: string;
  };
  16: {
    message: string;
  };
  18: {
    message: string;
  };
  22: {
    message: string;
  };
  23: {
    message: string;
  };
  24: {
    message: string;
  };
  25: {
    message: string;
  };
  27: {
    message: string;
  };
  28: {
    message: string;
  };
  29: {
    message: string;
  };
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
  /**
   * Root predates member removal (invalid for Trailing mode after revocation)
   */
  33: {
    message: string;
  };
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
   * Construct and simulate a version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Contract version
   */
  version: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>;
  /**
   * Construct and simulate a add_comment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Add a public comment (author is visible)
   */
  add_comment: (
    {
      dao_id,
      proposal_id,
      content_cid,
      parent_id,
      author,
    }: {
      dao_id: u64;
      proposal_id: u64;
      content_cid: string;
      parent_id: Option<u64>;
      author: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u64>>;
  /**
   * Construct and simulate a get_comment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get a single comment
   */
  get_comment: (
    {
      dao_id,
      proposal_id,
      comment_id,
    }: {
      dao_id: u64;
      proposal_id: u64;
      comment_id: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<CommentInfo>>;
  /**
   * Construct and simulate a edit_comment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Edit a public comment (owner only)
   */
  edit_comment: (
    {
      dao_id,
      proposal_id,
      comment_id,
      new_content_cid,
      author,
    }: {
      dao_id: u64;
      proposal_id: u64;
      comment_id: u64;
      new_content_cid: string;
      author: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a get_comments transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get comments paginated
   */
  get_comments: (
    {
      dao_id,
      proposal_id,
      start_id,
      limit,
    }: {
      dao_id: u64;
      proposal_id: u64;
      start_id: u64;
      limit: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Array<CommentInfo>>>;
  /**
   * Construct and simulate a comment_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get comment count for a proposal
   */
  comment_count: (
    {
      dao_id,
      proposal_id,
    }: {
      dao_id: u64;
      proposal_id: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u64>>;
  /**
   * Construct and simulate a tree_contract transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get tree contract address
   */
  tree_contract: (
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<string>>;
  /**
   * Construct and simulate a delete_comment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Delete a public comment (owner only)
   */
  delete_comment: (
    {
      dao_id,
      proposal_id,
      comment_id,
      author,
    }: {
      dao_id: u64;
      proposal_id: u64;
      comment_id: u64;
      author: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a voting_contract transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get voting contract address
   */
  voting_contract: (
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<string>>;
  /**
   * Construct and simulate a get_comment_nonce transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get the next available comment nonce for a commitment on a proposal
   * This is used by the relayer to tell users what nonce to use for their next anonymous comment
   */
  get_comment_nonce: (
    {
      dao_id,
      proposal_id,
      commitment,
    }: {
      dao_id: u64;
      proposal_id: u64;
      commitment: u256;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u64>>;
  /**
   * Construct and simulate a admin_delete_comment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin delete any comment
   */
  admin_delete_comment: (
    {
      dao_id,
      proposal_id,
      comment_id,
      admin,
    }: {
      dao_id: u64;
      proposal_id: u64;
      comment_id: u64;
      admin: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a add_anonymous_comment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Add an anonymous comment (requires ZK proof with vote circuit)
   * Uses the same vote circuit as voting - just verifies membership without tracking nullifiers.
   * This allows multiple comments from the same user (different from voting which enforces uniqueness).
   */
  add_anonymous_comment: (
    {
      dao_id,
      proposal_id,
      content_cid,
      parent_id,
      nullifier,
      root,
      vote_choice,
      proof,
    }: {
      dao_id: u64;
      proposal_id: u64;
      content_cid: string;
      parent_id: Option<u64>;
      nullifier: u256;
      root: u256;
      vote_choice: boolean;
      proof: Proof;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u64>>;
  /**
   * Construct and simulate a edit_anonymous_comment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Edit an anonymous comment (requires proof with same nullifier)
   * We verify the user owns the comment by checking the stored nullifier
   */
  edit_anonymous_comment: (
    {
      dao_id,
      proposal_id,
      comment_id,
      new_content_cid,
      nullifier,
      root,
      vote_choice,
      proof,
    }: {
      dao_id: u64;
      proposal_id: u64;
      comment_id: u64;
      new_content_cid: string;
      nullifier: u256;
      root: u256;
      vote_choice: boolean;
      proof: Proof;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a delete_anonymous_comment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Delete an anonymous comment (requires proof)
   */
  delete_anonymous_comment: (
    {
      dao_id,
      proposal_id,
      comment_id,
      nullifier,
      root,
      vote_choice,
      proof,
    }: {
      dao_id: u64;
      proposal_id: u64;
      comment_id: u64;
      nullifier: u256;
      root: u256;
      vote_choice: boolean;
      proof: Proof;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
}
export declare class Client extends ContractClient {
  readonly options: ContractClientOptions;
  static deploy<T = Client>(
    /** Constructor/Initialization Args for the contract's `__constructor` method */
    {
      tree_contract,
      voting_contract,
      registry,
    }: {
      tree_contract: string;
      voting_contract: string;
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
    version: (json: string) => AssembledTransaction<number>;
    add_comment: (json: string) => AssembledTransaction<bigint>;
    get_comment: (json: string) => AssembledTransaction<CommentInfo>;
    edit_comment: (json: string) => AssembledTransaction<null>;
    get_comments: (json: string) => AssembledTransaction<CommentInfo[]>;
    comment_count: (json: string) => AssembledTransaction<bigint>;
    tree_contract: (json: string) => AssembledTransaction<string>;
    delete_comment: (json: string) => AssembledTransaction<null>;
    voting_contract: (json: string) => AssembledTransaction<string>;
    get_comment_nonce: (json: string) => AssembledTransaction<bigint>;
    admin_delete_comment: (json: string) => AssembledTransaction<null>;
    add_anonymous_comment: (json: string) => AssembledTransaction<bigint>;
    edit_anonymous_comment: (json: string) => AssembledTransaction<null>;
    delete_anonymous_comment: (json: string) => AssembledTransaction<null>;
  };
}
