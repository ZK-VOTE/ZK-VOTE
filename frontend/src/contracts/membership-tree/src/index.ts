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
    contractId: "CAZC3WSRGE3PI6AZ3NHRKIZFVBEOOLFDP7RD6BMHIMRYV4VEYC42ARQZ",
  },
} as const;

export type DataKey =
  | { tag: "TreeDepth"; values: readonly [u64] }
  | { tag: "NextLeafIndex"; values: readonly [u64] }
  | { tag: "FilledSubtrees"; values: readonly [u64] }
  | { tag: "Roots"; values: readonly [u64] }
  | { tag: "LeafIndex"; values: readonly [u64, u256] }
  | { tag: "MemberLeafIndex"; values: readonly [u64, string] }
  | { tag: "LeafValue"; values: readonly [u64, u32] }
  | { tag: "NextRootIndex"; values: readonly [u64] }
  | { tag: "RootIndex"; values: readonly [u64, u256] }
  | { tag: "RevokedAt"; values: readonly [u64, u256] }
  | { tag: "ReinstatedAt"; values: readonly [u64, u256] }
  | { tag: "NodeHash"; values: readonly [u64, u32, u32] }
  | { tag: "MinValidRootIdx"; values: readonly [u64] };

export const TreeError = {
  1: { message: "NotAdmin" },
  2: { message: "InvalidDepth" },
  3: { message: "TreeInitialized" },
  4: { message: "TreeNotInitialized" },
  5: { message: "CommitmentExists" },
  6: { message: "MemberExists" },
  7: { message: "TreeFull" },
  8: { message: "NoSbt" },
  9: { message: "NotOpenMembership" },
  10: { message: "LeafOutOfBounds" },
  11: { message: "MemberRemoved" },
  12: { message: "MemberNotInTree" },
  13: { message: "RootNotFound" },
  14: { message: "AlreadyInitialized" },
  15: { message: "MemberNotRevoked" },
};

