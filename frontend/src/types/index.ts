/**
 * Shared Type Definitions for ZKVote Frontend
 */

// ============================================
// CRYPTO CONSTANTS
// ============================================

/**
 * BN254 scalar field modulus (Fr) - all public signals must be < this value
 * r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
 */
export const BN254_FR_MODULUS = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

/**
 * BN254 scalar field modulus as hex string (big-endian, 64 chars)
 */
export const BN254_FR_MODULUS_HEX =
  "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";

/**
 * Circuit constants
 */
export const TREE_DEPTH = 18;
export const NUM_PUBLIC_SIGNALS = 5;
export const VK_IC_LENGTH = NUM_PUBLIC_SIGNALS + 1; // 6 elements

// ============================================
// PROOF TYPES
// ============================================

/**
 * 256-bit unsigned integer as a hex string (with or without 0x prefix)
 * Used for nullifiers, roots, and other BN254 field elements.
 * Must represent a value < BN254_FR_MODULUS.
 */
export type U256Hex = string;

/**
 * G1 point as 64-byte hex string (X || Y, big-endian)
 */
export type G1Hex = string;

/**
 * G2 point as 128-byte hex string (X_c1 || X_c0 || Y_c1 || Y_c0, big-endian)
 */
export type G2Hex = string;

export interface Groth16Proof {
  a: G1Hex; // 64 bytes hex (G1 point)
  b: G2Hex; // 128 bytes hex (G2 point)
  c: G1Hex; // 64 bytes hex (G1 point)
}

// ============================================
// VALIDATION HELPERS
// ============================================

/**
 * Check if a value is a valid BN254 field element (< modulus)
 * @param value - BigInt or hex string (with or without 0x prefix)
 * @returns true if value is valid field element
 */
export function isValidFieldElement(value: bigint | string): boolean {
  const bigValue =
    typeof value === "string"
      ? BigInt(value.startsWith("0x") ? value : `0x${value}`)
      : value;
  return bigValue >= 0n && bigValue < BN254_FR_MODULUS;
}

/**
 * Validate that a value is a non-zero valid field element
 * @throws Error if value is invalid
 */
export function assertValidFieldElement(
  value: bigint | string,
  name = "value",
): void {
  const bigValue =
    typeof value === "string"
      ? BigInt(value.startsWith("0x") ? value : `0x${value}`)
      : value;

  if (bigValue < 0n) {
    throw new Error(`${name} must be non-negative`);
  }
  if (bigValue >= BN254_FR_MODULUS) {
    throw new Error(`${name} must be less than BN254 scalar field modulus`);
  }
}

/**
 * Validate nullifier (must be non-zero valid field element)
 * @throws Error if nullifier is invalid
 */
export function assertValidNullifier(nullifier: bigint | string): void {
  const bigValue =
    typeof nullifier === "string"
      ? BigInt(nullifier.startsWith("0x") ? nullifier : `0x${nullifier}`)
      : nullifier;

  if (bigValue === 0n) {
    throw new Error("Nullifier cannot be zero");
  }
  assertValidFieldElement(bigValue, "nullifier");
}

// ============================================
// CONTRACT ERROR CODES
// ============================================

/**
 * DAO Registry contract error codes
 */
export const RegistryError = {
  NameTooLong: 1,
  DaoNotFound: 2,
  NotAdmin: 3,
  MetadataCidTooLong: 4,
} as const;
export type RegistryError = (typeof RegistryError)[keyof typeof RegistryError];

/**
 * Membership SBT contract error codes
 */
export const SbtError = {
  NotDaoAdmin: 1,
  AlreadyMinted: 2,
  NotMember: 3,
  NotOpenMembership: 4,
  AlreadyInitialized: 5,
} as const;
export type SbtError = (typeof SbtError)[keyof typeof SbtError];

/**
 * Membership Tree contract error codes
 */
export const TreeError = {
  NotAdmin: 1,
  InvalidDepth: 2,
  TreeInitialized: 3,
  TreeNotInitialized: 4,
  CommitmentExists: 5,
  MemberExists: 6,
  TreeFull: 7,
  NoSbt: 8,
  NotOpenMembership: 9,
  LeafOutOfBounds: 10,
  MemberRemoved: 11,
  MemberNotInTree: 12,
  RootNotFound: 13,
  AlreadyInitialized: 14,
  MemberNotRevoked: 15,
} as const;
export type TreeError = (typeof TreeError)[keyof typeof TreeError];

