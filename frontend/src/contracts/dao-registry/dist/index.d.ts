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
    readonly contractId: "CBGK5YFR5544QNHUNR4WKB5ECL75DAY3R4M5UNALA42ZBPKOFNL5RM43";
  };
};
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
export declare const RegistryError: {
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
    {
      dao_id,
    }: {
      dao_id: u64;
    },
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
    {
      dao_id,
      name,
      admin,
    }: {
      dao_id: u64;
      name: string;
      admin: string;
    },
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
    {
      dao_id,
    }: {
      dao_id: u64;
    },
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
    {
      dao_id,
    }: {
      dao_id: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<boolean>>;
  /**
   * Construct and simulate a transfer_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfer admin rights (current admin only)
   */
  transfer_admin: (
    {
      dao_id,
      new_admin,
    }: {
      dao_id: u64;
      new_admin: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a get_metadata_cid transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get DAO metadata CID
   */
  get_metadata_cid: (
    {
      dao_id,
    }: {
      dao_id: u64;
    },
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
    }: {
      dao_id: u64;
      metadata_cid: Option<string>;
      admin: string;
    },
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
    }: {
      dao_id: u64;
      members_can_propose: boolean;
      admin: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a is_membership_open transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Check if a DAO has open membership
   */
  is_membership_open: (
    {
      dao_id,
    }: {
      dao_id: u64;
    },
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
    {
      dao_id,
    }: {
      dao_id: u64;
    },
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
    }: {
      dao_id: u64;
      membership_open: boolean;
      admin: string;
    },
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
export declare class Client extends ContractClient {
  readonly options: ContractClientOptions;
  static deploy<T = Client>(
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
    get_dao: (json: string) => AssembledTransaction<DaoInfo>;
    version: (json: string) => AssembledTransaction<number>;
    set_name: (json: string) => AssembledTransaction<null>;
    dao_count: (json: string) => AssembledTransaction<bigint>;
    get_admin: (json: string) => AssembledTransaction<string>;
    create_dao: (json: string) => AssembledTransaction<bigint>;
    dao_exists: (json: string) => AssembledTransaction<boolean>;
    transfer_admin: (json: string) => AssembledTransaction<null>;
    get_metadata_cid: (json: string) => AssembledTransaction<Option<string>>;
    set_metadata_cid: (json: string) => AssembledTransaction<null>;
    set_proposal_mode: (json: string) => AssembledTransaction<null>;
    is_membership_open: (json: string) => AssembledTransaction<boolean>;
    create_and_init_dao: (json: string) => AssembledTransaction<bigint>;
    members_can_propose: (json: string) => AssembledTransaction<boolean>;
    set_membership_open: (json: string) => AssembledTransaction<null>;
    create_and_init_dao_no_reg: (json: string) => AssembledTransaction<bigint>;
  };
}