export interface Client {
  /**
   * Construct and simulate a root_ok transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Check if a root is valid (in history)
   */
  root_ok: (
    { dao_id, root }: { dao_id: u64; root: u256 },
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
    { dao_id }: { dao_id: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u32>>;

  /**
   * Construct and simulate a get_root transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get current root (short alias for cross-contract calls)
   */
  get_root: (
    { dao_id }: { dao_id: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u256>>;

  /**
   * Construct and simulate a min_root transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get the minimum valid root index for a DAO
   * Roots with index < min_valid_root_index are invalid for Trailing mode proposals
   * Returns 0 if no members have been removed
   */
  min_root: (
    { dao_id }: { dao_id: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u32>>;

  /**
   * Construct and simulate a revok_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get revocation timestamp for a commitment (returns None if never revoked)
   * Used by voting contract to check if member was revoked
   */
  revok_at: (
    { dao_id, commitment }: { dao_id: u64; commitment: u256 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<Option<u64>>>;

  /**
   * Construct and simulate a root_idx transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get root index for a specific root (for vote mode validation)
   */
  root_idx: (
    { dao_id, root }: { dao_id: u64; root: u256 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u32>>;

  /**
   * Construct and simulate a init_tree transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Initialize a tree for a specific DAO
   * Only DAO admin can initialize (via SBT contract which checks registry)
   */
  init_tree: (
    { dao_id, depth, admin }: { dao_id: u64; depth: u32; admin: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;

  /**
   * Construct and simulate a reinst_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get reinstatement timestamp for a commitment (returns None if never reinstated)
   * Used by voting contract to check if member was reinstated after revocation
   */
  reinst_at: (
    { dao_id, commitment }: { dao_id: u64; commitment: u256 },
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
    { dao_id }: { dao_id: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<u256>>;

  /**
   * Construct and simulate a get_tree_info transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get tree info for a DAO
   */
  get_tree_info: (
    { dao_id }: { dao_id: u64 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<readonly [u32, u32, u256]>>;

  /**
   * Construct and simulate a remove_member transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Remove a member by zeroing their leaf and recomputing the root
   * Only callable by DAO admin
   * This zeros the leaf in the Merkle tree, preventing proofs against new roots
   */
  remove_member: (
    { dao_id, member, admin }: { dao_id: u64; member: string; admin: string },
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
    }: { dao_id: u64; commitment: u256; member: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;

  /**
   * Construct and simulate a get_leaf_index transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get leaf index for a commitment
   */
  get_leaf_index: (
    { dao_id, commitment }: { dao_id: u64; commitment: u256 },
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
    { dao_id, leaf_index }: { dao_id: u64; leaf_index: u32 },
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
    { dao_id, member, admin }: { dao_id: u64; member: string; admin: string },
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
    }: { dao_id: u64; commitment: u256; caller: string },
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
    }: { dao_id: u64; commitment: u256; member: string },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;

  /**
   * Construct and simulate a init_tree_from_registry transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Initialize tree from registry during DAO initialization
   * This function is called by the registry contract during create_and_init_dao
   * to avoid re-entrancy issues. The registry is a trusted system contract.
   */
  init_tree_from_registry: (
    { dao_id, depth }: { dao_id: u64; depth: u32 },
    options?: MethodOptions,
  ) => Promise<AssembledTransaction<null>>;
}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Constructor/Initialization Args for the contract's `__constructor` method */
    { sbt_contract, registry }: { sbt_contract: string; registry: string },
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
    return ContractClient.deploy({ sbt_contract, registry }, options);
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([
        "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",
        "AAAAAAAAAKRHZXQgdGhlIG1pbmltdW0gdmFsaWQgcm9vdCBpbmRleCBmb3IgYSBEQU8KUm9vdHMgd2l0aCBpbmRleCA8IG1pbl92YWxpZF9yb290X2luZGV4IGFyZSBpbnZhbGlkIGZvciBUcmFpbGluZyBtb2RlIHByb3Bvc2FscwpSZXR1cm5zIDAgaWYgbm8gbWVtYmVycyBoYXZlIGJlZW4gcmVtb3ZlZAAAAAhtaW5fcm9vdAAAAAEAAAAAAAAABmRhb19pZAAAAAAABgAAAAEAAAAE",
        "AAAAAAAAAIBHZXQgcmV2b2NhdGlvbiB0aW1lc3RhbXAgZm9yIGEgY29tbWl0bWVudCAocmV0dXJucyBOb25lIGlmIG5ldmVyIHJldm9rZWQpClVzZWQgYnkgdm90aW5nIGNvbnRyYWN0IHRvIGNoZWNrIGlmIG1lbWJlciB3YXMgcmV2b2tlZAAAAAhyZXZva19hdAAAAAIAAAAAAAAABmRhb19pZAAAAAAABgAAAAAAAAAKY29tbWl0bWVudAAAAAAADAAAAAEAAAPoAAAABg==",
        "AAAAAAAAAD1HZXQgcm9vdCBpbmRleCBmb3IgYSBzcGVjaWZpYyByb290IChmb3Igdm90ZSBtb2RlIHZhbGlkYXRpb24pAAAAAAAACHJvb3RfaWR4AAAAAgAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAAAAAARyb290AAAADAAAAAEAAAAE",
        "AAAAAAAAAGtJbml0aWFsaXplIGEgdHJlZSBmb3IgYSBzcGVjaWZpYyBEQU8KT25seSBEQU8gYWRtaW4gY2FuIGluaXRpYWxpemUgKHZpYSBTQlQgY29udHJhY3Qgd2hpY2ggY2hlY2tzIHJlZ2lzdHJ5KQAAAAAJaW5pdF90cmVlAAAAAAAAAwAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAAAAAAVkZXB0aAAAAAAAAAQAAAAAAAAABWFkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAAJpHZXQgcmVpbnN0YXRlbWVudCB0aW1lc3RhbXAgZm9yIGEgY29tbWl0bWVudCAocmV0dXJucyBOb25lIGlmIG5ldmVyIHJlaW5zdGF0ZWQpClVzZWQgYnkgdm90aW5nIGNvbnRyYWN0IHRvIGNoZWNrIGlmIG1lbWJlciB3YXMgcmVpbnN0YXRlZCBhZnRlciByZXZvY2F0aW9uAAAAAAAJcmVpbnN0X2F0AAAAAAAAAgAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAAAAAApjb21taXRtZW50AAAAAAAMAAAAAQAAA+gAAAAG",
        "AAAAAAAAABhHZXQgU0JUIGNvbnRyYWN0IGFkZHJlc3MAAAAJc2J0X2NvbnRyAAAAAAAAAAAAAAEAAAAT",
        "AAAABQAAAAAAAAAAAAAAEENvbnRyYWN0VXBncmFkZWQAAAABAAAAEWNvbnRyYWN0X3VwZ3JhZGVkAAAAAAAAAgAAAAAAAAAEZnJvbQAAAAQAAAAAAAAAAAAAAAJ0bwAAAAAABAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAElJlaW5zdGF0ZW1lbnRFdmVudAAAAAAAAQAAABNyZWluc3RhdGVtZW50X2V2ZW50AAAAAAMAAAAAAAAABmRhb19pZAAAAAAABgAAAAEAAAAAAAAABm1lbWJlcgAAAAAAEwAAAAEAAAAAAAAADXJlaW5zdGF0ZWRfYXQAAAAAAAAGAAAAAAAAAAI=",
        "AAAAAAAAABpHZXQgY3VycmVudCByb290IGZvciBhIERBTwAAAAAADGN1cnJlbnRfcm9vdAAAAAEAAAAAAAAABmRhb19pZAAAAAAABgAAAAEAAAAM",
        "AAAAAAAAAJRDb25zdHJ1Y3RvcjogSW5pdGlhbGl6ZSBjb250cmFjdCB3aXRoIFNCVCBjb250cmFjdCBhZGRyZXNzCkFsc28gcHJlLWNvbXB1dGVzIHplcm9zIGNhY2hlIHRvIGF2b2lkIGV4cGVuc2l2ZSBpbml0aWFsaXphdGlvbiBkdXJpbmcgZmlyc3QgREFPIGNyZWF0aW9uAAAADV9fY29uc3RydWN0b3IAAAAAAAACAAAAAAAAAAxzYnRfY29udHJhY3QAAAATAAAAAAAAAAhyZWdpc3RyeQAAABMAAAAA",
        "AAAAAAAAABdHZXQgdHJlZSBpbmZvIGZvciBhIERBTwAAAAANZ2V0X3RyZWVfaW5mbwAAAAAAAAEAAAAAAAAABmRhb19pZAAAAAAABgAAAAEAAAPtAAAAAwAAAAQAAAAEAAAADA==",
        "AAAAAAAAAKVSZW1vdmUgYSBtZW1iZXIgYnkgemVyb2luZyB0aGVpciBsZWFmIGFuZCByZWNvbXB1dGluZyB0aGUgcm9vdApPbmx5IGNhbGxhYmxlIGJ5IERBTyBhZG1pbgpUaGlzIHplcm9zIHRoZSBsZWFmIGluIHRoZSBNZXJrbGUgdHJlZSwgcHJldmVudGluZyBwcm9vZnMgYWdhaW5zdCBuZXcgcm9vdHMAAAAAAAANcmVtb3ZlX21lbWJlcgAAAAAAAAMAAAAAAAAABmRhb19pZAAAAAAABgAAAAAAAAAGbWVtYmVyAAAAAAATAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAA",
        "AAAAAAAAAIZTZWxmLXJlZ2lzdGVyIGEgY29tbWl0bWVudCBpbiBhIHB1YmxpYyBEQU8gKHJlcXVpcmVzIFNCVCBtZW1iZXJzaGlwKQpGb3IgcHVibGljIERBT3MsIGFueW9uZSB3aXRoIGFuIFNCVCBjYW4gcmVnaXN0ZXIgdGhlaXIgY29tbWl0bWVudAAAAAAADXNlbGZfcmVnaXN0ZXIAAAAAAAADAAAAAAAAAAZkYW9faWQAAAAAAAYAAAAAAAAACmNvbW1pdG1lbnQAAAAAAAwAAAAAAAAABm1lbWJlcgAAAAAAEwAAAAA=",
        "AAAAAAAAAB9HZXQgbGVhZiBpbmRleCBmb3IgYSBjb21taXRtZW50AAAAAA5nZXRfbGVhZl9pbmRleAAAAAAAAgAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAAAAAApjb21taXRtZW50AAAAAAAMAAAAAQAAAAQ=",
        "AAAAAAAAAVJHZXQgTWVya2xlIHBhdGggZm9yIGEgc3BlY2lmaWMgbGVhZiBpbmRleApSZXR1cm5zIChwYXRoRWxlbWVudHMsIHBhdGhJbmRpY2VzKSB3aGVyZToKLSBwYXRoRWxlbWVudHNbaV0gaXMgdGhlIHNpYmxpbmcgaGFzaCBhdCBsZXZlbCBpCi0gcGF0aEluZGljZXNbaV0gaXMgMCBpZiBsZWFmIGlzIGxlZnQgY2hpbGQsIDEgaWYgcmlnaHQgY2hpbGQKClRoaXMgb3B0aW1pemVkIHZlcnNpb24gcmVhZHMgc3RvcmVkIG5vZGUgaGFzaGVzIGRpcmVjdGx5IChPKGRlcHRoKSByZWFkcykKaW5zdGVhZCBvZiByZWNvbnN0cnVjdGluZyBzdWJ0cmVlcyAod2hpY2ggd2FzIE8obiAqIGxvZyBuKSBoYXNoZXMpLgAAAAAAD2dldF9tZXJrbGVfcGF0aAAAAAACAAAAAAAAAAZkYW9faWQAAAAAAAYAAAAAAAAACmxlYWZfaW5kZXgAAAAAAAQAAAABAAAD7QAAAAIAAAPqAAAADAAAA+oAAAAE",
        "AAAAAAAAAKpQcmUtaW5pdGlhbGl6ZSB0aGUgemVyb3MgY2FjaGUgdG8gYXZvaWQgYnVkZ2V0IGlzc3VlcyBkdXJpbmcgZmlyc3QgdHJlZSBvcGVyYXRpb25zLgpUaGlzIHNob3VsZCBiZSBjYWxsZWQgb25jZSBkdXJpbmcgZGVwbG95bWVudCB0byBwcmVjb21wdXRlIHplcm8gdmFsdWVzIGZvciBhbGwgbGV2ZWxzLgAAAAAAEGluaXRfemVyb3NfY2FjaGUAAAAAAAAAAA==",
        "AAAAAAAAALtSZWluc3RhdGUgYSBwcmV2aW91c2x5IHJlbW92ZWQgbWVtYmVyCkNsZWFycyB0aGVpciBsZWFmIGluZGV4IG1hcHBpbmcgc28gdGhleSBjYW4gcmUtcmVnaXN0ZXIgd2l0aCBhIG5ldyBjb21taXRtZW50ClRoZSBhZG1pbiBzaG91bGQgYWxzbyByZS1taW50IHRoZWlyIFNCVCB2aWEgdGhlIG1lbWJlcnNoaXAtc2J0IGNvbnRyYWN0AAAAABByZWluc3RhdGVfbWVtYmVyAAAAAwAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAAAAAAZtZW1iZXIAAAAAABMAAAAAAAAABWFkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAAERSZWdpc3RlciBhIGNvbW1pdG1lbnQgd2l0aCBleHBsaWNpdCBjYWxsZXIgKHJlcXVpcmVzIFNCVCBtZW1iZXJzaGlwKQAAABRyZWdpc3Rlcl93aXRoX2NhbGxlcgAAAAMAAAAAAAAABmRhb19pZAAAAAAABgAAAAAAAAAKY29tbWl0bWVudAAAAAAADAAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAA==",
        "AAAAAAAAAP1SZWdpc3RlciBhIGNvbW1pdG1lbnQgZnJvbSByZWdpc3RyeSBkdXJpbmcgREFPIGluaXRpYWxpemF0aW9uClRoaXMgZnVuY3Rpb24gaXMgY2FsbGVkIGJ5IHRoZSByZWdpc3RyeSBjb250cmFjdCBkdXJpbmcgY3JlYXRlX2FuZF9pbml0X2Rhbwp0byBhdXRvbWF0aWNhbGx5IHJlZ2lzdGVyIHRoZSBjcmVhdG9yJ3MgY29tbWl0bWVudC4KVGhlIHJlZ2lzdHJ5IGlzIHRydXN0ZWQgdG8gaGF2ZSBhbHJlYWR5IHZlcmlmaWVkIFNCVCBvd25lcnNoaXAuAAAAAAAAFnJlZ2lzdGVyX2Zyb21fcmVnaXN0cnkAAAAAAAMAAAAAAAAABmRhb19pZAAAAAAABgAAAAAAAAAKY29tbWl0bWVudAAAAAAADAAAAAAAAAAGbWVtYmVyAAAAAAATAAAAAA==",
        "AAAAAAAAAMtJbml0aWFsaXplIHRyZWUgZnJvbSByZWdpc3RyeSBkdXJpbmcgREFPIGluaXRpYWxpemF0aW9uClRoaXMgZnVuY3Rpb24gaXMgY2FsbGVkIGJ5IHRoZSByZWdpc3RyeSBjb250cmFjdCBkdXJpbmcgY3JlYXRlX2FuZF9pbml0X2Rhbwp0byBhdm9pZCByZS1lbnRyYW5jeSBpc3N1ZXMuIFRoZSByZWdpc3RyeSBpcyBhIHRydXN0ZWQgc3lzdGVtIGNvbnRyYWN0LgAAAAAXaW5pdF90cmVlX2Zyb21fcmVnaXN0cnkAAAAAAgAAAAAAAAAGZGFvX2lkAAAAAAAGAAAAAAAAAAVkZXB0aAAAAAAAAAQAAAAA",
      ]),
      options,
    );
  }
  public readonly fromJSON = {
    root_ok: this.txFromJSON<boolean>,
    version: this.txFromJSON<u32>,
    curr_idx: this.txFromJSON<u32>,
    get_root: this.txFromJSON<u256>,
    min_root: this.txFromJSON<u32>,
    revok_at: this.txFromJSON<Option<u64>>,
    root_idx: this.txFromJSON<u32>,
    init_tree: this.txFromJSON<null>,
    reinst_at: this.txFromJSON<Option<u64>>,
    sbt_contr: this.txFromJSON<string>,
    current_root: this.txFromJSON<u256>,
    get_tree_info: this.txFromJSON<readonly [u32, u32, u256]>,
    remove_member: this.txFromJSON<null>,
    self_register: this.txFromJSON<null>,
    get_leaf_index: this.txFromJSON<u32>,
    get_merkle_path: this.txFromJSON<readonly [Array<u256>, Array<u32>]>,
    init_zeros_cache: this.txFromJSON<null>,
    reinstate_member: this.txFromJSON<null>,
    register_with_caller: this.txFromJSON<null>,
    register_from_registry: this.txFromJSON<null>,
    init_tree_from_registry: this.txFromJSON<null>,
  };
}
