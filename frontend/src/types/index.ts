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
export const NUM_PUBLIC_SIGNALS = 6;
export const VK_IC_LENGTH = NUM_PUBLIC_SIGNALS + 1; // 7 elements

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
//
// These objects use the frontend-conventional { ErrorName: numericCode }
// mapping.  The wire-format variants ({ numericCode: { message } }) are
// available in src/generated/contract-types.ts as *ErrorRaw exports.
// ============================================

/**
 * DAO Registry contract error codes
 * Source of truth: contracts/dao-registry/src/index.ts (RegistryError)
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
 * Source of truth: contracts/membership-sbt/src/index.ts (SbtError)
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
 * Source of truth: contracts/membership-tree/src/index.ts (TreeError)
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
  CommitmentAlreadyUsed: 16,
  RateLimited: 17,
} as const;
export type TreeError = (typeof TreeError)[keyof typeof TreeError];

/**
 * Voting contract error codes
 * Source of truth: contracts/voting/src/index.ts (VotingError)
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
  // -- Coarse error codes (100-106) --
  InvalidInput: 100,
  EligibilityFailed: 101,
  ProofInvalid: 102,
  AlreadySubmitted: 103,
  WindowClosed: 104,
  InsufficientFunds: 105,
  ConfigError: 106,
} as const;
export type VotingError = (typeof VotingError)[keyof typeof VotingError];

/**
 * Comments contract error codes
 * Source of truth: contracts/comments/src/index.ts (CommentsError)
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
  // -- Coarse error codes (100-106) --
  InvalidInput: 100,
  EligibilityFailed: 101,
  ProofInvalid: 102,
  AlreadySubmitted: 103,
  WindowClosed: 104,
  InsufficientFunds: 105,
  ConfigError: 106,
} as const;
export type CommentsError = (typeof CommentsError)[keyof typeof CommentsError];

export const CircuitRegistryError = {
  NotGovernance: 1,
  CircuitNotFound: 2,
  CircuitAlreadyRegistered: 3,
  InvalidCircuitType: 4,
  MigrationNotFound: 5,
  MigrationAlreadyExists: 6,
  MigrationDeadlinePassed: 7,
  CircuitExpired: 8,
} as const;
export type CircuitRegistryError =
  (typeof CircuitRegistryError)[keyof typeof CircuitRegistryError];

/**
 * Circuit Registry types
 */
export interface CircuitInfo {
  circuitId: string;
  circuitType: "Vote" | "Comment";
  registeredAt: number;
  expiration: number;
  numPublicSignals: number;
}

export interface DaoMigration {
  fromCircuitId: string;
  toCircuitId: string;
  deadline: number;
  inOverlapWindow: boolean;
}

export interface VkProposal {
  id: number;
  circuitId: string;
  circuitType: "Vote" | "Comment";
  proposedBy: string;
  proposedAt: number;
  executeAfter: number;
  requiredApprovals: number;
  approvals: number;
  status: "Pending" | "Approved" | "Executed" | "Cancelled";
  daoId?: number;
}

export interface CircuitStatusResponse {
  daoId: number;
  circuitType: "Vote" | "Comment";
  currentCircuit: string;
  availableCircuits: CircuitInfo[];
  migration?: DaoMigration;
  pendingVkProposal?: VkProposal;
}

export const CIRCUIT_VERSIONS = {
  VOTE_V1: "vote_v1",
  VOTE_V2: "vote_v2",
  COMMENT_V1: "comment_v1",
  COMMENT_V2: "comment_v2",
} as const;

/**
 * Groth16 verification error codes (shared between contracts)
 */
export const Groth16Error = {
  IcLengthMismatch: 30,
  SignalNotInField: 31,
  InvalidNullifier: 32,
  // -- Coarse error codes (100-106) --
  InvalidInput: 100,
  EligibilityFailed: 101,
  ProofInvalid: 102,
  AlreadySubmitted: 103,
  WindowClosed: 104,
  InsufficientFunds: 105,
  ConfigError: 106,
} as const;
export type Groth16Error = (typeof Groth16Error)[keyof typeof Groth16Error];

/**
 * Rewards (vote-to-earn) contract error codes
 */
