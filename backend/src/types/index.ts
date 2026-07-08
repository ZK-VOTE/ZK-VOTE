/**
 * Shared Type Definitions for ZKVote Backend
 */

import type { Request, Response, NextFunction } from "express";

// ============================================
// EXPRESS EXTENSIONS
// ============================================

declare global {
  namespace Express {
    interface Request {
      ctx?: string; // Request context ID for logging
    }
  }
}

// ============================================
// LOGGING
// ============================================

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogMeta {
  [key: string]: unknown;
}

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
// VOTE TYPES
// ============================================

export interface VoteRequest {
  daoId: number;
  proposalId: number;
  choice: boolean;
  nullifier: U256Hex;
  root: U256Hex;
  proof: Groth16Proof;
}

// ============================================
// COMMENT TYPES
// ============================================

export interface AnonymousCommentRequest {
  daoId: number;
  proposalId: number;
  contentCid: string;
  parentId?: number | null;
  voteChoice: boolean;
  nullifier: U256Hex;
  root: U256Hex;
  proof: Groth16Proof;
}

export interface Comment {
  id: number;
  daoId: number;
  proposalId: number;
  author: string | null;
  nullifier: U256Hex | null;
  contentCid: string;
  parentId: number | null;
  createdAt: number;
  updatedAt: number;
  revisionCids: string[];
  deleted: boolean;
  deletedBy: number; // 0=none, 1=user, 2=admin
  isAnonymous: boolean;
}

// ============================================
// DAO TYPES
// ============================================

export interface Dao {
  id: number;
  name: string;
  creator: string;
  membership_open: boolean;
  members_can_propose: boolean;
  metadata_cid: string | null;
  member_count: number;
  updated_at?: string;
}

export interface DaoWithRole extends Dao {
  role: "admin" | "member" | null;
}

// ============================================
// IPFS TYPES
// ============================================

export interface IpfsUploadResult {
  cid: string;
  size: number;
  filename?: string;
  mimeType?: string;
}

export interface ProposalMetadata {
  version: number;
  body: string;
  videoUrl?: string;
}

export interface CommentMetadata {
  version: number;
  body: string;
  createdAt: string;
}

// ============================================
// REQUEST HANDLER TYPES
// ============================================

export type AsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void | Response>;

// ============================================
// SOROBAN TYPES
// ============================================

export interface RpcHealthResult {
  ok: boolean;
  info?: { status: string };
  error?: string;
}

export interface TransactionResult {
  status: "SUCCESS" | "FAILED" | "NOT_FOUND" | "ERROR";
  ledger?: number;
  errorResult?: unknown;
  hash?: string;
}

// ============================================
// CACHE TYPES
// ============================================

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
}
