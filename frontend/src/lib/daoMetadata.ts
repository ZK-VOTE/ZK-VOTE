// DAO metadata types and utilities for profile/branding management
// ZV-127: Now uses versioned schema with migration support

import { relayerFetch } from "./api";
import { RELAYER_URL } from "../config/env";
import { safeClone } from "./safeMerge";
import {
  type DaoMetadataV2,
  validateAndMigrateMetadata,
  validateMetadataWithDetails,
  type ValidationResult,
  CURRENT_SCHEMA_VERSION,
} from "../../../shared/dao-metadata-schema.js";

/**
 * DAO metadata stored on IPFS (Current Version).
 * Referenced by CID in the on-chain DaoInfo.metadata_cid field.
 * 
 * Note: This now uses the shared versioned schema (V2).
 * Legacy V1 metadata is automatically migrated on fetch.
 */
export type DAOMetadata = DaoMetadataV2;

// Legacy V1 interface for backwards compatibility
export interface DAOMetadataLegacy {
  version: 1;
  description: string;
  coverImageCid?: string;
  profileImageCid?: string;
  themeColor?: string;
  links?: {
    website?: string;
    twitter?: string;
    linkedin?: string;
    github?: string;
  };
  updatedAt: string;
}

export const MAX_DESCRIPTION_LENGTH = 5000; // Updated for V2
export const MAX_NAME_LENGTH = 100; // Updated for V2 (on-chain limit is 24)

/**
 * Validate a DAO metadata object
 * ZV-127: Now uses comprehensive validation with migration support
 */
export function validateDAOMetadata(metadata: Partial<DAOMetadata>): string[] {
  const result = validateMetadataWithDetails(metadata);
  return result.errors || [];
}

/**
 * Get detailed validation result including warnings
 * ZV-127: Returns full validation context for UI display
 */
export function validateDAOMetadataDetailed(
  metadata: Partial<DAOMetadata>,
): ValidationResult {
  return validateMetadataWithDetails(metadata);
}

/**
 * Upload DAO metadata to IPFS
 * ZV-127: Now enforces V2 schema before upload
 */
export async function uploadDAOMetadata(
  metadata: Partial<DAOMetadata>,
): Promise<{ cid: string }> {
  const fullMetadata: DAOMetadata = {
    version: CURRENT_SCHEMA_VERSION,
    name: metadata.name || "",
    description: metadata.description || "",
    ...metadata,
    updatedAt: new Date().toISOString(),
  };

  const errors = validateDAOMetadata(fullMetadata);
  if (errors.length > 0) {
    throw new Error(`Invalid metadata: ${errors.join(", ")}`);
  }

  const response = await relayerFetch("/ipfs/metadata", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fullMetadata),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Failed to upload metadata to IPFS");
  }

  return response.json();
}

/**
 * Fetch DAO metadata from IPFS
 * ZV-127: Automatically migrates legacy V1 metadata to V2
 */
export async function fetchDAOMetadata(
  cid: string,
): Promise<DAOMetadata | null> {
  try {
    const response = await relayerFetch(`/ipfs/${cid}`);
    if (!response.ok) return null;
    const data = await response.json();
    
    // Validate and migrate to current version
    try {
      const migrated = validateAndMigrateMetadata(data);
      return safeClone(migrated) as DAOMetadata;
    } catch (validationError) {
      console.warn("Failed to validate/migrate DAO metadata:", validationError);
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Upload an image to IPFS
 */
export async function uploadImage(file: File): Promise<{ cid: string }> {
  const formData = new FormData();
  formData.append("image", file);

  const response = await relayerFetch("/ipfs/image", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Failed to upload image to IPFS");
  }

  return response.json();
}

/**
 * Get the URL for an IPFS image
 */
export function getImageUrl(cid: string): string {
  return `${RELAYER_URL}/ipfs/image/${cid}`;
}

// URL validation helpers

/**
 * Strict 6-digit hex color check, e.g. "#3b82f6". Deliberately narrow (no
 * named colors, no CSS functions like url()/expression()) since this value
 * gets injected into a CSS custom property at render time (DAOHeader) — the
 * only safe shapes for that are ones this regex fully constrains.
 */
export function isValidHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidTwitter(input: string): boolean {
  // Accept @handle, handle, or full URL
  if (input.startsWith("@")) {
    return /^@[a-zA-Z0-9_]{1,15}$/.test(input);
  }
  if (input.includes("twitter.com") || input.includes("x.com")) {
    return isValidUrl(input);
  }
  // Plain handle
  return /^[a-zA-Z0-9_]{1,15}$/.test(input);
}

function isValidLinkedIn(url: string): boolean {
  if (!isValidUrl(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes("linkedin.com");
  } catch {
    return false;
  }
}

function isValidGitHub(url: string): boolean {
  if (!isValidUrl(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "github.com";
  } catch {
    return false;
  }
}

/**
 * Normalize Twitter handle to consistent format
 */
export function normalizeTwitterHandle(input: string): string {
  if (!input) return "";
  // Extract handle from URL
  if (input.includes("twitter.com") || input.includes("x.com")) {
    try {
      const url = new URL(input);
      const path = url.pathname.replace(/^\//, "").split("/")[0];
      return path ? `@${path}` : input;
    } catch {
      return input;
    }
  }
  // Add @ if missing
  if (!input.startsWith("@")) {
    return `@${input}`;
  }
  return input;
}

/**
 * Get Twitter URL from handle
 */
export function getTwitterUrl(handle: string): string {
  const normalized = handle.replace(/^@/, "");
  return `https://x.com/${normalized}`;
}
