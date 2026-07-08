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
    contractId: "CBGK5YFR5544QNHUNR4WKB5ECL75DAY3R4M5UNALA42ZBPKOFNL5RM43",
  },
} as const;

export interface DaoInfo {
  admin: string;
  created_at: u64;
  id: u64;
  /**
   * If true, any member can create proposals. If false, only admin can create proposals.
   */
  members_can_propose: boolean;
  membership_open: boolean;
  /**
   * IPFS CID for extended metadata (description, images, links)
   */
  metadata_cid: Option<string>;
  name: string;
}

export const RegistryError = {
  1: { message: "NameTooLong" },
  2: { message: "DaoNotFound" },
  3: { message: "NotAdmin" },
  4: { message: "MetadataCidTooLong" },
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
   * Construct and simulate a get_dao transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get DAO info
   */
  get_dao: (
    { dao_id }: { dao_id: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<DaoInfo>>;

  /**
   * Construct and simulate a version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Contract version for upgrade tracking.
   */
  version: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>;

  /**
   * Construct and simulate a set_name transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set DAO name (admin only). Max 100 characters.
   */
  set_name: (
    { dao_id, name, admin }: { dao_id: u64; name: string; admin: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;

  /**
   * Construct and simulate a dao_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get total number of DAOs created
   */
  dao_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>;

  /**
   * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get admin of a DAO
   */
  get_admin: (
    { dao_id }: { dao_id: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<string>>;

  /**
   * Construct and simulate a create_dao transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Create a new DAO (permissionless).
   * Creator automatically becomes the admin.
   * Cannot create DAOs for other people - you can only create your own DAO.
   * - `members_can_propose`: if true, any member can create proposals; if false, only admin
   * - `metadata_cid`: optional IPFS CID for extended metadata (description, images, links)
   */
  create_dao: (
    {
      name,
      creator,
      membership_open,
      members_can_propose,
      metadata_cid,
    }: {
      name: string;
      creator: string;
      membership_open: boolean;
      members_can_propose: boolean;
      metadata_cid: Option<string>;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u64>>;

  /**
   * Construct and simulate a dao_exists transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Check if DAO exists
   */
  dao_exists: (
    { dao_id }: { dao_id: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<boolean>>;

  /**
   * Construct and simulate a transfer_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfer admin rights (current admin only)
   */
  transfer_admin: (
    { dao_id, new_admin }: { dao_id: u64; new_admin: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;

  /**
   * Construct and simulate a get_metadata_cid transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get DAO metadata CID
   */
  get_metadata_cid: (
    { dao_id }: { dao_id: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Option<string>>>;

  /**
   * Construct and simulate a set_metadata_cid transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set DAO metadata CID (admin only).
   * The CID points to IPFS JSON with description, images, and links.
   * Pass None to clear metadata.
   */
  set_metadata_cid: (
    {
      dao_id,
      metadata_cid,
      admin,
    }: { dao_id: u64; metadata_cid: Option<string>; admin: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;

  /**
   * Construct and simulate a set_proposal_mode transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set proposal mode (admin only).
   * If `members_can_propose` is true, any member can create proposals.
   * If false, only the DAO admin can create proposals.
   */
  set_proposal_mode: (
    {
      dao_id,
      members_can_propose,
      admin,
    }: { dao_id: u64; members_can_propose: boolean; admin: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;

  /**
   * Construct and simulate a is_membership_open transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Check if a DAO has open membership
   */
  is_membership_open: (
    { dao_id }: { dao_id: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<boolean>>;

  /**
   * Construct and simulate a create_and_init_dao transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Create and fully initialize a DAO in a single transaction.
   * This calls:
   * 1. create_dao (creates registry entry)
   * 2. membership_sbt.mint (mints SBT to creator)
   * 3. membership_tree.init_tree (initializes Merkle tree)
   * 4. membership_tree.register_from_registry (registers creator's commitment)
   * 5. voting.set_vk (sets verification key)
   * Note: metadata_cid must be set separately via set_metadata_cid (10-param limit)
   */
  create_and_init_dao: (
    {
      name,
      creator,
      membership_open,
      members_can_propose,
      sbt_contract,
      tree_contract,
      voting_contract,
      tree_depth,
      creator_commitment,
      vk,
    }: {
      name: string;
      creator: string;
      membership_open: boolean;
      members_can_propose: boolean;
      sbt_contract: string;
      tree_contract: string;
      voting_contract: string;
      tree_depth: u32;
      creator_commitment: u256;
      vk: VerificationKey;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u64>>;

  /**
   * Construct and simulate a members_can_propose transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Check if members can create proposals (vs admin-only)
   */
  members_can_propose: (
    { dao_id }: { dao_id: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<boolean>>;

  /**
   * Construct and simulate a set_membership_open transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set membership open/closed (admin only).
   * If `membership_open` is true, users can join (mint SBT) themselves.
   * If false, only the admin can add members.
   */
  set_membership_open: (
    {
      dao_id,
      membership_open,
      admin,
    }: { dao_id: u64; membership_open: boolean; admin: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;

  /**
   * Construct and simulate a create_and_init_dao_no_reg transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Create and initialize DAO without registering creator for voting.
   * Creator must register separately using deterministic credentials.
   * This calls:
   * 1. create_dao (creates registry entry)
   * 2. membership_sbt.mint (mints SBT to creator)
   * 3. membership_tree.init_tree (initializes Merkle tree)
   * 4. voting.set_vk (sets verification key)
   */
  create_and_init_dao_no_reg: (
    {
      name,
      creator,
      membership_open,
      members_can_propose,
      metadata_cid,
      sbt_contract,
      tree_contract,
      voting_contract,
      tree_depth,
      vk,
    }: {
      name: string;
      creator: string;
      membership_open: boolean;
      members_can_propose: boolean;
      metadata_cid: Option<string>;
      sbt_contract: string;
      tree_contract: string;
      voting_contract: string;
      tree_depth: u32;
      vk: VerificationKey;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u64>>;
}
export class Client extends ContractClient {
  static async deploy<T = Client>(
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
    return ContractClient.deploy(null, options);
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([
        "AAAAAQAAAAAAAAAAAAAAB0Rhb0luZm8AAAAABwAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAApjcmVhdGVkX2F0AAAAAAAGAAAAAAAAAAJpZAAAAAAABgAAAFRJZiB0cnVlLCBhbnkgbWVtYmVyIGNhbiBjcmVhdGUgcHJvcG9zYWxzLiBJZiBmYWxzZSwgb25seSBhZG1pbiBjYW4gY3JlYXRlIHByb3Bvc2Fscy4AAAATbWVtYmVyc19jYW5fcHJvcG9zZQAAAAABAAAAAAAAAA9tZW1iZXJzaGlwX29wZW4AAAAAAQAAADtJUEZTIENJRCBmb3IgZXh0ZW5kZWQgbWV0YWRhdGEgKGRlc2NyaXB0aW9uLCBpbWFnZXMsIGxpbmtzKQAAAAAMbWV0YWRhdGFfY2lkAAAD6AAAABAAAAAAAAAABG5hbWUAAAAQ",
        "AAAAAAAAAAxHZXQgREFPIGluZm8AAAAHZ2V0X2RhbwAAAAABAAAAAAAAAAZkYW9faWQAAAAAAAYAAAABAAAH0AAAAAdEYW9JbmZvAA==",
        "AAAAAAAAACZDb250cmFjdCB2ZXJzaW9uIGZvciB1cGdyYWRlIHRyYWNraW5nLgAAAAAAB3ZlcnNpb24AAAAAAAAAAAEAAAAE",
        "AAAAAAAAAC5TZXQgREFPIG5hbWUgKGFkbWluIG9ubHkpLiBNYXggMTAwIGNoYXJhY3RlcnMuAAAAAAAIc2V0X25hbWUAAAADAAAAAAAAAAZkYW9faWQAAAAAAAYAAAAAAAAABG5hbWUAAAAQAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAA",
        "AAAABAAAAAAAAAAAAAAADVJlZ2lzdHJ5RXJyb3IAAAAAAAAEAAAAAAAAAAtOYW1lVG9vTG9uZwAAAAABAAAAAAAAAAtEYW9Ob3RGb3VuZAAAAAACAAAAAAAAAAhOb3RBZG1pbgAAAAMAAAAAAAAAEk1ldGFkYXRhQ2lkVG9vTG9uZwAAAAAABA==",
        "AAAAAAAAACBHZXQgdG90YWwgbnVtYmVyIG9mIERBT3MgY3JlYXRlZAAAAAlkYW9fY291bnQAAAAAAAAAAAAAAQAAAAY=",
        "AAAAAAAAABJHZXQgYWRtaW4gb2YgYSBEQU8AAAAAAAlnZXRfYWRtaW4AAAAAAAABAAAAAAAAAAZkYW9faWQAAAAAAAYAAAABAAAAEw==",
        "AAAAAAAAAUJDcmVhdGUgYSBuZXcgREFPIChwZXJtaXNzaW9ubGVzcykuCkNyZWF0b3IgYXV0b21hdGljYWxseSBiZWNvbWVzIHRoZSBhZG1pbi4KQ2Fubm90IGNyZWF0ZSBEQU9zIGZvciBvdGhlciBwZW9wbGUgLSB5b3UgY2FuIG9ubHkgY3JlYXRlIHlvdXIgb3duIERBTy4KLSBgbWVtYmVyc19jYW5fcHJvcG9zZWA6IGlmIHRydWUsIGFueSBtZW1iZXIgY2FuIGNyZWF0ZSBwcm9wb3NhbHM7IGlmIGZhbHNlLCBvbmx5IGFkbWluCi0gYG1ldGFkYXRhX2NpZGA6IG9wdGlvbmFsIElQRlMgQ0lEIGZvciBleHRlbmRlZCBtZXRhZGF0YSAoZGVzY3JpcHRpb24sIGltYWdlcywgbGlua3MpAAAAAAAKY3JlYXRlX2RhbwAAAAAABQAAAAAAAAAEbmFtZQAAABAAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAAAAAAPbWVtYmVyc2hpcF9vcGVuAAAAAAEAAAAAAAAAE21lbWJlcnNfY2FuX3Byb3Bvc2UAAAAAAQAAAAAAAAAMbWV0YWRhdGFfY2lkAAAD6AAAABAAAAABAAAABg==",
        "AAAAAAAAABNDaGVjayBpZiBEQU8gZXhpc3RzAAAAAApkYW9fZXhpc3RzAAAAAAABAAAAAAAAAAZkYW9faWQAAAAAAAYAAAABAAAAAQ==",
        "AAAABQAAAAAAAAAAAAAADkFkbWluWGZlckV2ZW50AAAAAAABAAAAEGFkbWluX3hmZXJfZXZlbnQAAAADAAAAAAAAAAZkYW9faWQAAAAAAAYAAAABAAAAAAAAAAlvbGRfYWRtaW4AAAAAAAATAAAAAAAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADkRhb0NyZWF0ZUV2ZW50AAAAAAABAAAAEGRhb19jcmVhdGVfZXZlbnQAAAADAAAAAAAAAAZkYW9faWQAAAAAAAYAAAABAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAAAAAAAARuYW1lAAAAEAAAAAAAAAAC",
        "AAAAAQAAACJHcm90aDE2IFZlcmlmaWNhdGlvbiBLZXkgZm9yIEJOMjU0AAAAAAAAAAAAD1ZlcmlmaWNhdGlvbktleQAAAAAFAAAAAAAAAAVhbHBoYQAAAAAAA+4AAABAAAAAAAAAAARiZXRhAAAD7gAAAIAAAAAAAAAABWRlbHRhAAAAAAAD7gAAAIAAAAAAAAAABWdhbW1hAAAAAAAD7gAAAIAAAAAAAAAAAmljAAAAAAPqAAAD7gAAAEA=",
        "AAAABQAAAAAAAAAAAAAAEENvbnRyYWN0VXBncmFkZWQAAAABAAAAEWNvbnRyYWN0X3VwZ3JhZGVkAAAAAAAAAgAAAAAAAAAEZnJvbQAAAAQAAAAAAAAAAAAAAAJ0bwAAAAAABAAAAAAAAAAC",
        "AAAAAAAAACpUcmFuc2ZlciBhZG1pbiByaWdodHMgKGN1cnJlbnQgYWRtaW4gb25seSkAAAAAAA50cmFuc2Zlcl9hZG1pbgAAAAAAAgAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAAAAAAluZXdfYWRtaW4AAAAAAAATAAAAAA==",
        "AAAAAAAAABRHZXQgREFPIG1ldGFkYXRhIENJRAAAABBnZXRfbWV0YWRhdGFfY2lkAAAAAQAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAQAAA+gAAAAQ",
        "AAAAAAAAAIBTZXQgREFPIG1ldGFkYXRhIENJRCAoYWRtaW4gb25seSkuClRoZSBDSUQgcG9pbnRzIHRvIElQRlMgSlNPTiB3aXRoIGRlc2NyaXB0aW9uLCBpbWFnZXMsIGFuZCBsaW5rcy4KUGFzcyBOb25lIHRvIGNsZWFyIG1ldGFkYXRhLgAAABBzZXRfbWV0YWRhdGFfY2lkAAAAAwAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAAAAAAxtZXRhZGF0YV9jaWQAAAPoAAAAEAAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAA==",
        "AAAAAAAAAJVTZXQgcHJvcG9zYWwgbW9kZSAoYWRtaW4gb25seSkuCklmIGBtZW1iZXJzX2Nhbl9wcm9wb3NlYCBpcyB0cnVlLCBhbnkgbWVtYmVyIGNhbiBjcmVhdGUgcHJvcG9zYWxzLgpJZiBmYWxzZSwgb25seSB0aGUgREFPIGFkbWluIGNhbiBjcmVhdGUgcHJvcG9zYWxzLgAAAAAAABFzZXRfcHJvcG9zYWxfbW9kZQAAAAAAAAMAAAAAAAAABmRhb19pZAAAAAAABgAAAAAAAAATbWVtYmVyc19jYW5fcHJvcG9zZQAAAAABAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAA",
        "AAAAAAAAACJDaGVjayBpZiBhIERBTyBoYXMgb3BlbiBtZW1iZXJzaGlwAAAAAAASaXNfbWVtYmVyc2hpcF9vcGVuAAAAAAABAAAAAAAAAAZkYW9faWQAAAAAAAYAAAABAAAAAQ==",
        "AAAAAAAAAZZDcmVhdGUgYW5kIGZ1bGx5IGluaXRpYWxpemUgYSBEQU8gaW4gYSBzaW5nbGUgdHJhbnNhY3Rpb24uClRoaXMgY2FsbHM6CjEuIGNyZWF0ZV9kYW8gKGNyZWF0ZXMgcmVnaXN0cnkgZW50cnkpCjIuIG1lbWJlcnNoaXBfc2J0Lm1pbnQgKG1pbnRzIFNCVCB0byBjcmVhdG9yKQozLiBtZW1iZXJzaGlwX3RyZWUuaW5pdF90cmVlIChpbml0aWFsaXplcyBNZXJrbGUgdHJlZSkKNC4gbWVtYmVyc2hpcF90cmVlLnJlZ2lzdGVyX2Zyb21fcmVnaXN0cnkgKHJlZ2lzdGVycyBjcmVhdG9yJ3MgY29tbWl0bWVudCkKNS4gdm90aW5nLnNldF92ayAoc2V0cyB2ZXJpZmljYXRpb24ga2V5KQpOb3RlOiBtZXRhZGF0YV9jaWQgbXVzdCBiZSBzZXQgc2VwYXJhdGVseSB2aWEgc2V0X21ldGFkYXRhX2NpZCAoMTAtcGFyYW0gbGltaXQpAAAAAAATY3JlYXRlX2FuZF9pbml0X2RhbwAAAAAKAAAAAAAAAARuYW1lAAAAEAAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAA9tZW1iZXJzaGlwX29wZW4AAAAAAQAAAAAAAAATbWVtYmVyc19jYW5fcHJvcG9zZQAAAAABAAAAAAAAAAxzYnRfY29udHJhY3QAAAATAAAAAAAAAA10cmVlX2NvbnRyYWN0AAAAAAAAEwAAAAAAAAAPdm90aW5nX2NvbnRyYWN0AAAAABMAAAAAAAAACnRyZWVfZGVwdGgAAAAAAAQAAAAAAAAAEmNyZWF0b3JfY29tbWl0bWVudAAAAAAADAAAAAAAAAACdmsAAAAAB9AAAAAPVmVyaWZpY2F0aW9uS2V5AAAAAAEAAAAG",
        "AAAAAAAAADVDaGVjayBpZiBtZW1iZXJzIGNhbiBjcmVhdGUgcHJvcG9zYWxzICh2cyBhZG1pbi1vbmx5KQAAAAAAABNtZW1iZXJzX2Nhbl9wcm9wb3NlAAAAAAEAAAAAAAAABmRhb19pZAAAAAAABgAAAAEAAAAB",
        "AAAAAAAAAJZTZXQgbWVtYmVyc2hpcCBvcGVuL2Nsb3NlZCAoYWRtaW4gb25seSkuCklmIGBtZW1iZXJzaGlwX29wZW5gIGlzIHRydWUsIHVzZXJzIGNhbiBqb2luIChtaW50IFNCVCkgdGhlbXNlbHZlcy4KSWYgZmFsc2UsIG9ubHkgdGhlIGFkbWluIGNhbiBhZGQgbWVtYmVycy4AAAAAABNzZXRfbWVtYmVyc2hpcF9vcGVuAAAAAAMAAAAAAAAABmRhb19pZAAAAAAABgAAAAAAAAAPbWVtYmVyc2hpcF9vcGVuAAAAAAEAAAAAAAAABWFkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAAURDcmVhdGUgYW5kIGluaXRpYWxpemUgREFPIHdpdGhvdXQgcmVnaXN0ZXJpbmcgY3JlYXRvciBmb3Igdm90aW5nLgpDcmVhdG9yIG11c3QgcmVnaXN0ZXIgc2VwYXJhdGVseSB1c2luZyBkZXRlcm1pbmlzdGljIGNyZWRlbnRpYWxzLgpUaGlzIGNhbGxzOgoxLiBjcmVhdGVfZGFvIChjcmVhdGVzIHJlZ2lzdHJ5IGVudHJ5KQoyLiBtZW1iZXJzaGlwX3NidC5taW50IChtaW50cyBTQlQgdG8gY3JlYXRvcikKMy4gbWVtYmVyc2hpcF90cmVlLmluaXRfdHJlZSAoaW5pdGlhbGl6ZXMgTWVya2xlIHRyZWUpCjQuIHZvdGluZy5zZXRfdmsgKHNldHMgdmVyaWZpY2F0aW9uIGtleSkAAAAaY3JlYXRlX2FuZF9pbml0X2Rhb19ub19yZWcAAAAAAAoAAAAAAAAABG5hbWUAAAAQAAAAAAAAAAdjcmVhdG9yAAAAABMAAAAAAAAAD21lbWJlcnNoaXBfb3BlbgAAAAABAAAAAAAAABNtZW1iZXJzX2Nhbl9wcm9wb3NlAAAAAAEAAAAAAAAADG1ldGFkYXRhX2NpZAAAA+gAAAAQAAAAAAAAAAxzYnRfY29udHJhY3QAAAATAAAAAAAAAA10cmVlX2NvbnRyYWN0AAAAAAAAEwAAAAAAAAAPdm90aW5nX2NvbnRyYWN0AAAAABMAAAAAAAAACnRyZWVfZGVwdGgAAAAAAAQAAAAAAAAAAnZrAAAAAAfQAAAAD1ZlcmlmaWNhdGlvbktleQAAAAABAAAABg==",
      ]),
      options,
    );
  }
  public readonly fromJSON = {
    get_dao: this.txFromJSON<DaoInfo>,
    version: this.txFromJSON<u32>,
    set_name: this.txFromJSON<null>,
    dao_count: this.txFromJSON<u64>,
    get_admin: this.txFromJSON<string>,
    create_dao: this.txFromJSON<u64>,
    dao_exists: this.txFromJSON<boolean>,
    transfer_admin: this.txFromJSON<null>,
    get_metadata_cid: this.txFromJSON<Option<string>>,
    set_metadata_cid: this.txFromJSON<null>,
    set_proposal_mode: this.txFromJSON<null>,
    is_membership_open: this.txFromJSON<boolean>,
    create_and_init_dao: this.txFromJSON<u64>,
    members_can_propose: this.txFromJSON<boolean>,
    set_membership_open: this.txFromJSON<null>,
    create_and_init_dao_no_reg: this.txFromJSON<u64>,
  };
}
