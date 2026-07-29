# ZKVote Backend API Reference

Base URL: `http://localhost:3001` (default)

Interactive documentation (Swagger UI) is served at `GET /api-docs`, backed by an OpenAPI 3.1 spec at `GET /api-docs/openapi.json` — generated from the routes and Zod validation schemas in `src/openapi.ts`. Run `npm run docs:generate` after changing a route or schema to regenerate `openapi.json` and the TypeScript types in `src/generated/api-types.ts`; `npm run docs:check` (run in CI) fails if `openapi.json` is stale or if this file is missing a section for an endpoint in the spec.

## Authentication

Write endpoints require a relayer auth token (minimum 32 characters). The token is passed via one of two headers:

- `X-Relayer-Auth: <token>`
- `Authorization: Bearer <token>`

Token comparison uses constant-time operations to prevent timing attacks.

Unauthenticated requests to protected endpoints receive:

```json
{ "error": "Unauthorized" }
```

**Status:** `401 Unauthorized`

## Rate Limits

All rate limiters use a 1-minute sliding window keyed by hashed IP address. Every response includes both the modern `RateLimit-*` (draft-6) headers and the legacy `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset` headers.

| Limiter          | Max Requests / min | Applied To                                     |
|------------------|--------------------|-------------------------------------------------|
| `voteLimiter`    | 10                 | `POST /vote`                                    |
| `commentLimiter` | 20                 | `POST /comment/anonymous`, `/comment/edit`, `/comment/delete` |
| `queryLimiter`   | 60                 | All GET endpoints (except IPFS reads)            |
| `ipfsUploadLimiter` | 10              | `POST /ipfs/image`, `POST /ipfs/metadata`       |
| `ipfsReadLimiter`| 200                | `GET /ipfs/:cid`, `GET /ipfs/image/:cid`         |

Before a client hits a hard limit above, a global graduated-throttling layer adds an increasing delay (100ms per request past 40/min, capped at 3s) to every request. This gives well-behaved clients a chance to back off before being blocked outright.

Rate limit exceeded response includes a `Retry-After` header (seconds) and structured info in the body:

```json
{
  "error": "Too many requests, please try again later",
  "limiter": "query",
  "limit": 60,
  "remaining": 0,
  "retryAfter": 42,
  "resetTime": "2026-07-28T13:38:09.690Z"
}
```

**Status:** `429 Too Many Requests`

The frontend's `relayerFetch` (`frontend/src/lib/api.ts`) already reads the `Retry-After` header and backs off automatically before retrying.

Per-limiter request/block counters are available to authenticated callers via `GET /health` (`rateLimits` field).

## Errors

All endpoints return a structured error response when a request fails.

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable error message",
    "details": { "optional": "additional context" },
    "requestId": "abc123456789",
    "timestamp": "2026-07-28T13:38:09.690Z"
  }
}
```

When the `RELAYER_GENERIC_ERRORS` environment variable is set to `true`, the `details` field is omitted to prevent leaking sensitive information.

### Error Codes

| Code | Description |
|------|-------------|
| `VOTE_ALREADY_CAST` | The voter has already cast a vote on the given proposal. |
| `VOTING_PERIOD_CLOSED` | The proposal is no longer accepting votes. |
| `INVALID_PROOF` | The ZK proof is invalid or malformed. |
| `NOT_ELIGIBLE` | The voter's root does not match the DAO's state, meaning they are not eligible to vote. |
| `PROPOSAL_NOT_FOUND` | The specified proposal does not exist. |
| `DAO_NOT_FOUND` | The specified DAO does not exist. |
| `RATE_LIMITED` | The client has exceeded the rate limit. |
| `UNAUTHORIZED` | The request lacks a valid authentication token. |
| `VALIDATION_ERROR` | The request payload or parameters are invalid. |
| `SERVICE_UNAVAILABLE` | An external dependency (e.g., Soroban RPC) is unreachable. |
| `TIMEOUT` | The request took too long to complete. |
| `NOT_FOUND` | The requested resource does not exist. |
| `INTERNAL_ERROR` | An unexpected server error occurred. |

## CORS

Allowed methods: `GET`, `POST`
Allowed headers: `Content-Type`, `Authorization`, `X-Relayer-Auth`

Origin is configurable via the `CORS_ORIGIN` environment variable (comma-separated list, or `*` for all origins).

## CSRF Protection

When `CORS_ORIGIN` is configured, the server validates the `Origin` header on mutating requests. Requests from disallowed origins are rejected.

---

## Health

### GET /health

Basic health check. Returns server status and RPC connectivity.

**Authentication:** No
**Rate Limit:** None

#### Response (200)

```json
{
  "status": "ok",
  "rpc": { "ok": true, "info": { "status": "healthy" } }
}
```

When `HEALTH_EXPOSE_DETAILS` is enabled and a valid auth token is provided, additional fields are included:

```json
{
  "status": "ok",
  "rpc": { "ok": true },
  "relayer": "GABCDEF...",
  "votingContract": "CABCDEF...",
  "treeContract": "CABCDEF...",
  "vkVersion": 1
}
```

---

### GET /ready

Readiness probe. Verifies RPC connectivity before reporting ready.

**Authentication:** No
**Rate Limit:** None

#### Response (200)

```json
{
  "status": "ready"
}
```

#### Response (503) -- RPC unavailable

```json
{
  "status": "degraded",
  "rpc": { "ok": false, "error": "Connection refused" }
}
```

---

### GET /config

Returns public configuration for the frontend. No sensitive data is exposed.

**Authentication:** No
**Rate Limit:** None

#### Response (200)

```json
{
  "votingContract": "CABCDEF...",
  "treeContract": "CABCDEF...",
  "commentsContract": "CABCDEF...",
  "daoRegistryContract": "CABCDEF...",
  "membershipSbtContract": "CABCDEF...",
  "networkPassphrase": "Standalone Network ; February 2017",
  "rpcUrl": "http://localhost:8000/soroban/rpc",
  "ipfsEnabled": true,
  "pinataGateway": "https://gateway.pinata.cloud"
}
```

---

### GET /db/stats

Database diagnostics (query metrics, table stats, cache stats). Full detail requires auth; unauthenticated callers get aggregate DB status only.

**Authentication:** Optional (gates detail level)
**Rate Limit:** None

#### Response (200) -- Authenticated

```json
{
  "queries": {},
  "tables": [],
  "cache": {},
  "config": {},
  "partitions": 0,
  "largeDaos": 0
}
```

#### Response (200) -- Unauthenticated

```json
{ "status": "unauthorized", "db": { "totalEvents": 0, "daoCount": 0, "lastLedger": 0 } }
```

---

## Voting

### POST /vote

Submit an anonymous vote with a ZK proof. The backend relayer signs and submits the transaction on behalf of the voter to preserve anonymity.

**Authentication:** Yes
**Rate Limit:** 10/min (voteLimiter)

#### Request Body

| Field        | Type     | Required | Description                                      |
|--------------|----------|----------|--------------------------------------------------|
| `daoId`      | `number` | Yes      | Non-negative integer DAO identifier               |
| `proposalId` | `number` | Yes      | Non-negative integer proposal identifier          |
| `choice`     | `boolean`| Yes      | `true` for yes, `false` for no                    |
| `nullifier`  | `string` | Yes      | Hex string (with optional `0x` prefix), must be < BN254 field modulus |
| `root`       | `string` | Yes      | Merkle root hex string, must be < BN254 field modulus |
| `proof`      | `object` | Yes      | Groth16 proof (see below)                         |

**Proof object:**

| Field | Type     | Description                                                      |
|-------|----------|------------------------------------------------------------------|
| `a`   | `string` | G1 point, up to 128 hex chars (64 bytes: X \|\| Y, big-endian). Must not be all zeros. |
| `b`   | `string` | G2 point, up to 256 hex chars (128 bytes: X_c1 \|\| X_c0 \|\| Y_c1 \|\| Y_c0, big-endian). Must not be all zeros. |
| `c`   | `string` | G1 point, up to 128 hex chars (64 bytes: X \|\| Y, big-endian). Must not be all zeros. |

#### Example Request

```bash
curl -X POST http://localhost:3001/vote \
  -H "Content-Type: application/json" \
  -H "X-Relayer-Auth: your-auth-token-here" \
  -d '{
    "daoId": 0,
    "proposalId": 1,
    "choice": true,
    "nullifier": "1a2b3c...",
    "root": "4d5e6f...",
    "proof": {
      "a": "0a1b2c...64bytes_hex",
      "b": "0a1b2c...128bytes_hex",
      "c": "0a1b2c...64bytes_hex"
    }
  }'
