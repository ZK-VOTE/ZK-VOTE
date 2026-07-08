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
    contractId: "CCYGWEUNWOBHJ6JIHDMTK2XSSDVMQ7ZGBJQE6QR2VYD4FRQGZR5EYKJ2",
  },
} as const;

export type DataKey =
  | { tag: "Proposal"; values: readonly [u64, u64] }
  | { tag: "ProposalCount"; values: readonly [u64] }
  | { tag: "Nullifier"; values: readonly [u64, u64, u256] }
  | { tag: "VotingKey"; values: readonly [u64] }
  | { tag: "VkVersion"; values: readonly [u64] }
  | { tag: "VkByVersion"; values: readonly [u64, u32] }
  | { tag: "VerifyOverride"; values: void };

export type VoteMode =
  | { tag: "Fixed"; values: void }
  | { tag: "Trailing"; values: void };

export const VotingError = {
  1: { message: "NotAdmin" },
  19: { message: "Unauthorized" },
  2: { message: "VkIcLengthMismatch" },
  3: { message: "VkIcTooLarge" },
  4: { message: "TitleTooLong" },
  5: { message: "NotDaoMember" },
  6: { message: "EndTimeInvalid" },
  7: { message: "NullifierUsed" },
  8: { message: "VotingClosed" },
  9: { message: "CommitmentRevokedAtCreation" },
  10: { message: "CommitmentRevokedDuringVoting" },
  11: { message: "RootMismatch" },
  12: { message: "RootNotInHistory" },
  13: { message: "RootPredatesProposal" },
  14: { message: "VkChanged" },
  15: { message: "InvalidProof" },
  16: { message: "VkNotSet" },
  17: { message: "VkVersionMismatch" },
  18: { message: "AlreadyInitialized" },
  20: { message: "InvalidState" },
  21: { message: "InvalidContentCid" },
  /**
   * Only DAO admin can create proposals (members_can_propose = false)
   */
  22: { message: "OnlyAdminCanPropose" },
  /**
   * G1 point not on BN254 curve (y² ≠ x³ + 3)
   */
  23: { message: "InvalidG1Point" },
  /**
   * Root predates member removal (invalid for Trailing mode after revocation)
   */
  24: { message: "RootPredatesRemoval" },
  /**
   * Public signal value >= BN254 scalar field modulus (invalid field element)
   */
  25: { message: "SignalNotInField" },
  /**
   * Nullifier is zero (invalid)
   */
  26: { message: "InvalidNullifier" },
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
  | { tag: "Active"; values: void }
  | { tag: "Closed"; values: void }
  | { tag: "Archived"; values: void };

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
    { dao_id }: { dao_id: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<VerificationKey>>;

  /**
   * Construct and simulate a set_vk transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set verification key for a DAO (admin only)
   */
  set_vk: (
    { dao_id, vk, admin }: { dao_id: u64; vk: VerificationKey; admin: string },
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
    { dao_id }: { dao_id: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u32>>;

  /**
   * Construct and simulate a get_results transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get results for a proposal (yes_votes, no_votes)
   */
  get_results: (
    { dao_id, proposal_id }: { dao_id: u64; proposal_id: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<readonly [u64, u64]>>;

  /**
   * Construct and simulate a get_proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get proposal info
   */
  get_proposal: (
    { dao_id, proposal_id }: { dao_id: u64; proposal_id: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<ProposalInfo>>;

  /**
   * Construct and simulate a get_vote_mode transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get vote mode for a proposal
   * Returns VoteMode enum directly for type safety
   * Used by comments contract for eligibility checks
   */
  get_vote_mode: (
    { dao_id, proposal_id }: { dao_id: u64; proposal_id: u64 },
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
    }: { dao_id: u64; proposal_id: u64; admin: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;

  /**
   * Construct and simulate a proposal_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get proposal count for a DAO
   */
  proposal_count: (
    { dao_id }: { dao_id: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u64>>;

  /**
   * Construct and simulate a vk_for_version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get a specific VK version for observability/off-chain verification
   */
  vk_for_version: (
    { dao_id, version }: { dao_id: u64; version: u32 },
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
    }: { dao_id: u64; proposal_id: u64; admin: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;

  /**
   * Construct and simulate a get_earliest_idx transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get earliest root index for a proposal (for Trailing mode)
   * Used by comments contract for Trailing mode eligibility checks
   */
  get_earliest_idx: (
    { dao_id, proposal_id }: { dao_id: u64; proposal_id: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u32>>;

  /**
   * Construct and simulate a get_eligible_root transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get eligible root for a proposal (merkle root at snapshot)
   * Used by comments contract for Fixed mode eligibility checks
   */
  get_eligible_root: (
    { dao_id, proposal_id }: { dao_id: u64; proposal_id: u64 },
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
    }: { dao_id: u64; proposal_id: u64; nullifier: u256 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<boolean>>;

  /**
   * Construct and simulate a set_vk_from_registry transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set verification key from registry during DAO initialization
   * This function is called by the registry contract during create_and_init_dao
   * to avoid re-entrancy issues. The registry is a trusted system contract.
   */
  set_vk_from_registry: (
    { dao_id, vk }: { dao_id: u64; vk: VerificationKey },
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
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Constructor/Initialization Args for the contract's `__constructor` method */
    { tree_contract, registry }: { tree_contract: string; registry: string },
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
    return ContractClient.deploy({ tree_contract, registry }, options);
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([
        "AAAAAAAAAJBTdWJtaXQgYSB2b3RlIHdpdGggWksgcHJvb2YKUHJpdmFjeS1wcmVzZXJ2aW5nOiBjb21taXRtZW50IGlzIE5PVCBhIHB1YmxpYyBwYXJhbWV0ZXIKUmV2b2NhdGlvbiBpcyBlbmZvcmNlZCBieSB6ZXJvaW5nIGxlYXZlcyBpbiB0aGUgTWVya2xlIHRyZWUAAAAEdm90ZQAAAAYAAAAAAAAABmRhb19pZAAAAAAABgAAAAAAAAALcHJvcG9zYWxfaWQAAAAABgAAAAAAAAALdm90ZV9jaG9pY2UAAAAAAQAAAAAAAAAJbnVsbGlmaWVyAAAAAAAADAAAAAAAAAAEcm9vdAAAAAwAAAAAAAAABXByb29mAAAAAAAH0AAAAAVQcm9vZgAAAAAAAAA=",
        "AAAAAAAAAERHZXQgdGhlIGN1cnJlbnQgVksgZm9yIGEgREFPICh1c2VkIGJ5IG90aGVyIGNvbnRyYWN0cyBsaWtlIGNvbW1lbnRzKQAAAAZnZXRfdmsAAAAAAAEAAAAAAAAABmRhb19pZAAAAAAABgAAAAEAAAfQAAAAD1ZlcmlmaWNhdGlvbktleQA=",
        "AAAAAAAAACtTZXQgdmVyaWZpY2F0aW9uIGtleSBmb3IgYSBEQU8gKGFkbWluIG9ubHkpAAAAAAZzZXRfdmsAAAAAAAMAAAAAAAAABmRhb19pZAAAAAAABgAAAAAAAAACdmsAAAAAB9AAAAAPVmVyaWZpY2F0aW9uS2V5AAAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAA==",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAABwAAAAEAAAAAAAAACFByb3Bvc2FsAAAAAgAAAAYAAAAGAAAAAQAAAAAAAAANUHJvcG9zYWxDb3VudAAAAAAAAAEAAAAGAAAAAQAAAAAAAAAJTnVsbGlmaWVyAAAAAAAAAwAAAAYAAAAGAAAADAAAAAEAAAAAAAAACVZvdGluZ0tleQAAAAAAAAEAAAAGAAAAAQAAAAAAAAAJVmtWZXJzaW9uAAAAAAAAAQAAAAYAAAABAAAAAAAAAAtWa0J5VmVyc2lvbgAAAAACAAAABgAAAAQAAAAAAAAAQFRlc3Qtb25seTogb3ZlcnJpZGVzIHByb29mIHZlcmlmaWNhdGlvbi4gTm90IHVzZWQgaW4gcHJvZHVjdGlvbi4AAAAOVmVyaWZ5T3ZlcnJpZGUAAA==",
        "AAAAAAAAACZDb250cmFjdCB2ZXJzaW9uIGZvciB1cGdyYWRlIHRyYWNraW5nLgAAAAAAB3ZlcnNpb24AAAAAAAAAAAEAAAAE",
        "AAAAAgAAAAAAAAAAAAAACFZvdGVNb2RlAAAAAgAAAAAAAAAAAAAABUZpeGVkAAAAAAAAAAAAAAAAAAAIVHJhaWxpbmc=",
        "AAAAAAAAADZHZXQgcmVnaXN0cnkgY29udHJhY3QgYWRkcmVzcyAoY2FjaGVkIGF0IGNvbnN0cnVjdGlvbikAAAAAAAhyZWdpc3RyeQAAAAAAAAABAAAAEw==",
        "AAAABQAAAAAAAAAAAAAACVZvdGVFdmVudAAAAAAAAAEAAAAKdm90ZV9ldmVudAAAAAAABAAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAQAAAAAAAAALcHJvcG9zYWxfaWQAAAAABgAAAAEAAAAAAAAABmNob2ljZQAAAAAAAQAAAAAAAAAAAAAACW51bGxpZmllcgAAAAAAAAwAAAAAAAAAAg==",
        "AAAAAAAAACBHZXQgY3VycmVudCBWSyB2ZXJzaW9uIGZvciBhIERBTwAAAAp2a192ZXJzaW9uAAAAAAABAAAAAAAAAAZkYW9faWQAAAAAAAYAAAABAAAABA==",
        "AAAABQAAAAAAAAAAAAAAClZLU2V0RXZlbnQAAAAAAAEAAAAMdmtfc2V0X2V2ZW50AAAAAQAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAQAAAAI=",
        "AAAABAAAAAAAAAAAAAAAC1ZvdGluZ0Vycm9yAAAAABoAAAAAAAAACE5vdEFkbWluAAAAAQAAAAAAAAAMVW5hdXRob3JpemVkAAAAEwAAAAAAAAASVmtJY0xlbmd0aE1pc21hdGNoAAAAAAACAAAAAAAAAAxWa0ljVG9vTGFyZ2UAAAADAAAAAAAAAAxUaXRsZVRvb0xvbmcAAAAEAAAAAAAAAAxOb3REYW9NZW1iZXIAAAAFAAAAAAAAAA5FbmRUaW1lSW52YWxpZAAAAAAABgAAAAAAAAANTnVsbGlmaWVyVXNlZAAAAAAAAAcAAAAAAAAADFZvdGluZ0Nsb3NlZAAAAAgAAAAAAAAAG0NvbW1pdG1lbnRSZXZva2VkQXRDcmVhdGlvbgAAAAAJAAAAAAAAAB1Db21taXRtZW50UmV2b2tlZER1cmluZ1ZvdGluZwAAAAAAAAoAAAAAAAAADFJvb3RNaXNtYXRjaAAAAAsAAAAAAAAAEFJvb3ROb3RJbkhpc3RvcnkAAAAMAAAAAAAAABRSb290UHJlZGF0ZXNQcm9wb3NhbAAAAA0AAAAAAAAACVZrQ2hhbmdlZAAAAAAAAA4AAAAAAAAADEludmFsaWRQcm9vZgAAAA8AAAAAAAAACFZrTm90U2V0AAAAEAAAAAAAAAARVmtWZXJzaW9uTWlzbWF0Y2gAAAAAAAARAAAAAAAAABJBbHJlYWR5SW5pdGlhbGl6ZWQAAAAAABIAAAAAAAAADEludmFsaWRTdGF0ZQAAABQAAAAAAAAAEUludmFsaWRDb250ZW50Q2lkAAAAAAAAFQAAAEFPbmx5IERBTyBhZG1pbiBjYW4gY3JlYXRlIHByb3Bvc2FscyAobWVtYmVyc19jYW5fcHJvcG9zZSA9IGZhbHNlKQAAAAAAABNPbmx5QWRtaW5DYW5Qcm9wb3NlAAAAABYAAAAtRzEgcG9pbnQgbm90IG9uIEJOMjU0IGN1cnZlICh5wrIg4omgIHjCsyArIDMpAAAAAAAADkludmFsaWRHMVBvaW50AAAAAAAXAAAASVJvb3QgcHJlZGF0ZXMgbWVtYmVyIHJlbW92YWwgKGludmFsaWQgZm9yIFRyYWlsaW5nIG1vZGUgYWZ0ZXIgcmV2b2NhdGlvbikAAAAAAAATUm9vdFByZWRhdGVzUmVtb3ZhbAAAAAAYAAAASVB1YmxpYyBzaWduYWwgdmFsdWUgPj0gQk4yNTQgc2NhbGFyIGZpZWxkIG1vZHVsdXMgKGludmFsaWQgZmllbGQgZWxlbWVudCkAAAAAAAAQU2lnbmFsTm90SW5GaWVsZAAAABkAAAAbTnVsbGlmaWVyIGlzIHplcm8gKGludmFsaWQpAAAAABBJbnZhbGlkTnVsbGlmaWVyAAAAGg==",
        "AAAAAAAAADBHZXQgcmVzdWx0cyBmb3IgYSBwcm9wb3NhbCAoeWVzX3ZvdGVzLCBub192b3RlcykAAAALZ2V0X3Jlc3VsdHMAAAAAAgAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAAAAAAtwcm9wb3NhbF9pZAAAAAAGAAAAAQAAA+0AAAACAAAABgAAAAY=",
        "AAAAAQAAAAAAAAAAAAAADFByb3Bvc2FsSW5mbwAAAA8AAAAAAAAAC2NvbnRlbnRfY2lkAAAAABAAAAAAAAAACmNyZWF0ZWRfYXQAAAAAAAYAAAAAAAAACmNyZWF0ZWRfYnkAAAAAABMAAAAAAAAABmRhb19pZAAAAAAABgAAAAAAAAATZWFybGllc3Rfcm9vdF9pbmRleAAAAAAEAAAAAAAAAA1lbGlnaWJsZV9yb290AAAAAAAADAAAAAAAAAAIZW5kX3RpbWUAAAAGAAAAAAAAAAJpZAAAAAAABgAAAAAAAAAIbm9fdm90ZXMAAAAGAAAAAAAAAAVzdGF0ZQAAAAAAB9AAAAANUHJvcG9zYWxTdGF0ZQAAAAAAAAAAAAAFdGl0bGUAAAAAAAAQAAAAAAAAAAd2a19oYXNoAAAAA+4AAAAgAAAAAAAAAAp2a192ZXJzaW9uAAAAAAAEAAAAAAAAAAl2b3RlX21vZGUAAAAAAAfQAAAACFZvdGVNb2RlAAAAAAAAAAl5ZXNfdm90ZXMAAAAAAAAG",
        "AAAAAAAAABFHZXQgcHJvcG9zYWwgaW5mbwAAAAAAAAxnZXRfcHJvcG9zYWwAAAACAAAAAAAAAAZkYW9faWQAAAAAAAYAAAAAAAAAC3Byb3Bvc2FsX2lkAAAAAAYAAAABAAAH0AAAAAxQcm9wb3NhbEluZm8=",
        "AAAAAgAAAAAAAAAAAAAADVByb3Bvc2FsU3RhdGUAAAAAAAADAAAAAAAAAAAAAAAGQWN0aXZlAAAAAAAAAAAAAAAAAAZDbG9zZWQAAAAAAAAAAAAAAAAACEFyY2hpdmVk",
        "AAAAAAAAADxDb25zdHJ1Y3RvcjogSW5pdGlhbGl6ZSBjb250cmFjdCB3aXRoIE1lbWJlcnNoaXBUcmVlIGFkZHJlc3MAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAIAAAAAAAAADXRyZWVfY29udHJhY3QAAAAAAAATAAAAAAAAAAhyZWdpc3RyeQAAABMAAAAA",
        "AAAAAAAAAHxHZXQgdm90ZSBtb2RlIGZvciBhIHByb3Bvc2FsClJldHVybnMgVm90ZU1vZGUgZW51bSBkaXJlY3RseSBmb3IgdHlwZSBzYWZldHkKVXNlZCBieSBjb21tZW50cyBjb250cmFjdCBmb3IgZWxpZ2liaWxpdHkgY2hlY2tzAAAADWdldF92b3RlX21vZGUAAAAAAAACAAAAAAAAAAZkYW9faWQAAAAAAAYAAAAAAAAAC3Byb3Bvc2FsX2lkAAAAAAYAAAABAAAH0AAAAAhWb3RlTW9kZQ==",
        "AAAAAAAAABlHZXQgdHJlZSBjb250cmFjdCBhZGRyZXNzAAAAAAAADXRyZWVfY29udHJhY3QAAAAAAAAAAAAAAQAAABM=",
        "AAAABQAAAAAAAAAAAAAADVByb3Bvc2FsRXZlbnQAAAAAAAABAAAADnByb3Bvc2FsX2V2ZW50AAAAAAAFAAAAAAAAAAZkYW9faWQAAAAAAAYAAAABAAAAAAAAAAtwcm9wb3NhbF9pZAAAAAAGAAAAAQAAAAAAAAAFdGl0bGUAAAAAAAAQAAAAAAAAAAAAAAALY29udGVudF9jaWQAAAAAEAAAAAAAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAAAAAAC",
        "AAAAAAAAAEpDbG9zZSBhIHByb3Bvc2FsIGV4cGxpY2l0bHkgKGlkZW1wb3RlbnQpLiBFbmQgdGltZSBzdGlsbCBlbmZvcmNlZCBpbiB2b3RlLgAAAAAADmNsb3NlX3Byb3Bvc2FsAAAAAAADAAAAAAAAAAZkYW9faWQAAAAAAAYAAAAAAAAAC3Byb3Bvc2FsX2lkAAAAAAYAAAAAAAAABWFkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAABxHZXQgcHJvcG9zYWwgY291bnQgZm9yIGEgREFPAAAADnByb3Bvc2FsX2NvdW50AAAAAAABAAAAAAAAAAZkYW9faWQAAAAAAAYAAAABAAAABg==",
        "AAAAAAAAAEJHZXQgYSBzcGVjaWZpYyBWSyB2ZXJzaW9uIGZvciBvYnNlcnZhYmlsaXR5L29mZi1jaGFpbiB2ZXJpZmljYXRpb24AAAAAAA52a19mb3JfdmVyc2lvbgAAAAAAAgAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAAAAAAd2ZXJzaW9uAAAAAAQAAAABAAAH0AAAAA9WZXJpZmljYXRpb25LZXkA",
        "AAAAAAAAAUNDcmVhdGUgYSBuZXcgcHJvcG9zYWwgZm9yIGEgREFPClZvdGluZyBzdGFydHMgaW1tZWRpYXRlbHkgdXBvbiBjcmVhdGlvbiAoTWVya2xlIHJvb3Qgc25hcHNob3QgdGFrZW4gbm93KQp0aXRsZTogU2hvcnQgZGlzcGxheSB0aXRsZSAobWF4IDEwMCBieXRlcykKY29udGVudF9jaWQ6IElQRlMgQ0lEIHBvaW50aW5nIHRvIHJpY2ggY29udGVudCAob3IgbGVnYWN5IHBsYWluIHRleHQgZGVzY3JpcHRpb24pCmVuZF90aW1lOiBVbml4IHRpbWVzdGFtcCBmb3Igd2hlbiB2b3RpbmcgY2xvc2VzIChtdXN0IGJlIGluIHRoZSBmdXR1cmUsIG9yIDAgZm9yIG5vIGRlYWRsaW5lKQAAAAAPY3JlYXRlX3Byb3Bvc2FsAAAAAAYAAAAAAAAABmRhb19pZAAAAAAABgAAAAAAAAAFdGl0bGUAAAAAAAAQAAAAAAAAAAtjb250ZW50X2NpZAAAAAAQAAAAAAAAAAhlbmRfdGltZQAAAAYAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAAAAAAJdm90ZV9tb2RlAAAAAAAH0AAAAAhWb3RlTW9kZQAAAAEAAAAG",
        "AAAAAAAAAFZBcmNoaXZlIGEgcHJvcG9zYWwgKGlkZW1wb3RlbnQpLiBQcmV2ZW50cyBmdXJ0aGVyIHZvdGVzIGFuZCBzaWduYWxzIG9mZi1jaGFpbiBjbGVhbnVwLgAAAAAAEGFyY2hpdmVfcHJvcG9zYWwAAAADAAAAAAAAAAZkYW9faWQAAAAAAAYAAAAAAAAAC3Byb3Bvc2FsX2lkAAAAAAYAAAAAAAAABWFkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAAHlHZXQgZWFybGllc3Qgcm9vdCBpbmRleCBmb3IgYSBwcm9wb3NhbCAoZm9yIFRyYWlsaW5nIG1vZGUpClVzZWQgYnkgY29tbWVudHMgY29udHJhY3QgZm9yIFRyYWlsaW5nIG1vZGUgZWxpZ2liaWxpdHkgY2hlY2tzAAAAAAAAEGdldF9lYXJsaWVzdF9pZHgAAAACAAAAAAAAAAZkYW9faWQAAAAAAAYAAAAAAAAAC3Byb3Bvc2FsX2lkAAAAAAYAAAABAAAABA==",
        "AAAABQAAAAAAAAAAAAAAEENvbnRyYWN0VXBncmFkZWQAAAABAAAAEWNvbnRyYWN0X3VwZ3JhZGVkAAAAAAAAAgAAAAAAAAAEZnJvbQAAAAQAAAAAAAAAAAAAAAJ0bwAAAAAABAAAAAAAAAAC",
        "AAAAAAAAAHZHZXQgZWxpZ2libGUgcm9vdCBmb3IgYSBwcm9wb3NhbCAobWVya2xlIHJvb3QgYXQgc25hcHNob3QpClVzZWQgYnkgY29tbWVudHMgY29udHJhY3QgZm9yIEZpeGVkIG1vZGUgZWxpZ2liaWxpdHkgY2hlY2tzAAAAAAARZ2V0X2VsaWdpYmxlX3Jvb3QAAAAAAAACAAAAAAAAAAZkYW9faWQAAAAAAAYAAAAAAAAAC3Byb3Bvc2FsX2lkAAAAAAYAAAABAAAADA==",
        "AAAAAAAAACBDaGVjayBpZiBudWxsaWZpZXIgaGFzIGJlZW4gdXNlZAAAABFpc19udWxsaWZpZXJfdXNlZAAAAAAAAAMAAAAAAAAABmRhb19pZAAAAAAABgAAAAAAAAALcHJvcG9zYWxfaWQAAAAABgAAAAAAAAAJbnVsbGlmaWVyAAAAAAAADAAAAAEAAAAB",
        "AAAABQAAAAAAAAAAAAAAE1Byb3Bvc2FsQ2xvc2VkRXZlbnQAAAAAAQAAABVwcm9wb3NhbF9jbG9zZWRfZXZlbnQAAAAAAAADAAAAAAAAAAZkYW9faWQAAAAAAAYAAAABAAAAAAAAAAtwcm9wb3NhbF9pZAAAAAAGAAAAAQAAAAAAAAAJY2xvc2VkX2J5AAAAAAAAEwAAAAAAAAAC",
        "AAAAAAAAANBTZXQgdmVyaWZpY2F0aW9uIGtleSBmcm9tIHJlZ2lzdHJ5IGR1cmluZyBEQU8gaW5pdGlhbGl6YXRpb24KVGhpcyBmdW5jdGlvbiBpcyBjYWxsZWQgYnkgdGhlIHJlZ2lzdHJ5IGNvbnRyYWN0IGR1cmluZyBjcmVhdGVfYW5kX2luaXRfZGFvCnRvIGF2b2lkIHJlLWVudHJhbmN5IGlzc3Vlcy4gVGhlIHJlZ2lzdHJ5IGlzIGEgdHJ1c3RlZCBzeXN0ZW0gY29udHJhY3QuAAAAFHNldF92a19mcm9tX3JlZ2lzdHJ5AAAAAgAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAAAAAAJ2awAAAAAH0AAAAA9WZXJpZmljYXRpb25LZXkAAAAAAA==",
        "AAAABQAAAAAAAAAAAAAAFVByb3Bvc2FsQXJjaGl2ZWRFdmVudAAAAAAAAAEAAAAXcHJvcG9zYWxfYXJjaGl2ZWRfZXZlbnQAAAAAAwAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAQAAAAAAAAALcHJvcG9zYWxfaWQAAAAABgAAAAEAAAAAAAAAC2FyY2hpdmVkX2J5AAAAABMAAAAAAAAAAg==",
        "AAAAAAAAAElDcmVhdGUgcHJvcG9zYWwgd2l0aCBhIHNwZWNpZmljIFZLIHZlcnNpb24gKG11c3QgYmUgPD0gY3VycmVudCBhbmQgZXhpc3QpAAAAAAAAH2NyZWF0ZV9wcm9wb3NhbF93aXRoX3ZrX3ZlcnNpb24AAAAABwAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAAAAAAV0aXRsZQAAAAAAABAAAAAAAAAAC2NvbnRlbnRfY2lkAAAAABAAAAAAAAAACGVuZF90aW1lAAAABgAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAl2b3RlX21vZGUAAAAAAAfQAAAACFZvdGVNb2RlAAAAAAAAAAp2a192ZXJzaW9uAAAAAAAEAAAAAQAAAAY=",
        "AAAAAQAAAA1Hcm90aDE2IFByb29mAAAAAAAAAAAAAAVQcm9vZgAAAAAAAAMAAAAAAAAAAWEAAAAAAAPuAAAAQAAAAAAAAAABYgAAAAAAA+4AAACAAAAAAAAAAAFjAAAAAAAD7gAAAEA=",
        "AAAABAAAAAAAAAAAAAAADEdyb3RoMTZFcnJvcgAAAAMAAAAxSUMgdmVjdG9yIGxlbmd0aCBkb2Vzbid0IG1hdGNoIHB1YmxpYyBzaWduYWxzICsgMQAAAAAAABBJY0xlbmd0aE1pc21hdGNoAAAAHgAAAElQdWJsaWMgc2lnbmFsIHZhbHVlID49IEJOMjU0IHNjYWxhciBmaWVsZCBtb2R1bHVzIChpbnZhbGlkIGZpZWxkIGVsZW1lbnQpAAAAAAAAEFNpZ25hbE5vdEluRmllbGQAAAAfAAAAG051bGxpZmllciBpcyB6ZXJvIChpbnZhbGlkKQAAAAAQSW52YWxpZE51bGxpZmllcgAAACA=",
        "AAAAAQAAACJHcm90aDE2IFZlcmlmaWNhdGlvbiBLZXkgZm9yIEJOMjU0AAAAAAAAAAAAD1ZlcmlmaWNhdGlvbktleQAAAAAFAAAAAAAAAAVhbHBoYQAAAAAAA+4AAABAAAAAAAAAAARiZXRhAAAD7gAAAIAAAAAAAAAABWRlbHRhAAAAAAAD7gAAAIAAAAAAAAAABWdhbW1hAAAAAAAD7gAAAIAAAAAAAAAAAmljAAAAAAPqAAAD7gAAAEA=",
      ]),
      options,
    );
  }
  public readonly fromJSON = {
    vote: this.txFromJSON<null>,
    get_vk: this.txFromJSON<VerificationKey>,
    set_vk: this.txFromJSON<null>,
    version: this.txFromJSON<u32>,
    registry: this.txFromJSON<string>,
    vk_version: this.txFromJSON<u32>,
    get_results: this.txFromJSON<readonly [u64, u64]>,
    get_proposal: this.txFromJSON<ProposalInfo>,
    get_vote_mode: this.txFromJSON<VoteMode>,
    tree_contract: this.txFromJSON<string>,
    close_proposal: this.txFromJSON<null>,
    proposal_count: this.txFromJSON<u64>,
    vk_for_version: this.txFromJSON<VerificationKey>,
    create_proposal: this.txFromJSON<u64>,
    archive_proposal: this.txFromJSON<null>,
    get_earliest_idx: this.txFromJSON<u32>,
    get_eligible_root: this.txFromJSON<u256>,
    is_nullifier_used: this.txFromJSON<boolean>,
    set_vk_from_registry: this.txFromJSON<null>,
    create_proposal_with_vk_version: this.txFromJSON<u64>,
  };
}