/**
 * Voting contract error codes
 */
export const VotingError = {
  NotAdmin: 1,
  VkIcLengthMismatch: 2,
  VkIcTooLarge: 3,
  TitleTooLong: 4,
  NotDaoMember: 5,
  EndTimeInvalid: 6,
  NullifierUsed: 7,
  VotingClosed: 8,
  CommitmentRevokedAtCreation: 9,
  CommitmentRevokedDuringVoting: 10,
  RootMismatch: 11,
  RootNotInHistory: 12,
  RootPredatesProposal: 13,
  VkChanged: 14,
  InvalidProof: 15,
  VkNotSet: 16,
  VkVersionMismatch: 17,
  AlreadyInitialized: 18,
  Unauthorized: 19,
  InvalidState: 20,
  InvalidContentCid: 21,
  OnlyAdminCanPropose: 22,
  InvalidG1Point: 23,
  RootPredatesRemoval: 24,
  SignalNotInField: 25,
  InvalidNullifier: 26,
} as const;
export type VotingError = (typeof VotingError)[keyof typeof VotingError];

/**
 * Comments contract error codes
 */
export const CommentsError = {
  NotAdmin: 1,
  NotDaoMember: 5,
  CommitmentRevoked: 9,
  RootNotInHistory: 12,
  InvalidProof: 15,
  ContractNotSet: 16,
  AlreadyInitialized: 18,
  Unauthorized: 19,
  CommentNotFound: 22,
  CommentDeleted: 23,
  NotCommentOwner: 24,
  InvalidParentComment: 25,
  CommentContentTooLong: 27,
  ProposalNotFound: 28,
  RootMismatch: 29,
  RootPredatesProposal: 30,
  SignalNotInField: 31,
  InvalidNullifier: 32,
  RootPredatesRemoval: 33,
} as const;
export type CommentsError = (typeof CommentsError)[keyof typeof CommentsError];

/**
 * Groth16 verification error codes (shared between contracts)
 */
export const Groth16Error = {
  IcLengthMismatch: 30,
  SignalNotInField: 31,
  InvalidNullifier: 32,
} as const;
export type Groth16Error = (typeof Groth16Error)[keyof typeof Groth16Error];

/**
 * Human-readable error messages for contract errors
 */
