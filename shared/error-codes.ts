/**
 * ZK-VOTE Error Codes - Shared Type-Safe Error Catalogue
 * 
 * Generated from docs/error-codes.md
 * ZV-126: Enforces exhaustive error handling across frontend/backend
 * 
 * This file ensures:
 * 1. All documented error codes are type-safe
 * 2. Frontend exhaustive mapping fails at compile time when codes are added
 * 3. Backend routes use typed error responses
 * 4. CI can verify drift between docs/code
 */

// ============================================
// DAO Registry Errors
// ============================================
export enum DaoRegistryError {
  NameTooLong = 1,
  DaoNotFound = 2,
  NotAdmin = 3,
  MetadataCidTooLong = 4,
}

export const DaoRegistryErrorMessages: Record<DaoRegistryError, string> = {
  [DaoRegistryError.NameTooLong]: "DAO name exceeds 24 character limit",
  [DaoRegistryError.DaoNotFound]: "DAO with given ID doesn't exist",
  [DaoRegistryError.NotAdmin]: "Caller is not the DAO admin",
  [DaoRegistryError.MetadataCidTooLong]: "Metadata CID exceeds 64 character limit",
};

// ============================================
// Membership SBT Errors
// ============================================
export enum MembershipSbtError {
  NotDaoAdmin = 1,
  AlreadyMinted = 2,
  NotMember = 3,
  NotOpenMembership = 4,
  AlreadyInitialized = 5,
}

export const MembershipSbtErrorMessages: Record<MembershipSbtError, string> = {
  [MembershipSbtError.NotDaoAdmin]: "Caller is not the DAO admin",
  [MembershipSbtError.AlreadyMinted]: "Member already has an SBT for this DAO",
  [MembershipSbtError.NotMember]: "Address is not a member of this DAO",
  [MembershipSbtError.NotOpenMembership]: "DAO membership is not open for self-join",
  [MembershipSbtError.AlreadyInitialized]: "Contract already initialized",
};

// ============================================
// Membership Tree Errors
// ============================================
export enum MembershipTreeError {
  NotAdmin = 1,
  InvalidDepth = 2,
  TreeInitialized = 3,
  TreeNotInitialized = 4,
  CommitmentExists = 5,
  MemberExists = 6,
  TreeFull = 7,
  NoSbt = 8,
  NotOpenMembership = 9,
  LeafOutOfBounds = 10,
  MemberRemoved = 11,
  MemberNotInTree = 12,
  RootNotFound = 13,
  AlreadyInitialized = 14,
  MemberNotRevoked = 15,
  CommitmentAlreadyUsed = 16,
  RateLimited = 17,
  MaxRootsOutOfRange = 18,
  RootPinnedByProposal = 19,
  Sha3TreeNotInitialized = 20,
  PqCommitmentExists = 21,
  InvalidField = 22,
}

export const MembershipTreeErrorMessages: Record<MembershipTreeError, string> = {
  [MembershipTreeError.NotAdmin]: "Caller is not the DAO admin",
  [MembershipTreeError.InvalidDepth]: "Tree depth must be 1-18",
  [MembershipTreeError.TreeInitialized]: "Tree already initialized for this DAO",
  [MembershipTreeError.TreeNotInitialized]: "Tree not initialized for this DAO",
  [MembershipTreeError.CommitmentExists]: "Identity commitment already registered",
  [MembershipTreeError.MemberExists]: "Member already registered in tree",
  [MembershipTreeError.TreeFull]: "Merkle tree is full (2^depth leaves)",
  [MembershipTreeError.NoSbt]: "Member does not have an SBT",
  [MembershipTreeError.NotOpenMembership]: "DAO membership is not open",
  [MembershipTreeError.LeafOutOfBounds]: "Leaf index exceeds tree capacity",
  [MembershipTreeError.MemberRemoved]: "Member has been removed/revoked",
  [MembershipTreeError.MemberNotInTree]: "Member not found in tree",
  [MembershipTreeError.RootNotFound]: "Merkle root not in history",
  [MembershipTreeError.AlreadyInitialized]: "Tree already initialized",
  [MembershipTreeError.MemberNotRevoked]: "Member has not been revoked",
  [MembershipTreeError.CommitmentAlreadyUsed]: "Commitment already bound to a different address",
  [MembershipTreeError.RateLimited]: "Call rate-limited",
  [MembershipTreeError.MaxRootsOutOfRange]: "Requested root history size is out of range",
  [MembershipTreeError.RootPinnedByProposal]: "Root is pinned by an in-flight proposal",
  [MembershipTreeError.Sha3TreeNotInitialized]: "Post-quantum tree not initialized for DAO",
  [MembershipTreeError.PqCommitmentExists]: "C_PQ commitment already stored",
  [MembershipTreeError.InvalidField]: "Poseidon field symbol is not BN254 or BLS12_381",
};