export const RewardsError = {
  NotAdmin: 1,
  VkIcLengthMismatch: 2,
  VkIcTooLarge: 3,
  NotVoted: 4,
  ClaimNullifierUsed: 5,
  InvalidProof: 6,
  VkNotSet: 7,
  VkVersionMismatch: 8,
  AlreadyInitialized: 9,
  InvalidState: 10,
  InvalidG1Point: 11,
  SignalNotInField: 12,
  InvalidNullifier: 13,
  RootMismatch: 14,
  RootNotInHistory: 15,
  RootPredatesProposal: 16,
  RootPredatesRemoval: 17,
  VkChanged: 18,
  Unauthorized: 19,
  TreasuryInsufficient: 20,
  InvalidRewardAmount: 21,
  FundingCapExceeded: 22,
  InvalidTreasury: 23,
  // -- Coarse error codes (100-106) --
  InvalidInput: 100,
  EligibilityFailed: 101,
  ProofInvalid: 102,
  AlreadySubmitted: 103,
  WindowClosed: 104,
  InsufficientFunds: 105,
  ConfigError: 106,
} as const;
export type RewardsError = (typeof RewardsError)[keyof typeof RewardsError];

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
    [TreeError.CommitmentAlreadyUsed]: "Identity commitment already used",
    [TreeError.RateLimited]: "Too many registrations: try again once the cooldown window has passed",
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
    // -- Coarse error codes (100-106) --
    [VotingError.InvalidInput]: "Invalid submission",
    [VotingError.EligibilityFailed]: "Not eligible to perform this action",
    [VotingError.ProofInvalid]: "Invalid proof",
    [VotingError.AlreadySubmitted]: "Already submitted",
    [VotingError.WindowClosed]: "Submission window is closed",
    [VotingError.InsufficientFunds]: "Insufficient funds or treasury balance",
    [VotingError.ConfigError]:
      "System configuration error — please try again later",
  },
  CircuitRegistry: {
    [CircuitRegistryError.NotGovernance]:
      "Only governance can perform this action",
    [CircuitRegistryError.CircuitNotFound]: "Circuit not found in registry",
    [CircuitRegistryError.CircuitAlreadyRegistered]:
      "Circuit already registered",
    [CircuitRegistryError.InvalidCircuitType]: "Invalid circuit type",
    [CircuitRegistryError.MigrationNotFound]: "Migration not found",
    [CircuitRegistryError.MigrationAlreadyExists]: "Migration already exists",
    [CircuitRegistryError.MigrationDeadlinePassed]:
      "Migration deadline has passed",
    [CircuitRegistryError.CircuitExpired]: "Circuit has expired",
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
    // -- Coarse error codes (100-106) --
    [CommentsError.InvalidInput]: "Invalid submission",
    [CommentsError.EligibilityFailed]: "Not eligible to perform this action",
    [CommentsError.ProofInvalid]: "Invalid proof",
    [CommentsError.AlreadySubmitted]: "Already submitted",
    [CommentsError.WindowClosed]: "Submission window is closed",
    [CommentsError.InsufficientFunds]: "Insufficient funds or treasury balance",
    [CommentsError.ConfigError]:
      "System configuration error — please try again later",
  },
  Groth16: {
    [Groth16Error.IcLengthMismatch]: "Verification key IC length mismatch",
    [Groth16Error.SignalNotInField]: "Public signal exceeds field modulus",
    [Groth16Error.InvalidNullifier]: "Invalid nullifier (cannot be zero)",
    // -- Coarse error codes (100-106) --
    [Groth16Error.InvalidInput]: "Invalid submission",
    [Groth16Error.EligibilityFailed]: "Not eligible to perform this action",
    [Groth16Error.ProofInvalid]: "Invalid proof",
    [Groth16Error.AlreadySubmitted]: "Already submitted",
    [Groth16Error.WindowClosed]: "Submission window is closed",
    [Groth16Error.InsufficientFunds]:
      "Insufficient funds or treasury balance",
    [Groth16Error.ConfigError]:
      "System configuration error — please try again later",
  },
  Rewards: {
    [RewardsError.NotAdmin]: "Only DAO admin can perform this action",
    [RewardsError.VkIcLengthMismatch]: "Verification key IC length mismatch",
    [RewardsError.VkIcTooLarge]: "Verification key IC vector too large",
    [RewardsError.NotVoted]:
      "Must have cast a vote on this proposal to claim reward",
    [RewardsError.ClaimNullifierUsed]: "Reward already claimed (nullifier used)",
    [RewardsError.InvalidProof]: "Invalid ZK proof",
    [RewardsError.VkNotSet]: "Verification key not set for this DAO",
    [RewardsError.VkVersionMismatch]: "VK version mismatch",
    [RewardsError.AlreadyInitialized]: "Contract already initialized",
    [RewardsError.InvalidState]: "Invalid contract state",
    [RewardsError.InvalidG1Point]: "Invalid G1 point (not on BN254 curve)",
    [RewardsError.SignalNotInField]: "Public signal exceeds field modulus",
    [RewardsError.InvalidNullifier]: "Invalid nullifier (cannot be zero)",
    [RewardsError.RootMismatch]: "Root does not match proposal snapshot",
    [RewardsError.RootNotInHistory]: "Root not found in tree history",
    [RewardsError.RootPredatesProposal]: "Root predates proposal creation",
    [RewardsError.RootPredatesRemoval]: "Root predates member removal",
    [RewardsError.VkChanged]: "Verification key changed unexpectedly",
    [RewardsError.Unauthorized]: "Unauthorized",
    [RewardsError.TreasuryInsufficient]:
      "Insufficient reward treasury balance — please try again later",
    [RewardsError.InvalidRewardAmount]: "Invalid reward amount",
    [RewardsError.FundingCapExceeded]: "Maximum treasury funding cap exceeded",
    [RewardsError.InvalidTreasury]: "Invalid treasury funding amount",
    // -- Coarse error codes (100-106) --
    [RewardsError.InvalidInput]: "Invalid submission",
    [RewardsError.EligibilityFailed]: "Not eligible to perform this action",
    [RewardsError.ProofInvalid]: "Invalid proof",
    [RewardsError.AlreadySubmitted]: "Already submitted",
    [RewardsError.WindowClosed]: "Submission window is closed",
    [RewardsError.InsufficientFunds]:
      "Insufficient funds or treasury balance",
    [RewardsError.ConfigError]:
      "System configuration error — please try again later",
  },
};