```

#### Response (200) -- Success

```json
{
  "success": true,
  "txHash": "abc123...64hex",
  "status": "SUCCESS"
}
```

#### Error Responses

| Status | Error                          | Cause                                 |
|--------|--------------------------------|---------------------------------------|
| 400    | Validation error details       | Invalid request body (Zod validation) |
| 400    | `"You have already voted on this proposal"` | Duplicate nullifier             |
| 400    | `"Voting period has ended"`    | Proposal is closed                    |
| 400    | `"Invalid vote proof"`         | Proof verification failed             |
| 400    | `"You are not eligible to vote on this proposal"` | Root mismatch           |
| 400    | `"Proposal not found"`         | Unknown proposal                      |
| 500    | `"Transaction failed"`         | On-chain transaction failed           |
| 500    | `"Transaction submission failed"` | RPC submission error               |
| 503    | `"Blockchain RPC temporarily unavailable - please retry"` | RPC down       |
| 504    | `"Request timeout - please try again"` | Operation timed out              |

---

### GET /proposal/:daoId/:proposalId

Get vote results for a specific proposal.

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Path Parameters

| Parameter    | Type     | Description              |
|--------------|----------|--------------------------|
| `daoId`      | `string` | DAO identifier (integer) |
| `proposalId` | `string` | Proposal identifier (integer) |

#### Example Request

```bash
curl http://localhost:3001/proposal/0/1
```

#### Response (200)

```json
{
  "daoId": 0,
  "proposalId": 1,
  "yesVotes": "5",
  "noVotes": "3",
  "closed": false
}
```

#### Error Responses

| Status | Error                            | Cause                 |
|--------|----------------------------------|-----------------------|
| 404    | `"Proposal not found"`           | Unknown DAO/proposal  |
| 500    | `"Failed to fetch proposal results"` | RPC or parsing error |

---

### GET /root/:daoId

Get the current Merkle root for a DAO's membership tree.

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Path Parameters

| Parameter | Type     | Description              |
|-----------|----------|--------------------------|
| `daoId`   | `string` | DAO identifier (integer) |

#### Example Request

```bash
curl http://localhost:3001/root/0
```

#### Response (200)

```json
{
  "daoId": 0,
  "root": "1a2b3c4d...64hex"
}
```

#### Error Responses

| Status | Error                                     | Cause                   |
|--------|-------------------------------------------|-------------------------|
| 404    | `"DAO not found or tree not initialized"` | Unknown DAO or no tree  |
| 500    | `"Failed to fetch Merkle root"`           | RPC error               |

---

## Comments

### GET /comment/challenge/:commitment

Get a proof-of-work challenge for a commitment, required before submitting an anonymous comment or flag (anti-spam).

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Response (200)

```json
{ "serverId": "abc123", "difficulty": 20, "expiresAt": 1785200000000 }
```

---

### POST /comment/anonymous

Submit an anonymous comment with a ZK proof. The relayer submits the transaction to preserve the commenter's anonymity.

**Authentication:** Yes
**Rate Limit:** 20/min (commentLimiter)

#### Request Body

| Field        | Type             | Required | Description                                      |
|--------------|------------------|----------|--------------------------------------------------|
| `daoId`      | `number`         | Yes      | Non-negative integer DAO identifier               |
| `proposalId` | `number`         | Yes      | Non-negative integer proposal identifier          |
| `contentCid` | `string`         | Yes      | IPFS CID of comment content (CIDv0 `Qm...` or CIDv1 `bafy.../bafk...`) |
| `parentId`   | `number \| null` | No       | Parent comment ID for replies (null for top-level)|
| `voteChoice` | `boolean`        | Yes      | Vote alignment (`true` = yes, `false` = no)       |
| `nullifier`  | `string`         | Yes      | Hex string < BN254 field modulus                  |
| `root`       | `string`         | Yes      | Merkle root hex string < BN254 field modulus      |
| `proof`      | `object`         | Yes      | Groth16 proof object (same format as vote proof)  |

#### Example Request

```bash
curl -X POST http://localhost:3001/comment/anonymous \
  -H "Content-Type: application/json" \
  -H "X-Relayer-Auth: your-auth-token-here" \
  -d '{
    "daoId": 0,
    "proposalId": 1,
    "contentCid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    "parentId": null,
    "voteChoice": true,
    "nullifier": "1a2b3c...",
    "root": "4d5e6f...",
    "proof": {
      "a": "...",
      "b": "...",
      "c": "..."
    }
  }'