// ============================================
// Voting Contract Errors
// ============================================
export enum VotingError {
  NotAdmin = 1,
  VkIcLengthMismatch = 2,
  VkIcTooLarge = 3,
  TitleTooLong = 4,
  NotDaoMember = 5,
  EndTimeInvalid = 6,
  NullifierUsed = 7,
  VotingClosed = 8,
  CommitmentRevokedAtCreation = 9,
  CommitmentRevokedDuringVoting = 10,
  RootMismatch = 11,
  RootNotInHistory = 12,
  RootPredatesProposal = 13,
  VkChanged = 14,
  InvalidProof = 15,
  VkNotSet = 16,
  VkVersionMismatch = 17,
  AlreadyInitialized = 18,
  Unauthorized = 19,
  InvalidState = 20,
  InvalidContentCid = 21,
  OnlyAdminCanPropose = 22,
  InvalidG1Point = 23,
  RootPredatesRemoval = 24,
  SignalNotInField = 25,
  InvalidNullifier = 26,
}

export const VotingErrorMessages: Record<VotingError, string> = {
  [VotingError.NotAdmin]: "Caller is not the DAO admin",
  [VotingError.VkIcLengthMismatch]: "VK IC length doesn't match expected (6)",
  [VotingError.VkIcTooLarge]: "VK IC vector too large",
  [VotingError.TitleTooLong]: "Proposal title exceeds limit",
  [VotingError.NotDaoMember]: "Caller not a member of this DAO",
  [VotingError.EndTimeInvalid]: "Proposal end time is in the past",
  [VotingError.NullifierUsed]: "Vote already cast (nullifier used)",
  [VotingError.VotingClosed]: "Voting period has ended",
  [VotingError.CommitmentRevokedAtCreation]: "Member was revoked when proposal created",
  [VotingError.CommitmentRevokedDuringVoting]: "Member revoked during voting",
  [VotingError.RootMismatch]: "Root doesn't match proposal snapshot",
  [VotingError.RootNotInHistory]: "Merkle root not in tree history",
  [VotingError.RootPredatesProposal]: "Root is from before proposal creation",
  [VotingError.VkChanged]: "VK changed after proposal creation",
  [VotingError.InvalidProof]: "ZK proof verification failed",
  [VotingError.VkNotSet]: "Verification key not set for DAO",
  [VotingError.VkVersionMismatch]: "VK version doesn't match proposal",
  [VotingError.AlreadyInitialized]: "Contract already initialized",
  [VotingError.Unauthorized]: "Caller not authorized",
  [VotingError.InvalidState]: "Invalid contract state",
  [VotingError.InvalidContentCid]: "Content CID invalid format",
  [VotingError.OnlyAdminCanPropose]: "Only admin can create proposals",
  [VotingError.InvalidG1Point]: "G1 point not on BN254 curve",
  [VotingError.RootPredatesRemoval]: "Root is from before member removal",
  [VotingError.SignalNotInField]: "Public signal ≥ BN254 Fr modulus",
  [VotingError.InvalidNullifier]: "Nullifier is zero",
};

// ============================================
// Comments Contract Errors
// ============================================
export enum CommentsError {
  NotAdmin = 1,
  NotDaoMember = 5,
  CommitmentRevoked = 9,
  RootNotInHistory = 12,
  InvalidProof = 15,
  ContractNotSet = 16,
  AlreadyInitialized = 18,
  Unauthorized = 19,
  CommentNotFound = 22,
  CommentDeleted = 23,
  NotCommentOwner = 24,
  InvalidParentComment = 25,
  CommentContentTooLong = 27,
  ProposalNotFound = 28,
  RootMismatch = 29,
  RootPredatesProposal = 30,
  SignalNotInField = 31,
  InvalidNullifier = 32,
  RootPredatesRemoval = 33,
}

