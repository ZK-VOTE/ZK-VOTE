import { Buffer } from "buffer";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
} from "@stellar/stellar-sdk/contract";
import type { u32, u64, Option } from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";
export declare const networks: {
  readonly testnet: {
    readonly networkPassphrase: "Test SDF Network ; September 2015";
    readonly contractId: "CCHLRCF47DJFQY6AR2PE3WRDRT7SDKSQJSJUGU77COW7GZMY5YTEUWYX";
  };
};
export type DataKey =
  | {
      tag: "Member";
      values: readonly [u64, string];
    }
  | {
      tag: "Alias";
      values: readonly [u64, string];
    }
  | {
      tag: "Revoked";
      values: readonly [u64, string];
    }
  | {
      tag: "MemberCount";
      values: readonly [u64];
    }
  | {
      tag: "MemberAtIndex";
      values: readonly [u64, u64];
    };
export declare const SbtError: {
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
};
export interface Client {
  /**
   * Construct and simulate a has transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Check if address has SBT for a specific DAO (and is not revoked)
   */
  has: (
    {
      dao_id,
      of,
    }: {
      dao_id: u64;
      of: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<boolean>>;
  /**
   * Construct and simulate a mint transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Mint SBT to address for a specific DAO
   * Only DAO admin can mint (verified via registry)
   * Optionally stores an encrypted alias for the member
   * Can re-mint to previously revoked members
   */
  mint: (
    {
      dao_id,
      to,
      admin,
      encrypted_alias,
    }: {
      dao_id: u64;
      to: string;
      admin: string;
      encrypted_alias: Option<string>;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a leave transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Leave DAO voluntarily (member self-revokes)
   * Sets revocation flag, keeping member entry and alias intact
   */
  leave: (
    {
      dao_id,
      member,
    }: {
      dao_id: u64;
      member: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a revoke transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Revoke an SBT (admin only)
   * Sets revocation flag, keeping member entry and alias intact
   */
  revoke: (
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
   * Construct and simulate a version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Contract version for upgrade tracking.
   */
  version: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>;
  /**
   * Construct and simulate a registry transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get registry address
   */
  registry: (options?: MethodOptions) => Promise<AssembledTransaction<string>>;
  /**
   * Construct and simulate a get_alias transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get encrypted alias for a member (if set)
   */
  get_alias: (
    {
      dao_id,
      member,
    }: {
      dao_id: u64;
      member: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Option<string>>>;
  /**
   * Construct and simulate a self_join transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Self-join a DAO with open membership
   * Allows users to mint their own SBT if the DAO allows open membership
   */
  self_join: (
    {
      dao_id,
      member,
      encrypted_alias,
    }: {
      dao_id: u64;
      member: string;
      encrypted_alias: Option<string>;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a get_members transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get a batch of members for a DAO
   * Returns addresses from offset to offset+limit (or end of list)
   */
  get_members: (
    {
      dao_id,
      offset,
      limit,
    }: {
      dao_id: u64;
      offset: u64;
      limit: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Array<string>>>;
  /**
   * Construct and simulate a update_alias transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Update encrypted alias for a member (admin only)
   */
  update_alias: (
    {
      dao_id,
      member,
      admin,
      new_encrypted_alias,
    }: {
      dao_id: u64;
      member: string;
      admin: string;
      new_encrypted_alias: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a get_member_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get total member count for a DAO
   */
  get_member_count: (
    {
      dao_id,
    }: {
      dao_id: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u64>>;
  /**
   * Construct and simulate a mint_from_registry transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Mint SBT from registry during DAO initialization
   * This function is called by the registry contract during create_and_init_dao
   * to avoid re-entrancy issues. The registry is a trusted system contract.
   */
  mint_from_registry: (
    {
      dao_id,
      to,
    }: {
      dao_id: u64;
      to: string;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
  /**
   * Construct and simulate a get_member_at_index transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get member address at a specific index
   */
  get_member_at_index: (
    {
      dao_id,
      index,
    }: {
      dao_id: u64;
      index: u64;
    },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Option<string>>>;
}
export declare class Client extends ContractClient {
  readonly options: ContractClientOptions;
  static deploy<T = Client>(
    /** Constructor/Initialization Args for the contract's `__constructor` method */
    {
      registry,
    }: {
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
    has: (json: string) => AssembledTransaction<boolean>;
    mint: (json: string) => AssembledTransaction<null>;
    leave: (json: string) => AssembledTransaction<null>;
    revoke: (json: string) => AssembledTransaction<null>;
    version: (json: string) => AssembledTransaction<number>;
    registry: (json: string) => AssembledTransaction<string>;
    get_alias: (json: string) => AssembledTransaction<Option<string>>;
    self_join: (json: string) => AssembledTransaction<null>;
    get_members: (json: string) => AssembledTransaction<string[]>;
    update_alias: (json: string) => AssembledTransaction<null>;
    get_member_count: (json: string) => AssembledTransaction<bigint>;
    mint_from_registry: (json: string) => AssembledTransaction<null>;
    get_member_at_index: (json: string) => AssembledTransaction<Option<string>>;
  };
}
