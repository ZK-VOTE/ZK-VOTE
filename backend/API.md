# ZKVote Backend API Reference

Base URL: `http://localhost:3001` (default)

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

All rate limiters use a 1-minute sliding window keyed by hashed IP address. Standard `RateLimit-*` headers are included in responses.

| Limiter          | Max Requests / min | Applied To                                     |
|------------------|--------------------|-------------------------------------------------|
| `voteLimiter`    | 10                 | `POST /vote`                                    |
| `commentLimiter` | 20                 | `POST /comment/anonymous`, `/comment/edit`, `/comment/delete` |
| `queryLimiter`   | 60                 | All GET endpoints (except IPFS reads)            |
| `ipfsUploadLimiter` | 10              | `POST /ipfs/image`, `POST /ipfs/metadata`       |
| `ipfsReadLimiter`| 200                | `GET /ipfs/:cid`, `GET /ipfs/image/:cid`         |

Rate limit exceeded response:

```json
{ "error": "Too many requests, please try again later" }
```

**Status:** `429 Too Many Requests`

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

Get comments for a proposal with pagination.

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Path Parameters

| Parameter    | Type     | Description              |
|--------------|----------|--------------------------|
| `daoId`      | `string` | DAO identifier (integer) |
| `proposalId` | `string` | Proposal identifier (integer) |

#### Query Parameters

| Parameter | Type     | Default | Description                      |
|-----------|----------|---------|----------------------------------|
| `limit`   | `string` | `"50"` | Max comments to return (capped at 100) |
| `offset`  | `string` | `"0"`  | Number of comments to skip       |

#### Example Request

```bash
curl "http://localhost:3001/comments/0/1?limit=20&offset=0"
```

#### Response (200)

```json
{
  "comments": [
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
  "total": 1
}
```

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

| Parameter    | Type     | Description              |
|--------------|----------|--------------------------|
| `daoId`      | `string` | DAO identifier (integer) |
| `proposalId` | `string` | Proposal identifier (integer) |
| `commentId`  | `string` | Comment identifier (integer)  |

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

| Status | Error                              | Cause                      |
|--------|------------------------------------|----------------------------|
| 400    | `"Missing required fields"`        | Incomplete request body    |
| 400    | `"Failed to edit comment"`         | Simulation failed          |
| 500    | `"Transaction submission failed"`  | RPC submission error       |
| 500    | `"Transaction failed"`            | On-chain failure           |

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

| Status | Error                              | Cause                      |
|--------|------------------------------------|----------------------------|
| 400    | `"Missing required fields"`        | Incomplete request body    |
| 400    | `"Failed to delete comment"`       | Simulation failed          |
| 500    | `"Transaction submission failed"`  | RPC submission error       |
| 500    | `"Transaction failed"`            | On-chain failure           |

---

## DAOs

### GET /daos

Get all cached DAOs. Optionally include the requesting user's membership role for each DAO.

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Query Parameters

| Parameter | Type     | Required | Description                                      |
|-----------|----------|----------|--------------------------------------------------|
| `user`    | `string` | No       | Stellar address (`G...`). When provided, each DAO includes a `role` field. |

#### Example Request

```bash
# Without user context
curl http://localhost:3001/daos

# With user membership info
curl "http://localhost:3001/daos?user=GABCDEF..."
```

#### Response (200) -- Without user

```json
{
  "daos": [
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
  "total": 1,
  "lastSync": "2025-01-01T00:00:00Z",
  "cached": true
}
```

#### Response (200) -- With user

Each DAO includes a `role` field:

```json
{
  "daos": [
    {
      "id": 0,
      "name": "My DAO",
      "creator": "GABCDEF...",
      "membership_open": true,
      "members_can_propose": true,
      "metadata_cid": null,
      "member_count": 12,
      "role": "admin"
    }
  ],
  "total": 1,
  "lastSync": "2025-01-01T00:00:00Z",
  "cached": true
}
```

The `role` field can be:
- `"admin"` -- User is the DAO admin
- `"member"` -- User holds a membership SBT
- `null` -- User is not a member

#### Error Responses

| Status | Error                              | Cause                      |
|--------|------------------------------------|----------------------------|
| 400    | `"Invalid Stellar address format"` | Malformed `user` parameter |
| 500    | `"Failed to get DAOs"`             | Internal error             |

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

### GET /events/:daoId

Get indexed events for a DAO with pagination and optional type filtering.

**Authentication:** No
**Rate Limit:** 60/min (queryLimiter)

#### Path Parameters

| Parameter | Type     | Description              |
|-----------|----------|--------------------------|
| `daoId`   | `string` | DAO identifier (integer) |

#### Query Parameters

| Parameter | Type     | Default | Description                                      |
|-----------|----------|---------|--------------------------------------------------|
| `limit`   | `string` | `"50"` | Max events to return (capped at 100)             |
| `offset`  | `string` | `"0"`  | Number of events to skip                         |
| `types`   | `string` | none    | Comma-separated event type filter (e.g., `"vote_cast,proposal_created"`) |

#### Example Request

```bash
curl "http://localhost:3001/events/0?limit=20&types=vote_cast,proposal_created"
```

#### Response (200)

```json
{
  "events": [...],
  "total": 42
}
```

#### Error Responses

| Status | Error                     | Cause              |
|--------|---------------------------|---------------------|
| 500    | `"Failed to get events"`  | Internal error      |

---

### GET /indexer/status

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