export const CommentsErrorMessages: Record<CommentsError, string> = {
  [CommentsError.NotAdmin]: "Caller is not the DAO admin",
  [CommentsError.NotDaoMember]: "Caller not a member of this DAO",
  [CommentsError.CommitmentRevoked]: "Member's commitment was revoked",
  [CommentsError.RootNotInHistory]: "Merkle root not in tree history",
  [CommentsError.InvalidProof]: "ZK proof verification failed",
  [CommentsError.ContractNotSet]: "Required contract reference not set",
  [CommentsError.AlreadyInitialized]: "Contract already initialized",
  [CommentsError.Unauthorized]: "Caller not authorized",
  [CommentsError.CommentNotFound]: "Comment ID doesn't exist",
  [CommentsError.CommentDeleted]: "Comment was already deleted",
  [CommentsError.NotCommentOwner]: "Caller doesn't own this comment",
  [CommentsError.InvalidParentComment]: "Parent comment doesn't exist",
  [CommentsError.CommentContentTooLong]: "Comment exceeds length limit",
  [CommentsError.ProposalNotFound]: "Proposal doesn't exist",
  [CommentsError.RootMismatch]: "Root doesn't match proposal",
  [CommentsError.RootPredatesProposal]: "Root is from before proposal",
  [CommentsError.SignalNotInField]: "Public signal ≥ BN254 Fr modulus",
  [CommentsError.InvalidNullifier]: "Nullifier is zero",
  [CommentsError.RootPredatesRemoval]: "Root is from before member removal",
};

// ============================================
// Groth16 Verification Errors
// ============================================
export enum Groth16Error {
  IcLengthMismatch = 30,
  SignalNotInField = 31,
  InvalidNullifier = 32,
}

export const Groth16ErrorMessages: Record<Groth16Error, string> = {
  [Groth16Error.IcLengthMismatch]: "IC vector length doesn't match public inputs",
  [Groth16Error.SignalNotInField]: "Public signal ≥ BN254 Fr modulus",
  [Groth16Error.InvalidNullifier]: "Nullifier is zero",
};

// ============================================
// Token Errors
// ============================================
export enum TokenError {
  AlreadyInitialized = 1,
  InsufficientBalance = 2,
  InsufficientAllowance = 3,
  Unauthorized = 4,
  InvalidAmount = 5,
  Overflow = 6,
  AllowanceRaceRejected = 7,
  NotAdmin = 8,
  NegativeAllowance = 9,
}

export const TokenErrorMessages: Record<TokenError, string> = {
  [TokenError.AlreadyInitialized]: "Contract already initialized",
  [TokenError.InsufficientBalance]: "Not enough tokens to transfer/burn",
  [TokenError.InsufficientAllowance]: "Spender has insufficient allowance",
  [TokenError.Unauthorized]: "Caller not authorized for action",
  [TokenError.InvalidAmount]: "Amount cannot be negative",
  [TokenError.Overflow]: "Arithmetic overflow in add/sub",
  [TokenError.AllowanceRaceRejected]: "approve rejected non-zero to different non-zero",
  [TokenError.NotAdmin]: "Caller is not the token admin",
  [TokenError.NegativeAllowance]: "Negative amount passed to increase/decrease",
};

// ============================================
// Rewards Contract Errors
// ============================================
export enum RewardsError {
  NotAdmin = 1,
  Unauthorized = 19,
  VkIcLengthMismatch = 2,
  VkIcTooLarge = 3,
  NotVoted = 4,
  ClaimNullifierUsed = 5,
  InvalidProof = 6,
  VkNotSet = 7,
  VkVersionMismatch = 8,
  AlreadyInitialized = 9,
  InvalidState = 10,
  InvalidG1Point = 11,
  SignalNotInField = 12,
  InvalidNullifier = 13,
  RootMismatch = 14,
  RootNotInHistory = 15,
  RootPredatesProposal = 16,
  RootPredatesRemoval = 17,
  VkChanged = 18,
  TreasuryInsufficient = 20,
  InvalidRewardAmount = 21,
  FundingCapExceeded = 22,
  InvalidTreasury = 23,
  // Coarse error codes (100-106)
  InvalidInput = 100,
  EligibilityFailed = 101,
  ProofInvalid = 102,
  AlreadySubmitted = 103,
  WindowClosed = 104,
  InsufficientFunds = 105,
  ConfigError = 106,
}

