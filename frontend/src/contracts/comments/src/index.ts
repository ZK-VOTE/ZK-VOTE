import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Typepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}

export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CCUZNVADC24GEOPRD5A6PBCZGOQ6QOKJU6E5UBXI6RKDC7AWN5ATXNFF",
  },
} as const;

export type DataKey =
  | { tag: "Comment"; values: readonly [u64, u64, u64] }
  | { tag: "CommentCount"; values: readonly [u64, u64] }
  | { tag: "CommentNullifier"; values: readonly [u64, u64, u256] }
  | { tag: "CommitmentNonce"; values: readonly [u64, u64, u256] }
  | { tag: "VotingContract"; values: void };

/**
 * Vote mode for proposal eligibility (mirrors voting contract)
 */
export type VoteMode =
  | { tag: "Fixed"; values: void }
  | { tag: "Trailing"; values: void };

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

export const CommentsError = {
  1: { message: "NotAdmin" },
  19: { message: "Unauthorized" },
  5: { message: "NotDaoMember" },
  9: { message: "CommitmentRevoked" },
  12: { message: "RootNotInHistory" },
  15: { message: "InvalidProof" },
  16: { message: "ContractNotSet" },
  18: { message: "AlreadyInitialized" },
  22: { message: "CommentNotFound" },
  23: { message: "CommentDeleted" },
  24: { message: "NotCommentOwner" },
  25: { message: "InvalidParentComment" },
  27: { message: "CommentContentTooLong" },
  28: { message: "ProposalNotFound" },
  29: { message: "RootMismatch" },
  30: { message: "RootPredatesProposal" },
  /**
   * Public signal value >= BN254 scalar field modulus (invalid field element)
   */
  31: { message: "SignalNotInField" },
  /**
   * Nullifier is zero (invalid)
   */
  32: { message: "InvalidNullifier" },
  /**
   * Root predates member removal (invalid for Trailing mode after revocation)
   */
  33: { message: "RootPredatesRemoval" },
};

/**
 * Groth16 Proof
 */
export interface Proof {
  a: Buffer;
  b: Buffer;
  c: Buffer;
}

