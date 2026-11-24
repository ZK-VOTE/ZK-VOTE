import { ErrorCode } from "../types/index.js";

export class ApiError extends Error {
  public statusCode: number;
  public code: ErrorCode;
  public details?: unknown;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export interface MappedContractError {
  statusCode: number;
  code: ErrorCode;
  message: string;
}

/**
 * Maps on-chain contract error codes and messages (per docs/error-codes.md)
 * to structured HTTP status codes and ErrorCode enums, preventing raw 500s.
 */
export function mapContractError(err: unknown): MappedContractError | null {
  if (!err) return null;
  const msg = err instanceof Error ? err.message : String(err);

  if (/NameTooLong|Error\(Contract,\s*#?1\)/i.test(msg) || /DAO name exceeds/i.test(msg)) {
    return { statusCode: 400, code: ErrorCode.VALIDATION_ERROR, message: "DAO name exceeds 24 character limit" };
  }
  if (/DaoNotFound/i.test(msg)) {
    return { statusCode: 404, code: ErrorCode.DAO_NOT_FOUND, message: "DAO with given ID doesn't exist" };
  }
  if (/NotAdmin|NotDaoAdmin/i.test(msg)) {
    return { statusCode: 403, code: ErrorCode.UNAUTHORIZED, message: "Caller is not the DAO admin" };
  }
  if (/MetadataCidTooLong/i.test(msg)) {
    return { statusCode: 400, code: ErrorCode.VALIDATION_ERROR, message: "Metadata CID exceeds 64 character limit" };
  }
  if (/TitleTooLong/i.test(msg)) {
    return { statusCode: 400, code: ErrorCode.VALIDATION_ERROR, message: "Proposal title exceeds limit (100 bytes)" };
  }
  if (/NotDaoMember|NotMember/i.test(msg)) {
    return { statusCode: 403, code: ErrorCode.NOT_ELIGIBLE, message: "Caller is not a member of this DAO" };
  }
  if (/EndTimeInvalid/i.test(msg)) {
    return { statusCode: 400, code: ErrorCode.VALIDATION_ERROR, message: "Proposal end time must be in the future" };
  }
  if (/NullifierUsed/i.test(msg)) {
    return { statusCode: 409, code: ErrorCode.VOTE_ALREADY_CAST, message: "Vote already cast (nullifier used)" };
  }
  if (/VotingClosed/i.test(msg)) {
    return { statusCode: 400, code: ErrorCode.VOTING_PERIOD_CLOSED, message: "Voting period has ended" };
  }
  if (/InvalidProof|RootMismatch|RootNotInHistory/i.test(msg)) {
    return { statusCode: 400, code: ErrorCode.INVALID_PROOF, message: "Proof verification failed or root invalid" };
  }
  if (/CommitmentRevoked/i.test(msg)) {
    return { statusCode: 403, code: ErrorCode.NOT_ELIGIBLE, message: "Member commitment was revoked" };
  }
  return null;
}