/**
 * Centralized fine-grained → coarse error mapping for every contract.
 * Mirrors the Rust `to_coarse()` match arms in each contract's lib.rs so
 * front-end and on-chain logic stay in sync.
 *
 * Use-case: even if a deployed contract version still emits fine-grained
 * codes (legacy deployments), the client can collapse any received code
 * into its bucket for user-facing display, providing defense-in-depth
 * across mixed-version deployments.
 */
export const COARSE_MAPPING: Record<string, Record<number, number>> = {
  Voting: {
    // → InvalidInput (100)
    [VotingError.SignalNotInField]: VotingError.InvalidInput,
    [VotingError.InvalidNullifier]: VotingError.InvalidInput,
    [VotingError.InvalidG1Point]: VotingError.InvalidInput,
    [VotingError.TitleTooLong]: VotingError.InvalidInput,
    [VotingError.EndTimeInvalid]: VotingError.InvalidInput,
    [VotingError.InvalidContentCid]: VotingError.InvalidInput,
    [VotingError.NotDaoMember]: VotingError.InvalidInput,
    // → EligibilityFailed (101)
    [VotingError.CommitmentRevokedAtCreation]: VotingError.EligibilityFailed,
    [VotingError.CommitmentRevokedDuringVoting]: VotingError.EligibilityFailed,
    [VotingError.RootMismatch]: VotingError.EligibilityFailed,
    [VotingError.RootNotInHistory]: VotingError.EligibilityFailed,
    [VotingError.RootPredatesProposal]: VotingError.EligibilityFailed,
    [VotingError.RootPredatesRemoval]: VotingError.EligibilityFailed,
    // → ProofInvalid (102)
    [VotingError.VkIcLengthMismatch]: VotingError.ProofInvalid,
    [VotingError.VkIcTooLarge]: VotingError.ProofInvalid,
    [VotingError.VkChanged]: VotingError.ProofInvalid,
    [VotingError.VkVersionMismatch]: VotingError.ProofInvalid,
    [VotingError.InvalidProof]: VotingError.ProofInvalid,
    // → AlreadySubmitted (103)
    [VotingError.NullifierUsed]: VotingError.AlreadySubmitted,
    // → WindowClosed (104)
    [VotingError.VotingClosed]: VotingError.WindowClosed,
    // → ConfigError (106)
    [VotingError.VkNotSet]: VotingError.ConfigError,
    [VotingError.InvalidState]: VotingError.ConfigError,
  },
  Comments: {
    // → InvalidInput (100)
    [CommentsError.SignalNotInField]: CommentsError.InvalidInput,
    [CommentsError.InvalidNullifier]: CommentsError.InvalidInput,
    [CommentsError.CommentContentTooLong]: CommentsError.InvalidInput,
    [CommentsError.InvalidParentComment]: CommentsError.InvalidInput,
    [CommentsError.NotDaoMember]: CommentsError.InvalidInput,
    // → EligibilityFailed (101)
    [CommentsError.CommitmentRevoked]: CommentsError.EligibilityFailed,
    [CommentsError.RootMismatch]: CommentsError.EligibilityFailed,
    [CommentsError.RootNotInHistory]: CommentsError.EligibilityFailed,
    [CommentsError.RootPredatesProposal]: CommentsError.EligibilityFailed,
    [CommentsError.RootPredatesRemoval]: CommentsError.EligibilityFailed,
    // → ProofInvalid (102)
    [CommentsError.InvalidProof]: CommentsError.ProofInvalid,
    [CommentsError.ContractNotSet]: CommentsError.ConfigError,
  },
  Groth16: {
    // → InvalidInput (100)
    [Groth16Error.SignalNotInField]: Groth16Error.InvalidInput,
    [Groth16Error.InvalidNullifier]: Groth16Error.InvalidInput,
    // → ProofInvalid (102)
    [Groth16Error.IcLengthMismatch]: Groth16Error.ProofInvalid,
  },
  Rewards: {
    // → InvalidInput (100)
    [RewardsError.SignalNotInField]: RewardsError.InvalidInput,
    [RewardsError.InvalidNullifier]: RewardsError.InvalidInput,
    [RewardsError.InvalidG1Point]: RewardsError.InvalidInput,
    // → EligibilityFailed (101)
    [RewardsError.NotVoted]: RewardsError.EligibilityFailed,
    [RewardsError.RootMismatch]: RewardsError.EligibilityFailed,
    [RewardsError.RootNotInHistory]: RewardsError.EligibilityFailed,
    [RewardsError.RootPredatesProposal]: RewardsError.EligibilityFailed,
    [RewardsError.RootPredatesRemoval]: RewardsError.EligibilityFailed,
    // → ProofInvalid (102)
    [RewardsError.InvalidProof]: RewardsError.ProofInvalid,
    [RewardsError.VkIcLengthMismatch]: RewardsError.ProofInvalid,
    [RewardsError.VkIcTooLarge]: RewardsError.ProofInvalid,
    [RewardsError.VkChanged]: RewardsError.ProofInvalid,
    [RewardsError.VkVersionMismatch]: RewardsError.ProofInvalid,
    // → AlreadySubmitted (103)
    [RewardsError.ClaimNullifierUsed]: RewardsError.AlreadySubmitted,
    // → InsufficientFunds (105)
    [RewardsError.TreasuryInsufficient]: RewardsError.InsufficientFunds,
    // → ConfigError (106)
    [RewardsError.VkNotSet]: RewardsError.ConfigError,
    [RewardsError.InvalidState]: RewardsError.ConfigError,
  },
};