export const Groth16Error = {
  /**
   * IC vector length doesn't match public signals + 1
   */
  30: { message: "IcLengthMismatch" },
  /**
   * Public signal value >= BN254 scalar field modulus (invalid field element)
   */
  31: { message: "SignalNotInField" },
  /**
   * Nullifier is zero (invalid)
   */
  32: { message: "InvalidNullifier" },
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
    }: { dao_id: u64; proposal_id: u64; comment_id: u64 },
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
    }: { dao_id: u64; proposal_id: u64; start_id: u64; limit: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Array<CommentInfo>>>;

  /**
   * Construct and simulate a comment_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get comment count for a proposal
   */
  comment_count: (
    { dao_id, proposal_id }: { dao_id: u64; proposal_id: u64 },
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
    }: { dao_id: u64; proposal_id: u64; comment_id: u64; author: string },
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
    }: { dao_id: u64; proposal_id: u64; commitment: u256 },
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
    }: { dao_id: u64; proposal_id: u64; comment_id: u64; admin: string },
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
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Constructor/Initialization Args for the contract's `__constructor` method */
    {
      tree_contract,
      voting_contract,
      registry,
    }: { tree_contract: string; voting_contract: string; registry: string },
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
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(
      { tree_contract, voting_contract, registry },
      options,
    );
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAABQAAAAEAAAAAAAAAB0NvbW1lbnQAAAAAAwAAAAYAAAAGAAAABgAAAAEAAAAAAAAADENvbW1lbnRDb3VudAAAAAIAAAAGAAAABgAAAAEAAAAAAAAAEENvbW1lbnROdWxsaWZpZXIAAAADAAAABgAAAAYAAAAMAAAAAQAAAAAAAAAPQ29tbWl0bWVudE5vbmNlAAAAAAMAAAAGAAAABgAAAAwAAAAAAAAAAAAAAA5Wb3RpbmdDb250cmFjdAAA",
        "AAAAAgAAADxWb3RlIG1vZGUgZm9yIHByb3Bvc2FsIGVsaWdpYmlsaXR5IChtaXJyb3JzIHZvdGluZyBjb250cmFjdCkAAAAAAAAACFZvdGVNb2RlAAAAAgAAAAAAAAAAAAAABUZpeGVkAAAAAAAAAAAAAAAAAAAIVHJhaWxpbmc=",
        "AAAAAAAAABBDb250cmFjdCB2ZXJzaW9uAAAAB3ZlcnNpb24AAAAAAAAAAAEAAAAE",
        "AAAAAQAAABVDb21tZW50IG9uIGEgcHJvcG9zYWwAAAAAAAAAAAAAC0NvbW1lbnRJbmZvAAAAAA0AAAAAAAAABmF1dGhvcgAAAAAD6AAAABMAAAAAAAAADWNvbW1lbnRfbm9uY2UAAAAAAAPoAAAABgAAAAAAAAALY29udGVudF9jaWQAAAAAEAAAAAAAAAAKY3JlYXRlZF9hdAAAAAAABgAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAAAAAAdkZWxldGVkAAAAAAEAAAAAAAAACmRlbGV0ZWRfYnkAAAAAAAQAAAAAAAAAAmlkAAAAAAAGAAAAAAAAAAludWxsaWZpZXIAAAAAAAPoAAAADAAAAAAAAAAJcGFyZW50X2lkAAAAAAAD6AAAAAYAAAAAAAAAC3Byb3Bvc2FsX2lkAAAAAAYAAAAAAAAADXJldmlzaW9uX2NpZHMAAAAAAAPqAAAAEAAAAAAAAAAKdXBkYXRlZF9hdAAAAAAABg==",
        "AAAAAAAAAChBZGQgYSBwdWJsaWMgY29tbWVudCAoYXV0aG9yIGlzIHZpc2libGUpAAAAC2FkZF9jb21tZW50AAAAAAUAAAAAAAAABmRhb19pZAAAAAAABgAAAAAAAAALcHJvcG9zYWxfaWQAAAAABgAAAAAAAAALY29udGVudF9jaWQAAAAAEAAAAAAAAAAJcGFyZW50X2lkAAAAAAAD6AAAAAYAAAAAAAAABmF1dGhvcgAAAAAAEwAAAAEAAAAG",
        "AAAAAAAAABRHZXQgYSBzaW5nbGUgY29tbWVudAAAAAtnZXRfY29tbWVudAAAAAADAAAAAAAAAAZkYW9faWQAAAAAAAYAAAAAAAAAC3Byb3Bvc2FsX2lkAAAAAAYAAAAAAAAACmNvbW1lbnRfaWQAAAAAAAYAAAABAAAH0AAAAAtDb21tZW50SW5mbwA=",
        "AAAABAAAAAAAAAAAAAAADUNvbW1lbnRzRXJyb3IAAAAAAAATAAAAAAAAAAhOb3RBZG1pbgAAAAEAAAAAAAAADFVuYXV0aG9yaXplZAAAABMAAAAAAAAADE5vdERhb01lbWJlcgAAAAUAAAAAAAAAEUNvbW1pdG1lbnRSZXZva2VkAAAAAAAACQAAAAAAAAAQUm9vdE5vdEluSGlzdG9yeQAAAAwAAAAAAAAADEludmFsaWRQcm9vZgAAAA8AAAAAAAAADkNvbnRyYWN0Tm90U2V0AAAAAAAQAAAAAAAAABJBbHJlYWR5SW5pdGlhbGl6ZWQAAAAAABIAAAAAAAAAD0NvbW1lbnROb3RGb3VuZAAAAAAWAAAAAAAAAA5Db21tZW50RGVsZXRlZAAAAAAAFwAAAAAAAAAPTm90Q29tbWVudE93bmVyAAAAABgAAAAAAAAAFEludmFsaWRQYXJlbnRDb21tZW50AAAAGQAAAAAAAAAVQ29tbWVudENvbnRlbnRUb29Mb25nAAAAAAAAGwAAAAAAAAAQUHJvcG9zYWxOb3RGb3VuZAAAABwAAAAAAAAADFJvb3RNaXNtYXRjaAAAAB0AAAAAAAAAFFJvb3RQcmVkYXRlc1Byb3Bvc2FsAAAAHgAAAElQdWJsaWMgc2lnbmFsIHZhbHVlID49IEJOMjU0IHNjYWxhciBmaWVsZCBtb2R1bHVzIChpbnZhbGlkIGZpZWxkIGVsZW1lbnQpAAAAAAAAEFNpZ25hbE5vdEluRmllbGQAAAAfAAAAG051bGxpZmllciBpcyB6ZXJvIChpbnZhbGlkKQAAAAAQSW52YWxpZE51bGxpZmllcgAAACAAAABJUm9vdCBwcmVkYXRlcyBtZW1iZXIgcmVtb3ZhbCAoaW52YWxpZCBmb3IgVHJhaWxpbmcgbW9kZSBhZnRlciByZXZvY2F0aW9uKQAAAAAAABNSb290UHJlZGF0ZXNSZW1vdmFsAAAAACE=",
        "AAAAAAAAACJFZGl0IGEgcHVibGljIGNvbW1lbnQgKG93bmVyIG9ubHkpAAAAAAAMZWRpdF9jb21tZW50AAAABQAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAAAAAAtwcm9wb3NhbF9pZAAAAAAGAAAAAAAAAApjb21tZW50X2lkAAAAAAAGAAAAAAAAAA9uZXdfY29udGVudF9jaWQAAAAAEAAAAAAAAAAGYXV0aG9yAAAAAAATAAAAAA==",
        "AAAAAAAAABZHZXQgY29tbWVudHMgcGFnaW5hdGVkAAAAAAAMZ2V0X2NvbW1lbnRzAAAABAAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAAAAAAtwcm9wb3NhbF9pZAAAAAAGAAAAAAAAAAhzdGFydF9pZAAAAAYAAAAAAAAABWxpbWl0AAAAAAAABgAAAAEAAAPqAAAH0AAAAAtDb21tZW50SW5mbwA=",
        "AAAAAAAAAF1Db25zdHJ1Y3RvcjogSW5pdGlhbGl6ZSBjb250cmFjdCB3aXRoIE1lbWJlcnNoaXBUcmVlLCBWb3RpbmcsIGFuZCBSZWdpc3RyeSBjb250cmFjdCBhZGRyZXNzZXMAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAMAAAAAAAAADXRyZWVfY29udHJhY3QAAAAAAAATAAAAAAAAAA92b3RpbmdfY29udHJhY3QAAAAAEwAAAAAAAAAIcmVnaXN0cnkAAAATAAAAAA==",
        "AAAAAAAAACBHZXQgY29tbWVudCBjb3VudCBmb3IgYSBwcm9wb3NhbAAAAA1jb21tZW50X2NvdW50AAAAAAAAAgAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAAAAAAtwcm9wb3NhbF9pZAAAAAAGAAAAAQAAAAY=",
        "AAAAAAAAABlHZXQgdHJlZSBjb250cmFjdCBhZGRyZXNzAAAAAAAADXRyZWVfY29udHJhY3QAAAAAAAAAAAAAAQAAABM=",
        "AAAAAAAAACREZWxldGUgYSBwdWJsaWMgY29tbWVudCAob3duZXIgb25seSkAAAAOZGVsZXRlX2NvbW1lbnQAAAAAAAQAAAAAAAAABmRhb19pZAAAAAAABgAAAAAAAAALcHJvcG9zYWxfaWQAAAAABgAAAAAAAAAKY29tbWVudF9pZAAAAAAABgAAAAAAAAAGYXV0aG9yAAAAAAATAAAAAA==",
        "AAAAAAAAABtHZXQgdm90aW5nIGNvbnRyYWN0IGFkZHJlc3MAAAAAD3ZvdGluZ19jb250cmFjdAAAAAAAAAAAAQAAABM=",
        "AAAABQAAAAAAAAAAAAAAEENvbnRyYWN0VXBncmFkZWQAAAABAAAAEWNvbnRyYWN0X3VwZ3JhZGVkAAAAAAAAAgAAAAAAAAAEZnJvbQAAAAQAAAAAAAAAAAAAAAJ0bwAAAAAABAAAAAAAAAAC",
        "AAAAAAAAAKBHZXQgdGhlIG5leHQgYXZhaWxhYmxlIGNvbW1lbnQgbm9uY2UgZm9yIGEgY29tbWl0bWVudCBvbiBhIHByb3Bvc2FsClRoaXMgaXMgdXNlZCBieSB0aGUgcmVsYXllciB0byB0ZWxsIHVzZXJzIHdoYXQgbm9uY2UgdG8gdXNlIGZvciB0aGVpciBuZXh0IGFub255bW91cyBjb21tZW50AAAAEWdldF9jb21tZW50X25vbmNlAAAAAAAAAwAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAAAAAAtwcm9wb3NhbF9pZAAAAAAGAAAAAAAAAApjb21taXRtZW50AAAAAAAMAAAAAQAAAAY=",
        "AAAABQAAAAAAAAAAAAAAEkNvbW1lbnRFZGl0ZWRFdmVudAAAAAAAAQAAABRjb21tZW50X2VkaXRlZF9ldmVudAAAAAMAAAAAAAAABmRhb19pZAAAAAAABgAAAAEAAAAAAAAAC3Byb3Bvc2FsX2lkAAAAAAYAAAABAAAAAAAAAApjb21tZW50X2lkAAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAE0NvbW1lbnRDcmVhdGVkRXZlbnQAAAAAAQAAABVjb21tZW50X2NyZWF0ZWRfZXZlbnQAAAAAAAAEAAAAAAAAAAZkYW9faWQAAAAAAAYAAAABAAAAAAAAAAtwcm9wb3NhbF9pZAAAAAAGAAAAAQAAAAAAAAAKY29tbWVudF9pZAAAAAAABgAAAAAAAAAAAAAADGlzX2Fub255bW91cwAAAAEAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAE0NvbW1lbnREZWxldGVkRXZlbnQAAAAAAQAAABVjb21tZW50X2RlbGV0ZWRfZXZlbnQAAAAAAAAEAAAAAAAAAAZkYW9faWQAAAAAAAYAAAABAAAAAAAAAAtwcm9wb3NhbF9pZAAAAAAGAAAAAQAAAAAAAAAKY29tbWVudF9pZAAAAAAABgAAAAAAAAAAAAAACmRlbGV0ZWRfYnkAAAAAAAQAAAAAAAAAAg==",
        "AAAAAAAAABhBZG1pbiBkZWxldGUgYW55IGNvbW1lbnQAAAAUYWRtaW5fZGVsZXRlX2NvbW1lbnQAAAAEAAAAAAAAAAZkYW9faWQAAAAAAAYAAAAAAAAAC3Byb3Bvc2FsX2lkAAAAAAYAAAAAAAAACmNvbW1lbnRfaWQAAAAAAAYAAAAAAAAABWFkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAAP9BZGQgYW4gYW5vbnltb3VzIGNvbW1lbnQgKHJlcXVpcmVzIFpLIHByb29mIHdpdGggdm90ZSBjaXJjdWl0KQpVc2VzIHRoZSBzYW1lIHZvdGUgY2lyY3VpdCBhcyB2b3RpbmcgLSBqdXN0IHZlcmlmaWVzIG1lbWJlcnNoaXAgd2l0aG91dCB0cmFja2luZyBudWxsaWZpZXJzLgpUaGlzIGFsbG93cyBtdWx0aXBsZSBjb21tZW50cyBmcm9tIHRoZSBzYW1lIHVzZXIgKGRpZmZlcmVudCBmcm9tIHZvdGluZyB3aGljaCBlbmZvcmNlcyB1bmlxdWVuZXNzKS4AAAAAFWFkZF9hbm9ueW1vdXNfY29tbWVudAAAAAAAAAgAAAAAAAAABmRhb19pZAAAAAAABgAAAAAAAAALcHJvcG9zYWxfaWQAAAAABgAAAAAAAAALY29udGVudF9jaWQAAAAAEAAAAAAAAAAJcGFyZW50X2lkAAAAAAAD6AAAAAYAAAAAAAAACW51bGxpZmllcgAAAAAAAAwAAAAAAAAABHJvb3QAAAAMAAAAAAAAAAt2b3RlX2Nob2ljZQAAAAABAAAAAAAAAAVwcm9vZgAAAAAAB9AAAAAFUHJvb2YAAAAAAAABAAAABg==",
        "AAAAAAAAAINFZGl0IGFuIGFub255bW91cyBjb21tZW50IChyZXF1aXJlcyBwcm9vZiB3aXRoIHNhbWUgbnVsbGlmaWVyKQpXZSB2ZXJpZnkgdGhlIHVzZXIgb3ducyB0aGUgY29tbWVudCBieSBjaGVja2luZyB0aGUgc3RvcmVkIG51bGxpZmllcgAAAAAWZWRpdF9hbm9ueW1vdXNfY29tbWVudAAAAAAACAAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAAAAAAtwcm9wb3NhbF9pZAAAAAAGAAAAAAAAAApjb21tZW50X2lkAAAAAAAGAAAAAAAAAA9uZXdfY29udGVudF9jaWQAAAAAEAAAAAAAAAAJbnVsbGlmaWVyAAAAAAAADAAAAAAAAAAEcm9vdAAAAAwAAAAAAAAAC3ZvdGVfY2hvaWNlAAAAAAEAAAAAAAAABXByb29mAAAAAAAH0AAAAAVQcm9vZgAAAAAAAAA=",
        "AAAAAAAAACxEZWxldGUgYW4gYW5vbnltb3VzIGNvbW1lbnQgKHJlcXVpcmVzIHByb29mKQAAABhkZWxldGVfYW5vbnltb3VzX2NvbW1lbnQAAAAHAAAAAAAAAAZkYW9faWQAAAAAAAYAAAAAAAAAC3Byb3Bvc2FsX2lkAAAAAAYAAAAAAAAACmNvbW1lbnRfaWQAAAAAAAYAAAAAAAAACW51bGxpZmllcgAAAAAAAAwAAAAAAAAABHJvb3QAAAAMAAAAAAAAAAt2b3RlX2Nob2ljZQAAAAABAAAAAAAAAAVwcm9vZgAAAAAAB9AAAAAFUHJvb2YAAAAAAAAA",
        "AAAAAQAAAA1Hcm90aDE2IFByb29mAAAAAAAAAAAAAAVQcm9vZgAAAAAAAAMAAAAAAAAAAWEAAAAAAAPuAAAAQAAAAAAAAAABYgAAAAAAA+4AAACAAAAAAAAAAAFjAAAAAAAD7gAAAEA=",
        "AAAABAAAAAAAAAAAAAAADEdyb3RoMTZFcnJvcgAAAAMAAAAxSUMgdmVjdG9yIGxlbmd0aCBkb2Vzbid0IG1hdGNoIHB1YmxpYyBzaWduYWxzICsgMQAAAAAAABBJY0xlbmd0aE1pc21hdGNoAAAAHgAAAElQdWJsaWMgc2lnbmFsIHZhbHVlID49IEJOMjU0IHNjYWxhciBmaWVsZCBtb2R1bHVzIChpbnZhbGlkIGZpZWxkIGVsZW1lbnQpAAAAAAAAEFNpZ25hbE5vdEluRmllbGQAAAAfAAAAG051bGxpZmllciBpcyB6ZXJvIChpbnZhbGlkKQAAAAAQSW52YWxpZE51bGxpZmllcgAAACA=",
        "AAAAAQAAACJHcm90aDE2IFZlcmlmaWNhdGlvbiBLZXkgZm9yIEJOMjU0AAAAAAAAAAAAD1ZlcmlmaWNhdGlvbktleQAAAAAFAAAAAAAAAAVhbHBoYQAAAAAAA+4AAABAAAAAAAAAAARiZXRhAAAD7gAAAIAAAAAAAAAABWRlbHRhAAAAAAAD7gAAAIAAAAAAAAAABWdhbW1hAAAAAAAD7gAAAIAAAAAAAAAAAmljAAAAAAPqAAAD7gAAAEA=",
      ]),
      options,
    );
  }
  public readonly fromJSON = {
    version: this.txFromJSON<u32>,
    add_comment: this.txFromJSON<u64>,
    get_comment: this.txFromJSON<CommentInfo>,
    edit_comment: this.txFromJSON<null>,
    get_comments: this.txFromJSON<Array<CommentInfo>>,
    comment_count: this.txFromJSON<u64>,
    tree_contract: this.txFromJSON<string>,
    delete_comment: this.txFromJSON<null>,
    voting_contract: this.txFromJSON<string>,
    get_comment_nonce: this.txFromJSON<u64>,
    admin_delete_comment: this.txFromJSON<null>,
    add_anonymous_comment: this.txFromJSON<u64>,
    edit_anonymous_comment: this.txFromJSON<null>,
    delete_anonymous_comment: this.txFromJSON<null>,
  };
}
