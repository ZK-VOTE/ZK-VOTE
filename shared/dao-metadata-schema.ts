/**
 * DAO Metadata Schema Versioning and Validation
 * 
 * ZV-127: Versioned metadata schema with migration rules
 * 
 * Design:
 * - Each schema version has explicit required/optional fields
 * - Legacy metadata can be migrated deterministically to current version
 * - Schema version is embedded in metadata payload
 * - Validation rejects invalid metadata before pinning
 */

import { z } from "zod";

/**
 * Schema Version 1 (Legacy)
 * Initial DAO metadata format - minimal fields
 */
export const DaoMetadataV1Schema = z.object({
  version: z.literal(1).optional().default(1),
  name: z.string().min(1).max(100),
  description: z.string().max(5000).optional(),
  imageUrl: z.string().url().optional(),
});

export type DaoMetadataV1 = z.infer<typeof DaoMetadataV1Schema>;

/**
 * Schema Version 2 (Current)
 * Enhanced metadata with structured fields
 */
export const DaoMetadataV2Schema = z.object({
  version: z.literal(2),
  name: z.string().min(1).max(100),
  description: z.string().max(5000),
  imageUrl: z.string().url().optional(),
  
  // New in V2
  longDescription: z.string().max(50000).optional(),
  website: z.string().url().optional(),
  twitter: z.string().max(100).optional(),
  discord: z.string().max(200).optional(),
  github: z.string().max(200).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
  
  // Governance parameters (informational, on-chain values are authoritative)
  proposalThreshold: z.number().int().positive().optional(),
  votingPeriodDays: z.number().positive().optional(),
  
  // Timestamps
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

export type DaoMetadataV2 = z.infer<typeof DaoMetadataV2Schema>;

/**
 * Union of all schema versions
 */
export type DaoMetadata = DaoMetadataV1 | DaoMetadataV2;

/**
 * Current schema version
 */
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * Migrate V1 metadata to V2
 * Deterministic transformation: same input always produces same output
 */
export function migrateV1ToV2(v1: DaoMetadataV1): DaoMetadataV2 {
  return {
    version: 2,
    name: v1.name,
    description: v1.description ?? "",
    imageUrl: v1.imageUrl,
    // V2-specific fields get defaults
    longDescription: undefined,
    website: undefined,
    twitter: undefined,
    discord: undefined,
    github: undefined,
    tags: undefined,
    proposalThreshold: undefined,
    votingPeriodDays: undefined,
    createdAt: undefined,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Validate and normalize metadata to current version
 * 
 * @param data - Raw metadata object from IPFS or upload
 * @returns Validated metadata in current schema version
 * @throws ZodError if validation fails
 */
export function validateAndMigrateMetadata(data: unknown): DaoMetadataV2 {
  // Try to parse as any known version
  const parsed = z.union([DaoMetadataV1Schema, DaoMetadataV2Schema]).parse(data);
  
  // Migrate to current version if needed
  if (parsed.version === 1 || !('version' in parsed)) {
    return migrateV1ToV2(parsed as DaoMetadataV1);
  }
  
  return parsed as DaoMetadataV2;
}

/**
 * Validate metadata for upload (strict mode)
 * Ensures all required fields are present and valid before pinning
 */
export function validateMetadataForUpload(data: unknown): DaoMetadataV2 {
  const metadata = validateAndMigrateMetadata(data);
  
  // Additional upload-time validations
  if (!metadata.name.trim()) {
    throw new Error("DAO name cannot be empty");
  }
  
  if (metadata.description && metadata.description.length < 10) {
    throw new Error("Description must be at least 10 characters if provided");
  }
  
  // Sanitize URLs
  if (metadata.imageUrl) {
    try {
      new URL(metadata.imageUrl);
    } catch {
      throw new Error("Invalid image URL format");
    }
  }
  
  if (metadata.website) {
    try {
      new URL(metadata.website);
    } catch {
      throw new Error("Invalid website URL format");
    }
  }
  
  return metadata;
}

/**
 * Create minimal valid V2 metadata
 * Useful for testing and defaults
 */
export function createMinimalMetadata(name: string, description: string): DaoMetadataV2 {
  return {
    version: 2,
    name,
    description,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Get schema version from raw metadata
 */
export function getSchemaVersion(data: unknown): number {
  if (typeof data !== 'object' || data === null) {
    return 1; // Assume legacy if unparseable
  }
  
  const obj = data as Record<string, unknown>;
  if ('version' in obj && typeof obj.version === 'number') {
    return obj.version;
  }
  
  return 1; // Legacy format has no version field
}

/**
 * Check if metadata is using current schema version
 */
export function isCurrentVersion(data: unknown): boolean {
  return getSchemaVersion(data) === CURRENT_SCHEMA_VERSION;
}

/**
 * Metadata validation result for display in UI
 */
export interface ValidationResult {
  valid: boolean;
  version: number;
  currentVersion: number;
  needsMigration: boolean;
  errors?: string[];
  warnings?: string[];
  metadata?: DaoMetadataV2;
}

/**
 * Comprehensive validation with detailed results
 * Suitable for UI display and debugging
 */
export function validateMetadataWithDetails(data: unknown): ValidationResult {
  const version = getSchemaVersion(data);
  const needsMigration = version !== CURRENT_SCHEMA_VERSION;
  const errors: string[] = [];
  const warnings: string[] = [];
  
  try {
    const metadata = validateAndMigrateMetadata(data);
    
    // Add warnings for missing optional but recommended fields
    if (!metadata.description || metadata.description.length < 50) {
      warnings.push("Description is very short - consider adding more details");
    }
    
    if (!metadata.imageUrl) {
      warnings.push("No image URL provided - consider adding a logo");
    }
    
    if (needsMigration) {
      warnings.push(`Metadata schema was migrated from v${version} to v${CURRENT_SCHEMA_VERSION}`);
    }
    
    return {
      valid: true,
      version,
      currentVersion: CURRENT_SCHEMA_VERSION,
      needsMigration,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      metadata,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      errors.push(...error.errors.map(e => `${e.path.join('.')}: ${e.message}`));
    } else if (error instanceof Error) {
      errors.push(error.message);
    } else {
      errors.push("Unknown validation error");
    }
    
    return {
      valid: false,
      version,
      currentVersion: CURRENT_SCHEMA_VERSION,
      needsMigration,
      errors,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }
}