/**
 * User-facing coarse error messages for the 7 stable buckets (100–106).
 * These are intentionally short, non-fingerprintable, and the same across
 * every contract — an attacker cannot tell which subsystem tripped from
 * the user-visible copy alone.
 */
export const COARSE_ERROR_MESSAGES: Record<number, string> = {
  100: "Invalid submission",
  101: "Not eligible to perform this action",
  102: "Invalid proof",
  103: "Already submitted",
  104: "Submission window is closed",
  105: "Insufficient funds or treasury balance",
  106: "System configuration error — please try again later",
};

/**
 * Map a fine-grained contract error code to its coarse bucket.
 * If no mapping exists the original code is returned unchanged.
 *
 * @param contract - Contract name (Voting, Comments, Rewards, Groth16, …)
 * @param code - Error code number (fine or already coarse)
 * @returns Coarse bucket code (>= 100) or original `code` if no mapping applies
 */
export function getCoarseCode(contract: string, code: number): number {
  // Already coarse codes are returned as-is
  if (code >= 100 && code <= 106) return code;
  return COARSE_MAPPING[contract]?.[code] ?? code;
}

/**
 * Get human-readable error message from contract error.
 *
 * For anonymous-submission contexts (vote / claim / anonymous comment),
 * callers typically want the user-facing coarse copy — pass `coarsen: true`
 * to prefer `COARSE_ERROR_MESSAGES` (if code is already >= 100, or if
 * `COARSE_MAPPING` has a bucket for it). Admin / debug callers can pass
 * `coarsen: false` (default) to receive the specific diagnostic string.
 *
 * @param contract - Contract name (Registry, Sbt, Tree, Voting, Comments, Rewards, Groth16)
 * @param code - Error code number
 * @param coarsen - If true, map fine → coarse and show the stable user-facing message
 * @returns Human-readable error message or generic message
 */
export function getErrorMessage(
  contract: string,
  code: number,
  coarsen = false,
): string {
  if (coarsen) {
    const bucket = getCoarseCode(contract, code);
    if (bucket >= 100 && bucket <= 106) {
      return COARSE_ERROR_MESSAGES[bucket];
    }
  }
  return ERROR_MESSAGES[contract]?.[code] ?? `Unknown error (code ${code})`;
}

// ============================================
// CONTRACT TYPE RE-EXPORTS
//
// Structural types from generated stellar-sdk bindings exposed via a stable
// import path.  Consumers can use either:
//   import { VoteMode } from '@/types'
//   import { VoteMode } from '@/generated/contract-types'
// ============================================

export type {
  DaoInfo,
  VoteMode,
  ProposalInfo,
  ProposalState,
  CommentInfo,
} from "../generated/contract-types.js";
