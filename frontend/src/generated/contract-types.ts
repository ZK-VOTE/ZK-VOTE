/**
 * Auto-generated contract type re-exports.
 * DO NOT EDIT MANUALLY — regenerate by running: npm run check:idl-drift
 *
 * Re-exports types and error objects from generated stellar-sdk contract
 * bindings so the rest of the frontend imports from a single stable path
 * rather than reaching into individual contract packages.
 *
 * Error objects keep the binding's wire format:
 *   { [numericCode]: { message: "ErrorName" } }
 *
 * The canonical `VotingError`, `CommentsError`, etc. dicts in
 * src/types/index.ts use the inverse mapping { ErrorName: numericCode }
 * and are kept for backward compatibility — they are re-exported from
 * there.  The binding-format variants are exposed here with a `Raw`
 * suffix (e.g. `VotingErrorRaw`) so callers that need the wire format
 * can access it without re-parsing.
 */

// ---------------------------------------------------------------------------
// dao-registry
// ---------------------------------------------------------------------------

export type {
  DaoInfo,
  VerificationKey as RegistryVerificationKey,
} from "../contracts/dao-registry/src/index.js";

export { RegistryError as RegistryErrorRaw } from "../contracts/dao-registry/src/index.js";

// ---------------------------------------------------------------------------
// membership-sbt
// ---------------------------------------------------------------------------

export type { DataKey as SbtDataKey } from "../contracts/membership-sbt/src/index.js";

export { SbtError as SbtErrorRaw } from "../contracts/membership-sbt/src/index.js";

// ---------------------------------------------------------------------------
// membership-tree
// ---------------------------------------------------------------------------

export type { DataKey as TreeDataKey } from "../contracts/membership-tree/src/index.js";

export { TreeError as TreeErrorRaw } from "../contracts/membership-tree/src/index.js";

// ---------------------------------------------------------------------------
// voting
// ---------------------------------------------------------------------------

export type {
  DataKey as VotingDataKey,
  VoteMode,
  ProposalInfo,
  ProposalState,
  Proof as VotingProof,
  VerificationKey as VotingVerificationKey,
} from "../contracts/voting/src/index.js";

export {
  VotingError as VotingErrorRaw,
  Groth16Error as VotingGroth16ErrorRaw,
} from "../contracts/voting/src/index.js";

// ---------------------------------------------------------------------------
// comments
// ---------------------------------------------------------------------------

export type {
  DataKey as CommentsDataKey,
  VoteMode as CommentsVoteMode,
  CommentInfo,
  Proof as CommentsProof,
  VerificationKey as CommentsVerificationKey,
} from "../contracts/comments/src/index.js";

export {
  CommentsError as CommentsErrorRaw,
  Groth16Error as CommentsGroth16ErrorRaw,
} from "../contracts/comments/src/index.js";