```

#### Response (200) -- Success

```json
{
  "success": true,
  "commentId": 42,
  "txHash": "abc123...64hex"
}
```

#### Error Responses

| Status | Error                                                   | Cause                     |
|--------|---------------------------------------------------------|---------------------------|
| 400    | Validation error details                                | Invalid request body      |
| 400    | `"Failed to add anonymous comment (proof verification failed or invalid membership)"` | Simulation failed |
| 500    | `"Transaction submission failed"`                       | RPC submission error      |
| 503    | `"Blockchain RPC temporarily unavailable - please retry"` | RPC down               |
| 504    | `"Request timeout - please try again"`                  | Operation timed out       |

---

### GET /comments/:daoId/:proposalId

Get comments for a proposal with limit/offset pagination.

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Path Parameters

| Parameter    | Type     | Description              |
|--------------|----------|--------------------------|
| `daoId`      | `string` | DAO identifier (integer) |
| `proposalId` | `string` | Proposal identifier (integer) |

#### Query Parameters

| Parameter | Type     | Default | Description                                      |
|-----------|----------|---------|--------------------------------------------------|
| `limit`   | `number` | `100`   | Max comments per page (max `500`)            |
| `cursor`  | `string` | none    | Opaque cursor for fetching next page        |

#### Example Request

```bash
curl "http://localhost:3001/comments/0/1?limit=20"
```

#### Response (200)

```json
{
  "data": [
    {
      "id": 1,
      "daoId": 0,
      "proposalId": 1,
      "author": null,
      "nullifier": "1a2b3c...",
      "contentCid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      "parentId": null,
      "createdAt": 1700000000,
      "updatedAt": 1700000000,
      "revisionCids": [],
      "deleted": false,
      "deletedBy": 0,
      "isAnonymous": true
    }
  ],
  "pagination": {
    "cursor": "20",
    "hasMore": true,
    "total": 42
  }
}
```

When `hasMore` is `false`, there are no additional pages.

#### Error Responses

| Status | Error                         | Cause              |
|--------|-------------------------------|---------------------|
| 400    | `"Failed to get comments"`    | Simulation failed   |
| 500    | `"Failed to fetch comments"`  | RPC error           |

---

### GET /comment/:daoId/:proposalId/:commentId

Get a single comment by ID.

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Path Parameters

| Parameter    | Type      | Description              | Format |
|--------------|-----------|--------------------------|---------|
| `daoId`      | `integer` | DAO identifier           | Positive integer (1+) |
| `proposalId` | `integer` | Proposal identifier      | Positive integer (1+) |
| `commentId`  | `integer` | Comment identifier       | Positive integer (1+) |

#### Example Request

```bash
curl http://localhost:3001/comment/0/1/42
```

#### Response (200)

```json
{
  "id": 42,
  "daoId": 0,
  "proposalId": 1,
  "author": null,
  "contentCid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  "parentId": null,
  "createdAt": 1700000000,
  "updatedAt": 1700000000,
  "revisionCids": [],
  "deleted": false,
  "deletedBy": 0,
  "isAnonymous": true
}
```

#### Error Responses

| Status | Error                        | Cause              |
|--------|------------------------------|---------------------|
| 404    | `"Comment not found"`        | Unknown comment     |
| 500    | `"Failed to fetch comment"`  | RPC error           |

---

### GET /comments/:daoId/:proposalId/nonce

Get the next comment nonce for a given commitment. Used by the frontend to construct ZK proofs for anonymous comments.

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Path Parameters

| Parameter    | Type     | Description              |
|--------------|----------|--------------------------|
| `daoId`      | `string` | DAO identifier (integer) |
| `proposalId` | `string` | Proposal identifier (integer) |

#### Query Parameters

| Parameter    | Type     | Required | Description                          |
|--------------|----------|----------|--------------------------------------|
| `commitment` | `string` | Yes      | Hex string < BN254 field modulus     |

#### Example Request

```bash
curl "http://localhost:3001/comments/0/1/nonce?commitment=1a2b3c..."
```

#### Response (200)

```json
{
  "nonce": 3
}
```

Returns `{ "nonce": 0 }` if the commitment has not been used or on error (fails open).

#### Error Responses

| Status | Error                                        | Cause                  |
|--------|----------------------------------------------|------------------------|
| 400    | `"commitment query parameter is required"`   | Missing commitment     |

---

### POST /comment/edit

Edit a public (non-anonymous) comment. Only the original author can edit their comment.

**Authentication:** Yes
**Rate Limit:** 20/min (commentLimiter)

#### Request Body

| Field           | Type     | Required | Description                                      |
|-----------------|----------|----------|--------------------------------------------------|
| `daoId`         | `number` | Yes      | Non-negative integer DAO identifier               |
| `proposalId`    | `number` | Yes      | Non-negative integer proposal identifier          |
| `commentId`     | `number` | Yes      | Non-negative integer comment identifier           |
| `newContentCid` | `string` | Yes      | New IPFS CID for the updated comment content      |
| `author`        | `string` | Yes      | Stellar address of the comment author (`G...`)    |

#### Example Request

```bash
curl -X POST http://localhost:3001/comment/edit \
  -H "Content-Type: application/json" \
  -H "X-Relayer-Auth: your-auth-token-here" \
  -d '{
    "daoId": 0,
    "proposalId": 1,
    "commentId": 42,
    "newContentCid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    "author": "GABCDEF..."
  }'
