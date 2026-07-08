// DAO metadata types and utilities for profile/branding management

import { relayerFetch } from "./api";

/**
 * DAO metadata stored on IPFS.
 * Referenced by CID in the on-chain DaoInfo.metadata_cid field.
 */
export interface DAOMetadata {
  version: 1;
  description: string; // Markdown, max 1000 chars
  coverImageCid?: string; // IPFS CID for cover photo
  profileImageCid?: string; // IPFS CID for profile photo
  links?: {
    website?: string;
    twitter?: string; // x.com handle or URL
    linkedin?: string; // LinkedIn URL
    github?: string; // GitHub org/user URL
  };
  updatedAt: string; // ISO 8601 timestamp
}

export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_NAME_LENGTH = 24;

/**
 * Validate a DAO metadata object
 */
export function validateDAOMetadata(metadata: Partial<DAOMetadata>): string[] {
  const errors: string[] = [];

  if (
    metadata.description &&
    metadata.description.length > MAX_DESCRIPTION_LENGTH
  ) {
    errors.push(`Description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
  }

  if (metadata.links) {
    if (metadata.links.website && !isValidUrl(metadata.links.website)) {
      errors.push("Invalid website URL");
    }
    if (metadata.links.twitter && !isValidTwitter(metadata.links.twitter)) {
      errors.push("Invalid Twitter/X handle or URL");
    }
    if (metadata.links.linkedin && !isValidLinkedIn(metadata.links.linkedin)) {
      errors.push("Invalid LinkedIn URL");
    }
    if (metadata.links.github && !isValidGitHub(metadata.links.github)) {
      errors.push("Invalid GitHub URL");
    }
  }

  return errors;
}

/**
 * Upload DAO metadata to IPFS
 */
export async function uploadDAOMetadata(
  metadata: Omit<DAOMetadata, "version" | "updatedAt">,
): Promise<{ cid: string }> {
  const fullMetadata: DAOMetadata = {
    version: 1,
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
 */
export async function fetchDAOMetadata(
  cid: string,
): Promise<DAOMetadata | null> {
  try {
    const response = await relayerFetch(`/ipfs/${cid}`);
    if (!response.ok) return null;
    const data = await response.json();
    // Validate it's actually DAO metadata
    if (data.version === 1 && typeof data.description === "string") {
      return data as DAOMetadata;
    }
    return null;
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
  const relayerUrl =
    import.meta.env.VITE_RELAYER_URL || "http://localhost:3001";
  return `${relayerUrl}/ipfs/image/${cid}`;
}

// URL validation helpers

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