export const RewardsErrorMessages: Record<RewardsError, string> = {
  [RewardsError.NotAdmin]: "Caller is not the DAO admin",
  [RewardsError.Unauthorized]: "Caller not authorized",
  [RewardsError.VkIcLengthMismatch]: "VK IC length doesn't match expected",
  [RewardsError.VkIcTooLarge]: "VK IC vector too large",
  [RewardsError.NotVoted]: "Vote not found — only voters can claim",
  [RewardsError.ClaimNullifierUsed]: "Reward already claimed for this vote",
  [RewardsError.InvalidProof]: "ZK proof verification failed",
  [RewardsError.VkNotSet]: "Verification key not set for DAO",
  [RewardsError.VkVersionMismatch]: "VK version doesn't match",
  [RewardsError.AlreadyInitialized]: "Contract already initialized",
  [RewardsError.InvalidState]: "Invalid contract state",
  [RewardsError.InvalidG1Point]: "G1 point not on BN254 curve",
  [RewardsError.SignalNotInField]: "Public signal ≥ BN254 Fr modulus",
  [RewardsError.InvalidNullifier]: "Nullifier is zero",
  [RewardsError.RootMismatch]: "Root doesn't match proposal",
  [RewardsError.RootNotInHistory]: "Merkle root not in tree history",
  [RewardsError.RootPredatesProposal]: "Root is from before proposal creation",
  [RewardsError.RootPredatesRemoval]: "Root is from before member removal",
  [RewardsError.VkChanged]: "VK changed after proposal creation",
  [RewardsError.TreasuryInsufficient]: "Treasury insufficient",
  [RewardsError.InvalidRewardAmount]: "Invalid reward amount",
  [RewardsError.FundingCapExceeded]: "Funding cap exceeded",
  [RewardsError.InvalidTreasury]: "Invalid treasury",
  [RewardsError.InvalidInput]: "Invalid input provided",
  [RewardsError.EligibilityFailed]: "Eligibility check failed",
  [RewardsError.ProofInvalid]: "Proof verification failed",
  [RewardsError.AlreadySubmitted]: "Already submitted",
  [RewardsError.WindowClosed]: "Submission window closed",
  [RewardsError.InsufficientFunds]: "Insufficient funds",
  [RewardsError.ConfigError]: "Configuration error",
};

// ============================================
// Union Type for All Errors
// ============================================
export type ZKVoteError =
  | DaoRegistryError
  | MembershipSbtError
  | MembershipTreeError
  | VotingError
  | CommentsError
  | Groth16Error
  | TokenError
  | RewardsError;

/**
 * Get human-readable error message for any contract error
 */
export function getErrorMessage(
  contract: string,
  code: number,
): string {
  switch (contract.toLowerCase()) {
    case "dao":
    case "dao-registry":
    case "daoregistry":
      return DaoRegistryErrorMessages[code as DaoRegistryError] ?? `Unknown DAO Registry error (code ${code})`;
    
    case "sbt":
    case "membership-sbt":
    case "membershipsbt":
      return MembershipSbtErrorMessages[code as MembershipSbtError] ?? `Unknown Membership SBT error (code ${code})`;
    
    case "tree":
    case "membership-tree":
    case "membershiptree":
      return MembershipTreeErrorMessages[code as MembershipTreeError] ?? `Unknown Membership Tree error (code ${code})`;
    
    case "voting":
      return VotingErrorMessages[code as VotingError] ?? `Unknown Voting error (code ${code})`;
    
    case "comments":
      return CommentsErrorMessages[code as CommentsError] ?? `Unknown Comments error (code ${code})`;
    
    case "groth16":
      return Groth16ErrorMessages[code as Groth16Error] ?? `Unknown Groth16 error (code ${code})`;
    
    case "token":
      return TokenErrorMessages[code as TokenError] ?? `Unknown Token error (code ${code})`;
    
    case "rewards":
    case "claim":
      return RewardsErrorMessages[code as RewardsError] ?? `Unknown Rewards error (code ${code})`;
    
    default:
      return `Unknown error from contract ${contract} (code ${code})`;
  }
}

/**
 * Type guard to check if error code is documented
 */
export function isDocumentedError(contract: string, code: number): boolean {
  try {
    const message = getErrorMessage(contract, code);
    return !message.startsWith("Unknown");
  } catch {
    return false;
  }
}