```

#### Response (200) -- Success

```json
{
  "success": true,
  "txHash": "abc123...64hex"
}
```

#### Error Responses

| Status | Error                                          | Cause                      |
|--------|-------------------------------------------------|----------------------------|
| 400    | `"Missing required fields"`                     | Incomplete request body    |
| 400    | `"Failed to edit comment"`                       | Simulation failed          |
| 403    | `"Author is not a current DAO member"`           | Real-time membership check failed (only when `MEMBERSHIP_SBT_CONTRACT_ID` is configured — see [Membership Verification](#membership-verification)) |
| 500    | `"Transaction submission failed"`                | RPC submission error       |
| 500    | `"Transaction failed"`                          | On-chain failure           |
| 503    | `"Membership verification unavailable, please retry"` | On-chain membership check itself failed (RPC error) |

---

### POST /comment/delete

Delete a public (non-anonymous) comment. Only the original author or a DAO admin can delete.

**Authentication:** Yes
**Rate Limit:** 20/min (commentLimiter)

#### Request Body

| Field        | Type     | Required | Description                                      |
|--------------|----------|----------|--------------------------------------------------|
| `daoId`      | `number` | Yes      | Non-negative integer DAO identifier               |
| `proposalId` | `number` | Yes      | Non-negative integer proposal identifier          |
| `commentId`  | `number` | Yes      | Non-negative integer comment identifier           |
| `author`     | `string` | Yes      | Stellar address of the requester (`G...`)         |

#### Example Request

```bash
curl -X POST http://localhost:3001/comment/delete \
  -H "Content-Type: application/json" \
  -H "X-Relayer-Auth: your-auth-token-here" \
  -d '{
    "daoId": 0,
    "proposalId": 1,
    "commentId": 42,
    "author": "GABCDEF..."
  }'
```

#### Response (200) -- Success

```json
{
  "success": true,
  "txHash": "abc123...64hex"
}
```

#### Error Responses

| Status | Error                                          | Cause                      |
|--------|-------------------------------------------------|----------------------------|
| 400    | `"Missing required fields"`                     | Incomplete request body    |
| 400    | `"Failed to delete comment"`                     | Simulation failed          |
| 403    | `"Author is not a current DAO member"`           | Real-time membership check failed (only when `MEMBERSHIP_SBT_CONTRACT_ID` is configured — see [Membership Verification](#membership-verification)) |
| 500    | `"Transaction submission failed"`                | RPC submission error       |
| 500    | `"Transaction failed"`                          | On-chain failure           |
| 503    | `"Membership verification unavailable, please retry"` | On-chain membership check itself failed (RPC error) |

---

### POST /comment/flag

Flag a comment as spam. Comments are auto-hidden once `flagCount` reaches `FLAG_THRESHOLD` (default 3). Requires a (lower-difficulty) proof-of-work challenge, same as anonymous comments.

**Authentication:** Yes
**Rate Limit:** 20/min (commentLimiter)

#### Request Body

| Field               | Type     | Required | Description                          |
|---------------------|----------|----------|---------------------------------------|
| `daoId`             | `number` | Yes      | Non-negative integer DAO identifier   |
| `proposalId`        | `number` | Yes      | Non-negative integer proposal identifier |
| `commentId`         | `number` | Yes      | Non-negative integer comment identifier |
| `flaggerCommitment` | `string` | Yes      | BN254 field element                   |
| `flaggerNullifier`  | `string` | Yes      | BN254 field element                   |
| `serverId`          | `string` | Yes      | PoW challenge server ID               |
| `workNonce`         | `string` | Yes      | PoW solution nonce                    |

#### Response (200)

```json
{ "success": true, "hidden": false, "flagCount": 1, "threshold": 3 }
```

---

## DAOs

### GET /daos

Get cached DAOs with limit/offset pagination. Optionally include the requesting user's membership role for each DAO.

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Query Parameters

| Parameter | Type     | Required | Description                                      |
|-----------|----------|----------|--------------------------------------------------|
| `user`    | `string` | No       | Stellar address (`G...`). When provided, each DAO includes a `role` field. |
| `limit`   | `number` | No       | Max DAOs per page (max `500`, default `100`)  |
| `cursor`  | `string` | No       | Opaque cursor for fetching next page        |

#### Example Request

```bash
# Without user context
curl http://localhost:3001/daos

# With user membership info
curl "http://localhost:3001/daos?user=GABCDEF..."