export const ERROR_MESSAGES: Record<string, Record<number, string>> = {
  Registry: {
    [RegistryError.NameTooLong]: "DAO name exceeds 24 character limit",
    [RegistryError.DaoNotFound]: "DAO not found",
    [RegistryError.NotAdmin]: "Only DAO admin can perform this action",
    [RegistryError.MetadataCidTooLong]:
      "Metadata CID exceeds 64 character limit",
  },
  Sbt: {
    [SbtError.NotDaoAdmin]: "Only DAO admin can perform this action",
    [SbtError.AlreadyMinted]: "Member already has an SBT for this DAO",
    [SbtError.NotMember]: "Address is not a member of this DAO",
    [SbtError.NotOpenMembership]: "DAO membership is not open for self-join",
    [SbtError.AlreadyInitialized]: "Contract already initialized",
  },
  Tree: {
    [TreeError.NotAdmin]: "Only DAO admin can perform this action",
    [TreeError.InvalidDepth]: "Invalid tree depth (must be 1-18)",
    [TreeError.TreeInitialized]: "Tree already initialized for this DAO",
    [TreeError.TreeNotInitialized]: "Tree not initialized for this DAO",
    [TreeError.CommitmentExists]: "Identity commitment already registered",
    [TreeError.MemberExists]: "Member already registered",
    [TreeError.TreeFull]: "Merkle tree is full (max capacity reached)",
    [TreeError.NoSbt]: "Member does not have an SBT",
    [TreeError.NotOpenMembership]: "DAO membership is not open",
    [TreeError.LeafOutOfBounds]: "Leaf index out of bounds",
    [TreeError.MemberRemoved]: "Member has been removed",
    [TreeError.MemberNotInTree]: "Member not found in tree",
    [TreeError.RootNotFound]: "Merkle root not found in history",
    [TreeError.AlreadyInitialized]: "Tree already initialized",
    [TreeError.MemberNotRevoked]: "Member has not been revoked",
  },
  Voting: {
    [VotingError.NotAdmin]: "Only DAO admin can perform this action",
    [VotingError.VkIcLengthMismatch]: "Verification key IC length mismatch",
    [VotingError.VkIcTooLarge]: "Verification key IC vector too large",
    [VotingError.TitleTooLong]: "Proposal title too long",
    [VotingError.NotDaoMember]: "Not a member of this DAO",
    [VotingError.EndTimeInvalid]: "Invalid proposal end time",
    [VotingError.NullifierUsed]: "Vote already cast (nullifier used)",
    [VotingError.VotingClosed]: "Voting period has ended",
    [VotingError.CommitmentRevokedAtCreation]:
      "Commitment was revoked when proposal was created",
    [VotingError.CommitmentRevokedDuringVoting]:
      "Commitment revoked during voting period",
    [VotingError.RootMismatch]: "Merkle root does not match proposal snapshot",
    [VotingError.RootNotInHistory]: "Merkle root not in tree history",
    [VotingError.RootPredatesProposal]: "Root predates proposal creation",
    [VotingError.VkChanged]: "Verification key changed after proposal creation",
    [VotingError.InvalidProof]: "Invalid ZK proof",
    [VotingError.VkNotSet]: "Verification key not set for this DAO",
    [VotingError.VkVersionMismatch]: "VK version mismatch",
    [VotingError.AlreadyInitialized]: "Contract already initialized",
    [VotingError.Unauthorized]: "Unauthorized",
    [VotingError.InvalidState]: "Invalid contract state",
    [VotingError.InvalidContentCid]: "Invalid content CID",
    [VotingError.OnlyAdminCanPropose]:
      "Only admin can create proposals in this DAO",
    [VotingError.InvalidG1Point]: "Invalid G1 point (not on BN254 curve)",
    [VotingError.RootPredatesRemoval]: "Root predates member removal",
    [VotingError.SignalNotInField]: "Public signal exceeds field modulus",
    [VotingError.InvalidNullifier]: "Invalid nullifier (cannot be zero)",
  },
  Comments: {
    [CommentsError.NotAdmin]: "Only DAO admin can perform this action",
    [CommentsError.NotDaoMember]: "Not a member of this DAO",
    [CommentsError.CommitmentRevoked]: "Commitment has been revoked",
    [CommentsError.RootNotInHistory]: "Root not found in tree history",
    [CommentsError.InvalidProof]: "Invalid ZK proof",
    [CommentsError.ContractNotSet]: "Contract reference not set",
    [CommentsError.AlreadyInitialized]: "Contract already initialized",
    [CommentsError.Unauthorized]: "Unauthorized",
    [CommentsError.CommentNotFound]: "Comment not found",
    [CommentsError.CommentDeleted]: "Comment has been deleted",
    [CommentsError.NotCommentOwner]: "Not the comment owner",
    [CommentsError.InvalidParentComment]: "Invalid parent comment",
    [CommentsError.CommentContentTooLong]: "Comment content too long",
    [CommentsError.ProposalNotFound]: "Proposal not found",
    [CommentsError.RootMismatch]: "Root does not match proposal snapshot",
    [CommentsError.RootPredatesProposal]: "Root predates proposal",
    [CommentsError.SignalNotInField]: "Public signal exceeds field modulus",
    [CommentsError.InvalidNullifier]: "Invalid nullifier (cannot be zero)",
    [CommentsError.RootPredatesRemoval]: "Root predates member removal",
  },
};

/**
 * Get human-readable error message from contract error
 * @param contract - Contract name (Registry, Sbt, Tree, Voting, Comments)
 * @param code - Error code number
 * @returns Human-readable error message or generic message
 */
export function getErrorMessage(contract: string, code: number): string {
  return ERROR_MESSAGES[contract]?.[code] ?? `Unknown error (code ${code})`;
}
