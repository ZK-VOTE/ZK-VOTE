/**
 * OpenAPI 3.1 Specification for ZKVote Backend (Task #339)
 *
 * Source of truth: the committed `backend/openapi.json` (generated docs for
 * every versioned route). `buildOpenApiDocument()` returns that document so
 * the served `/api-docs/openapi.json`, the ``docs:*`` scripts, and the doc
 * itself stay byte-for-byte consistent (see scripts/generate-openapi.ts).
 *
 * Also exports the zod *response* schemas used to validate live responses in
 * test/openapi-validation.test.js, and `ENDPOINTS` (method + route for every
 * documented path) used for API.md coverage and docs accounting.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// ============================================
// ZOD RESPONSE SCHEMAS
// ============================================

/** GET /health — 200 */
export const healthResponseSchema = z
  .object({
    status: z.string(),
    rpc: z
      .object({
        ok: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

/** GET /ready — 200 */
export const readyResponseSchema = z
  .object({
    status: z.string(),
  })
  .passthrough();

/** GET /config — 200 */
export const configResponseSchema = z
  .object({
    networkPassphrase: z.string(),
    rpcUrl: z.string(),
    ipfsEnabled: z.boolean(),
  })
  .passthrough();

/** GET /daos — 200 */
export const daosListResponseSchema = z
  .object({
    data: z.array(z.record(z.string(), z.unknown())),
    pagination: z
      .object({
        cursor: z.string().nullable().optional(),
        hasMore: z.boolean(),
        total: z.number(),
      })
      .passthrough(),
    lastSync: z.string().nullable(),
    cached: z.boolean(),
  })
  .passthrough();

/** Shared error body ({ error, ... }) used across error responses. */
export const errorResponseSchema = z
  .object({
    error: z.string(),
  })
  .passthrough();

// ============================================
// ENDPOINTS — every documented route
// ============================================

export interface Endpoint {
  method: "GET" | "POST";
  path: string;
}

/**
 * Every route documented in the OpenAPI document, using Express-style
 * `:param` segments to match the prose headers in backend/API.md.
 */
export const ENDPOINTS: Endpoint[] = [
  { method: "GET", path: "/health" },
  { method: "GET", path: "/ready" },
  { method: "GET", path: "/config" },
  { method: "GET", path: "/db/stats" },
  { method: "POST", path: "/vote" },
  { method: "GET", path: "/proposal/:daoId/:proposalId" },
  { method: "GET", path: "/root/:daoId" },
  { method: "POST", path: "/comment/anonymous" },
  { method: "GET", path: "/comment/challenge/:commitment" },
  { method: "GET", path: "/comments/:daoId/:proposalId/nonce" },
  { method: "GET", path: "/comments/:daoId/:proposalId" },
  { method: "GET", path: "/comment/:daoId/:proposalId/:commentId" },
  { method: "POST", path: "/comment/edit" },
  { method: "POST", path: "/comment/delete" },
  { method: "POST", path: "/comment/flag" },
  { method: "GET", path: "/daos" },
  { method: "GET", path: "/dao/:daoId" },
  { method: "POST", path: "/daos/sync" },
  { method: "GET", path: "/ipfs/health" },
  { method: "POST", path: "/ipfs/image" },
  { method: "POST", path: "/ipfs/metadata" },
  { method: "GET", path: "/ipfs/:cid" },
  { method: "GET", path: "/ipfs/image/:cid" },
  { method: "GET", path: "/events/archived" },
  { method: "GET", path: "/events/archived/:archiveId" },
  { method: "GET", path: "/events/:daoId" },
  { method: "GET", path: "/indexer/status" },
  { method: "GET", path: "/indexer/daos" },
  { method: "POST", path: "/events" },
  { method: "POST", path: "/events/notify" },
  { method: "POST", path: "/bridge/vote" },
  { method: "GET", path: "/bridge/nullifier/:daoId/:proposalId/:nullifier" },
  { method: "POST", path: "/bridge/relay" },
  { method: "GET", path: "/circuits/:dao/:type/status" },
  { method: "GET", path: "/admin/audit-log" },
  { method: "GET", path: "/admin/sbt-transfer-attempts" },
];

// ============================================
// DOCUMENT — reads the committed generated spec
// ============================================

/**
 * Path to the committed OpenAPI document relative to this module
 * (`src/openapi.ts` -> `backend/openapi.json`).
 */
const OPENAPI_JSON_PATH = fileURLToPath(
  new URL("../openapi.json", import.meta.url),
);

let cachedDocument: Record<string, unknown> | null = null;

/**
 * Returns the full OpenAPI 3.1 document (all versioned routes).
 *
 * Loaded from the committed `backend/openapi.json` so the served spec and the
 * `docs:*` scripts share a single source of truth.
 */
export function buildOpenApiDocument(): Record<string, unknown> {
  if (!cachedDocument) {
    cachedDocument = JSON.parse(fs.readFileSync(OPENAPI_JSON_PATH, "utf-8"));
  }
  return cachedDocument as Record<string, unknown>;
}

/** The complete OpenAPI spec (default export for app server integration). */
export const openApiSpec = buildOpenApiDocument();

  for (const ep of ENDPOINTS) {
    const responses: Record<string, ResponseConfig> = {
      200: {
        description: "Success",
        content: {
          "application/json": {
            schema: ep.responseSchema ?? z.any(),
            example: ep.responseExample,
          },
        },
      },
    };

    for (const status of ep.errorStatuses ?? []) {
      responses[status] = {
        description: `Error (HTTP ${status})`,
        content: { "application/json": { schema: errorResponseSchema } },
      };
    }

    registry.registerPath({
      method: ep.method,
      path: toOpenApiPath(ep.path),
      tags: [ep.tag],
      summary: ep.summary,
      description: ep.rateLimit
        ? `Rate limit: ${ep.rateLimit}.`
        : "No rate limit.",
      security: ep.auth ? [{ [SECURITY_SCHEME]: [] }] : [],
      request: {
        ...(ep.params ? { params: z.object(ep.params) } : {}),
        ...(ep.query ? { query: z.object(ep.query) } : {}),
        ...(ep.body
          ? { body: { content: { "application/json": { schema: ep.body } } } }
          : {}),
      },
      responses,
    });
  }

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "ZK-VOTE Relayer API",
      version: "1.0.0",
      description:
        "Backend relayer for anonymous voting on Stellar/Soroban. Generated from route " +
        "definitions and Zod validation schemas — see backend/API.md for prose docs and " +
        "GET /api-docs for interactive documentation.",
    },
    servers: [
      { url: "http://localhost:3001", description: "Local development" },
    ],
  });
}