# Paginated request
curl "http://localhost:3001/daos?limit=20"
```

#### Response (200)

```json
{
  "data": [
    {
      "id": 0,
      "name": "My DAO",
      "creator": "GABCDEF...",
      "membership_open": true,
      "members_can_propose": true,
      "metadata_cid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      "member_count": 12,
      "updated_at": "2025-01-01T00:00:00Z"
    }
  ],
  "pagination": {
    "cursor": "100",
    "hasMore": true,
    "total": 150
  },
  "lastSync": "2025-01-01T00:00:00Z",
  "cached": true
}
```

When `hasMore` is `false`, there are no additional pages. The `cursor` value should be passed as the `cursor` query parameter on the next request.

The `role` field (when `user` is provided) can be:
- `"admin"` -- User is the DAO admin
- `"member"` -- User holds a membership SBT
- `null` -- User is not a member

#### Error Responses

| Status | Error                              | Cause                      |
|--------|------------------------------------|----------------------------|
| 400    | `"Invalid Stellar address format"` | Malformed `user` parameter |
| 500    | `"Failed to get DAOs"`           | Internal error             |

---

### GET /dao/:daoId

Get a single DAO by ID from the cache.

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Path Parameters

| Parameter | Type     | Description              |
|-----------|----------|--------------------------|
| `daoId`   | `string` | DAO identifier (integer) |

#### Example Request

```bash
curl http://localhost:3001/dao/0
```

#### Response (200)

```json
{
  "dao": {
    "id": 0,
    "name": "My DAO",
    "creator": "GABCDEF...",
    "membership_open": true,
    "members_can_propose": true,
    "metadata_cid": null,
    "member_count": 12
  },
  "cached": true
}
```

#### Error Responses

| Status | Error                         | Cause              |
|--------|-------------------------------|---------------------|
| 404    | `"DAO not found in cache"`    | Unknown DAO ID      |
| 500    | `"Failed to get DAO"`         | Internal error      |

---

### POST /daos/sync

Trigger a manual sync of DAOs from the on-chain registry. Useful after creating a new DAO.

**Authentication:** Yes
**Rate Limit:** None

#### Example Request

```bash
curl -X POST http://localhost:3001/daos/sync \
  -H "X-Relayer-Auth: your-auth-token-here"
```

#### Response (200)

```json
{
  "success": true,
  "synced": 5
}
```

#### Error Responses

| Status | Error                     | Cause              |
|--------|---------------------------|---------------------|
| 500    | `"Failed to sync DAOs"`   | Sync error          |

---

## Membership Verification

Two models are used, depending on whether an operation is a read or a write:

- **Cached (periodic sync)** — `daoMembersCache` / `daoAdminsCache`, refreshed every `MEMBERSHIP_SYNC_INTERVAL_MS` (default 10 min) or on-demand when a membership-related event is observed (`POST /events/notify`). Used for non-critical reads such as `GET /daos?user=`, where a few minutes of staleness is an acceptable tradeoff for not hitting the RPC on every request.
- **Real-time (on-chain)** — `verifyMembership(daoId, address)` in `services/sync.ts` calls the Membership SBT contract's `has(dao_id, of)` directly via a read-only simulate call, so a just-revoked member is rejected immediately rather than after the next periodic sync. The result is cached for 30 seconds (short enough to stay accurate, long enough to absorb request bursts). Used to gate `POST /comment/edit` and `POST /comment/delete`, which identify the caller by an explicit `author` address.

Anonymous voting (`POST /vote`) and anonymous commenting (`POST /comment/anonymous`) don't use either cache — membership is proven per-request via a ZK merkle-root proof that the voting/comments contract verifies on-chain, which is already both real-time and stronger than an address-based lookup.

Every real-time check that disagrees with the periodic cache logs a `membership_cache_mismatch` warning (useful for spotting drift or a sync interval that's too long). Verification latency and hit-rate metrics are available to authenticated callers via `GET /health` (`membershipVerification` field).

The real-time check only runs when `MEMBERSHIP_SBT_CONTRACT_ID` is configured; deployments without the SBT contract keep the previous behavior (no membership gate on comment edit/delete).

---

## Audit Log

Every authenticated call to a privileged endpoint — `POST /daos/sync`, `POST /events`, `POST /events/notify`, `POST /ipfs/image`, `POST /ipfs/metadata`, `POST /vote`, `POST /comment/anonymous` — is recorded to an append-only `audit_log` table, separate from the general request/response logging (`requestLogger`). Each entry contains:

- Timestamp, action name, and endpoint (`METHOD path`)
- A hashed auth token identifier (`authTokenId`) — since the relayer currently has one shared token rather than per-user credentials, this identifies "a valid token was presented", not a specific user
- A hashed client IP (`ipHash`)
- The request context ID (`requestId`, same value logged by `requestLogger`)
- Redacted request params (the same sensitive-field redaction as the general logger — proofs, nullifiers, tokens, etc. are never stored)
- The response status code

Each row's `hash` covers its own fields plus the previous row's `hash` (a hash chain), so editing, deleting, or reordering a past entry is detectable via chain verification. Two SQLite triggers enforce this at the database level: core fields can never be `UPDATE`d, and a row can't be `DELETE`d until it has been archived.

Rows older than `AUDIT_LOG_RETENTION_DAYS` (default 90) are rotated out automatically every `AUDIT_LOG_ROTATION_INTERVAL_MS` (default 24h): exported to a compressed, timestamped `.jsonl.gz` file under `AUDIT_LOG_ARCHIVE_DIR` (default `./data/audit-archive`), marked `archived_at`, then removed from the hot table.

### GET /admin/audit-log

Paginated audit log review.

**Authentication:** Yes
**Rate Limit:** 60/min (queryLimiter)

#### Query Parameters

| Param    | Type      | Default | Description                                  |
|----------|-----------|---------|-----------------------------------------------|
| `limit`  | `number`  | 50      | Max rows to return (capped at 500)            |
| `offset` | `number`  | 0       | Pagination offset                             |
| `action` | `string`  | -       | Filter by action name                         |
| `format` | `string`  | `json`  | `json` or `cef` (Common Event Format, `text/plain`) |
| `verify` | `boolean` | `false` | If `true`, include a hash-chain integrity check |

#### Response (200) -- JSON

```json
{
  "logs": [
    {
      "id": 42,
      "timestamp": "2026-07-28T13:58:22.956Z",
      "action": "daos_sync",
      "endpoint": "POST /daos/sync",
      "auth_token_id": "8584ec0ca90c2c45",
      "ip_hash": "3e48ef9d22e096da",
      "request_id": "d9086a6822af",
      "params": null,
      "status_code": 200,
      "prev_hash": "genesis",
      "hash": "7d5058b5b68cfc845b8e4a026fc4e60747f325d16a129c9573ec37e92b9e2056",
      "archived_at": null
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0,
  "chainVerification": { "valid": true, "checkedCount": 1 }
}
```

---

## IPFS

All IPFS endpoints require the Pinata integration to be configured (`PINATA_JWT` environment variable). When IPFS is not configured, upload/fetch endpoints return `503`.

### GET /ipfs/health

Check IPFS/Pinata service health.

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Example Request

```bash
curl http://localhost:3001/ipfs/health
```

#### Response (200) -- Healthy

```json
{
  "enabled": true,
  "status": "healthy"
}
```

#### Response (200) -- Not configured

```json
{
  "enabled": false,
  "status": "not_configured"
}
```

---

### POST /ipfs/image

Upload an image file to IPFS via Pinata.

**Authentication:** No
**Rate Limit:** 10/min (ipfsUploadLimiter)

#### Request

`Content-Type: multipart/form-data`

| Field   | Type   | Required | Description                                |
|---------|--------|----------|--------------------------------------------|
| `image` | `file` | Yes      | Image file (max 5MB)                       |

**Allowed MIME types:** `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/svg+xml`, `image/heic`, `image/heif`, `image/avif`, `image/bmp`, `image/tiff`, and any `image/*` type.

#### Example Request

```bash
curl -X POST http://localhost:3001/ipfs/image \
  -F "image=@photo.png"
```

#### Response (200)

```json
{
  "cid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  "size": 204800,
  "filename": "photo.png",
  "mimeType": "image/png"
}
```

#### Error Responses

| Status | Error                                | Cause                |
|--------|--------------------------------------|----------------------|
| 400    | `"File too large. Maximum size is 5MB."` | File exceeds 5MB |
| 400    | `"Unsupported file type: ..."` | Invalid MIME type    |
| 400    | `"No image file provided"`           | Missing file         |
| 500    | `"Failed to upload image to IPFS"`   | Pinata error         |
| 503    | `"IPFS service not configured"`      | IPFS not enabled     |

---

### POST /ipfs/metadata

Upload JSON metadata to IPFS via Pinata. The metadata is sanitized before pinning to prevent XSS attacks.

**Authentication:** No
**Rate Limit:** 10/min (ipfsUploadLimiter)

#### Request Body

| Field      | Type     | Required | Description                                              |
|------------|----------|----------|----------------------------------------------------------|
| `version`  | `number` | Yes      | Metadata version (must be a number)                      |
| `body`     | `string` | No       | Content body (max 100KB for proposals, 10KB for comments)|
| `videoUrl` | `string` | No       | YouTube or Vimeo URL only                                |
| ...        | any      | No       | Additional fields are allowed (passthrough)              |

Maximum total metadata size: 100KB.

#### Example Request

```bash
curl -X POST http://localhost:3001/ipfs/metadata \
  -H "Content-Type: application/json" \
  -d '{
    "version": 1,
    "body": "This proposal aims to...",
    "videoUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  }'
```

#### Response (200)

```json
{
  "cid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  "size": 512
}
```

#### Error Responses

| Status | Error                                        | Cause                       |
|--------|----------------------------------------------|-----------------------------|
| 400    | `"Metadata too large: ... bytes (max 102400)"` | Exceeds 100KB            |
| 400    | `"metadata.version is required and must be a number"` | Missing/invalid version |
| 400    | `"Invalid video URL. Only YouTube and Vimeo URLs are allowed."` | Bad video URL |
| 500    | `"Failed to upload metadata to IPFS"`        | Pinata error                |
| 503    | `"IPFS service not configured"`              | IPFS not enabled            |

---

### GET /ipfs/:cid

Fetch JSON content from IPFS. Results are cached in-memory (LRU, max 500 entries, 15-minute TTL).

**Authentication:** No
**Rate Limit:** 200/min (ipfsReadLimiter)

#### Path Parameters

| Parameter | Type     | Description                       |
|-----------|----------|-----------------------------------|
| `cid`     | `string` | IPFS CID (CIDv0 `Qm...` or CIDv1 `bafy.../bafk...`) |

#### Example Request

```bash
curl http://localhost:3001/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi
```

#### Response (200) -- JSON content

```json
{
  "version": 1,
  "body": "This proposal aims to..."
}
```

#### Response (200) -- Non-JSON content

```json
{
  "content": "raw text content",
  "contentType": "text/plain"
}
```

#### Error Responses

| Status | Error                                   | Cause             |
|--------|-----------------------------------------|-------------------|
| 400    | `"Invalid CID format"`                  | Malformed CID     |
| 500    | `"Failed to fetch content from IPFS"`   | Fetch error       |
| 503    | `"IPFS service not configured"`         | IPFS not enabled  |

---

### GET /ipfs/image/:cid

Fetch a raw image from IPFS. Returns the binary image data with appropriate `Content-Type` header. Response includes aggressive caching headers (`Cache-Control: public, max-age=31536000, immutable`).

**Authentication:** No
**Rate Limit:** 200/min (ipfsReadLimiter)

#### Path Parameters

| Parameter | Type     | Description                       |
|-----------|----------|-----------------------------------|
| `cid`     | `string` | IPFS CID (CIDv0 `Qm...` or CIDv1 `bafy.../bafk...`) |

#### Example Request

```bash
curl http://localhost:3001/ipfs/image/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi \
  --output image.png
```

#### Response (200)

Binary image data with headers:
- `Content-Type: image/png` (or detected type)
- `Cache-Control: public, max-age=31536000, immutable`
- `Cross-Origin-Resource-Policy: cross-origin`

#### Error Responses

| Status | Error                                   | Cause             |
|--------|-----------------------------------------|-------------------|
| 400    | `"Invalid CID format"`                  | Malformed CID     |
| 500    | `"Failed to fetch image from IPFS"`     | Fetch error       |
| 503    | `"IPFS service not configured"`         | IPFS not enabled  |

---

## Events

The event indexer polls Soroban contract events and maintains an in-memory event store. Events can also be manually submitted or reported via frontend notifications.

### GET /events/archived

List historical event archives (events for closed/archived proposals get compressed out of the live event store — see `services/archival.ts`).

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Query Parameters

| Param   | Type     | Description                        |
|---------|----------|--------------------------------------|
| `daoId` | `number` | Optional — filter archives by DAO   |

#### Response (200)

```json
{ "archives": [], "total": 0 }
```

---

### GET /events/archived/:archiveId

Retrieve events from a specific historical archive.

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Response (200)

```json
{ "archiveId": "archive_dao_0_1785200000000", "events": [], "total": 0 }
```

---

### GET /events/:daoId

Get indexed events for a DAO with cursor-based pagination and optional type filtering.

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Path Parameters

| Parameter | Type     | Description              |
|-----------|----------|--------------------------|
| `daoId`   | `string` | DAO identifier (integer) |

#### Query Parameters

| Parameter | Type     | Default | Description                                      |
|-----------|----------|---------|--------------------------------------------------|
| `limit`   | `number` | `100`   | Max events per page (max `500`)               |
| `cursor`  | `string` | none    | Opaque cursor for fetching next page        |
| `types`   | `string` | none    | Comma-separated event type filter (e.g., `"vote_cast,proposal_created"`) |

#### Example Request

```bash
# First page
curl "http://localhost:3001/events/0?limit=20&types=vote_cast,proposal_created"

# Next page
curl "http://localhost:3001/events/0?limit=20&cursor=eyJpIjoxMjN9"
```

#### Response (200)

```json
{
  "data": [...],
  "pagination": {
    "cursor": "eyJpIjoxMjN9",
    "hasMore": true,
    "total": 42
  }
}
```

When `hasMore` is `false`, there are no additional pages. Pass the `cursor` value as the `cursor` query parameter to fetch the next page. The cursor is an opaque string encoding the last item's position.

#### Error Responses

| Status | Error                     | Cause              |
|--------|---------------------------|---------------------|
| 500    | `"Failed to get events"`  | Internal error      |

---

### GET /events/archived

Get the current status of the event indexer.

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Example Request

```bash
curl http://localhost:3001/indexer/status
```

#### Response (200)

```json
{
  "running": true,
  "lastPoll": "2025-01-01T00:00:00Z",
  "eventsProcessed": 150,
  "errors": 0
}
```

---

### GET /indexer/daos

List all DAOs that have indexed events.

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Example Request

```bash
curl http://localhost:3001/indexer/daos
```

#### Response (200)

```json
{
  "daos": [0, 1, 2]
}
```

---

### POST /events

Manually add an event to the indexer. Admin use only.

**Authentication:** Yes
**Rate Limit:** None

#### Request Body

| Field   | Type     | Required | Description                      |
|---------|----------|----------|----------------------------------|
| `daoId` | `number` | Yes      | DAO identifier                   |
| `type`  | `string` | Yes      | Event type (e.g., `"vote_cast"`) |
| `data`  | `object` | No       | Arbitrary event data             |

#### Example Request

```bash
curl -X POST http://localhost:3001/events \
  -H "Content-Type: application/json" \
  -H "X-Relayer-Auth: your-auth-token-here" \
  -d '{
    "daoId": 0,
    "type": "proposal_created",
    "data": { "proposalId": 5, "title": "New proposal" }
  }'
```

#### Response (200)

```json
{
  "success": true
}
```

#### Error Responses

| Status | Error                              | Cause                    |
|--------|------------------------------------|--------------------------|
| 400    | `"daoId and type are required"`    | Missing required fields  |
| 500    | `"Failed to add event"`           | Internal error           |

---

### POST /events/notify

Frontend event notification endpoint. Used by the frontend to report on-chain events it has observed (e.g., after a user mints an SBT or creates a proposal). The event is queued for verification. Membership events automatically trigger a membership cache refresh.

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Request Body

| Field    | Type     | Required | Description                                |
|----------|----------|----------|--------------------------------------------|
| `daoId`  | `number` | Yes      | DAO identifier                             |
| `type`   | `string` | Yes      | Event type                                 |
| `data`   | `object` | No       | Arbitrary event data                       |
| `txHash` | `string` | Yes      | Transaction hash (64 hex characters)       |

Membership event types that trigger a cache refresh: `sbt_mint`, `sbt_revoke`, `member_join`, `member_leave`, `self_join`.

#### Example Request

```bash
curl -X POST http://localhost:3001/events/notify \
  -H "Content-Type: application/json" \
  -d '{
    "daoId": 0,
    "type": "sbt_mint",
    "data": { "member": "GABCDEF..." },
    "txHash": "abc123def456...64hex"
  }'
```

#### Response (200)

```json
{
  "success": true,
  "message": "Event queued for verification"
}
```

#### Error Responses

| Status | Error                                     | Cause                    |
|--------|-------------------------------------------|--------------------------|
| 400    | `"daoId, type, and txHash are required"`  | Missing required fields  |
| 400    | `"Invalid txHash format"`                 | Not 64 hex characters    |
| 500    | `"Failed to notify event"`                | Internal error           |

---

## Bridge

Cross-chain (EVM -> Soroban) vote relay. Vote authenticity comes entirely from the submitted proof, so `POST /bridge/vote` is intentionally unauthenticated (matching an on-chain contract call, which anyone can submit).

### POST /bridge/vote

Submit a cross-chain vote proof.

**Authentication:** No
**Rate Limit:** None

#### Request Body

| Field        | Type     | Required | Description                                    |
|--------------|----------|----------|--------------------------------------------------|
| `daoId`      | `number` | Yes      | Positive integer DAO identifier                  |
| `proposalId` | `number` | Yes      | Positive integer proposal identifier             |
| `voteChoice` | `number` | Yes      | `0` or `1`                                       |
| `nullifier`  | `string` | Yes      | Hex string, max 64 chars                         |
| `voteRoot`   | `string` | Yes      | Hex string, max 64 chars                         |
| `sbtRoot`    | `string` | Yes      | Hex string, max 64 chars                         |
| `proof`      | `object` | Yes      | `{ a, b, c }` Groth16 proof (hex)                 |

#### Response (200)

```json
{ "success": true, "txHash": "abc123...64hex" }
```

---

### GET /bridge/nullifier/:daoId/:proposalId/:nullifier

Check whether a nullifier has already been used (double-vote detection).

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Response (200)

```json
{ "daoId": 0, "proposalId": 1, "nullifier": "0x1234...", "used": false }
```

#### Error Responses

| Status | Error                             | Cause                    |
|--------|------------------------------------|---------------------------|
| 404    | `"Bridge contract not found"`      | Simulation failed         |
| 500    | `"Failed to check nullifier status"` | Internal error           |

---

### POST /bridge/relay

Manually trigger cross-chain event relay (admin only).

**Authentication:** Yes
**Rate Limit:** None

#### Response (200)

```json
{ "success": true }
```

---

## Circuits

### GET /circuits/:dao/:type/status

Get the active and available ZK circuit versions for a DAO (supports circuit migrations without downtime).

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Path Parameters

| Parameter | Type     | Description                          |
|-----------|----------|----------------------------------------|
| `dao`     | `string` | DAO identifier (integer)               |
| `type`    | `string` | `"comment"` or `"vote"`                |

#### Response (200)

```json
{
  "daoId": 0,
  "circuitType": "Vote",
  "currentCircuit": "vote_v1",
  "availableCircuits": [],
  "migration": null
}
```

---

## Route Parameter Validation

All route parameters are validated using Zod schemas before processing. Invalid parameters return `400 Bad Request` with structured error details.

### Parameter Types and Formats

#### Integer Parameters (`:daoId`, `:proposalId`, `:commentId`, `:archiveId`)

- **Format**: Positive integers only (1, 2, 3, ...)
- **Range**: 1 to `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991)
- **Conversion**: String route parameters are automatically converted to numbers
- **Invalid values**: Negative numbers, zero, decimals, non-numeric strings

**Examples:**
- ✅ Valid: `/dao/123`, `/proposal/1/42`
- ❌ Invalid: `/dao/0`, `/dao/-1`, `/dao/abc`, `/dao/123.45`

#### IPFS CID Parameters (`:cid`)

- **Format**: Valid IPFS Content Identifier
- **CIDv0**: Starts with `Qm`, minimum 46 characters (Base58 encoded)
- **CIDv1**: Starts with `bafy` or `bafk`, minimum 59 characters

**Examples:**
- ✅ Valid CIDv0: `QmYjtig7VJQ6XsnUjqqJvj7QaMcCAwtrgNdahSiFofrE7o`
- ✅ Valid CIDv1: `bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku`
- ❌ Invalid: `invalid-cid`, `Qm123` (too short), `QmInvalidChars0`

#### Hex String Parameters (`:nullifier`, `:commitment`)

**Nullifier (`:nullifier`)**:
- **Format**: Hexadecimal string with optional `0x` prefix
- **Length**: 1 to 64 hex characters (0.5 to 32 bytes)
- **Character set**: `0-9`, `a-f`, `A-F`

**Commitment (`:commitment`)**:
- **Format**: Hexadecimal string with optional `0x` prefix  
- **Length**: Exactly 64 hex characters (32 bytes)
- **Character set**: `0-9`, `a-f`, `A-F`

**Examples:**
- ✅ Valid nullifier: `0x1234abcd`, `1234567890abcdef...` (up to 64 chars)
- ✅ Valid commitment: `1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef`
- ❌ Invalid: `GHIJ1234` (invalid hex), `123` (commitment too short)

### Parameter Validation Error Format

When route parameters fail validation, the response includes structured error details:

```json
{
  "error": "Invalid URL parameters",
  "details": [
    {
      "field": "daoId",
      "message": "Must be a positive integer"
    },
    {
      "field": "cid", 
      "message": "Invalid IPFS CID format"
    }
  ]
}
```

**Status:** `400 Bad Request`

### Route Parameter Matrix

| Route | Parameters | Validation Schema |
|-------|------------|-------------------|
| `GET /dao/:daoId` | `daoId` | Positive integer |
| `GET /proposal/:daoId/:proposalId` | `daoId`, `proposalId` | Positive integers |
| `GET /root/:daoId` | `daoId` | Positive integer |
| `GET /comments/:daoId/:proposalId` | `daoId`, `proposalId` | Positive integers |
| `GET /comment/:daoId/:proposalId/:commentId` | `daoId`, `proposalId`, `commentId` | Positive integers |
| `GET /comments/:daoId/:proposalId/nonce` | `daoId`, `proposalId` | Positive integers |
| `GET /comment/challenge/:commitment` | `commitment` | 64-char hex string |
| `GET /ipfs/:cid` | `cid` | Valid IPFS CID |
| `GET /ipfs/image/:cid` | `cid` | Valid IPFS CID |
| `GET /bridge/nullifier/:daoId/:proposalId/:nullifier` | `daoId`, `proposalId`, `nullifier` | Integers + hex string |
| `GET /events/:daoId` | `daoId` | Positive integer |
| `GET /events/archived/:archiveId` | `archiveId` | Positive integer |

---

## Common Error Format

All error responses follow this structure:

```json
{
  "error": "Human-readable error message"
}
```

When `RELAYER_GENERIC_ERRORS` is not set to `true`, some endpoints include additional detail:

```json
{
  "error": "Human-readable error message",
  "details": "Technical error details"
}
```

## Validation Errors

Endpoints using Zod schema validation return structured errors on validation failure:

```json
{
  "error": "Validation failed",
  "details": [
    {
      "field": "proof.a",
      "message": "proof.a cannot be all zeros (point at infinity)"
    }
  ]
}
```

**Status:** `400 Bad Request`
