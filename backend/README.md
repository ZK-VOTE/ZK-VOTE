# ZKVote Backend Services

Relayer service for anonymous vote submission and DAO management on Stellar Soroban.

## Overview

The relayer provides anonymity by submitting vote transactions on behalf of users:
- User generates ZK proof off-chain
- User sends vote request to relayer
- Relayer submits tx using its own funded account
- Transaction source ≠ voter (anonymity preserved)

## Features

- **Anonymous voting** with Groth16 ZK proofs
- **Anonymous comments** on proposals
- **DAO caching** with SQLite storage
- **Event indexing** for real-time updates
- **IPFS integration** via Pinata for proposal content
- **Rate limiting** per endpoint type
- **Security hardening** (CORS, Helmet, CSRF protection)

## Setup

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your values (see [Environment Variables](#environment-variables) section).

### 3. Create Relayer Account

```bash
# Generate relayer key
stellar keys generate relayer

# Get secret key
stellar keys show relayer

# Fund it
stellar keys fund relayer --network testnet
```

### 4. Start Relayer

```bash
npm run relayer

# Or with auto-reload:
npm run dev:relayer
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SOROBAN_RPC_URL` | Yes | `http://localhost:8000/soroban/rpc` | Soroban RPC endpoint |
| `NETWORK_PASSPHRASE` | Yes | `Standalone Network ; February 2017` | Stellar network passphrase |
| `RELAYER_SECRET_KEY` | Yes | - | Relayer account secret key |
| `RELAYER_AUTH_TOKEN` | Yes | - | Shared secret for write endpoints (min 32 chars) |
| `VOTING_CONTRACT_ID` | Yes | - | Voting contract address |
| `TREE_CONTRACT_ID` | Yes | - | Membership tree contract address |
| `COMMENTS_CONTRACT_ID` | Yes | - | Comments contract address |
| `DAO_REGISTRY_CONTRACT_ID` | No | - | DAO registry for sync feature |
| `MEMBERSHIP_SBT_CONTRACT_ID` | No | - | SBT contract for membership queries |
| `PORT` | No | `3001` | Server port |
| `CORS_ORIGIN` | No | `*` | Comma-separated allowed origins |
| `PINATA_JWT` | No | - | Pinata API JWT for IPFS |
| `PINATA_GATEWAY` | No | - | Pinata gateway URL |
| `VOTING_VK_VERSION` | No | - | Static VK version to expose |
| `LOG_CLIENT_IP` | No | - | `plain`, `hash`, or omit to not log |
| `HEALTH_EXPOSE_DETAILS` | No | `true` | Show contract IDs in health endpoint |
| `RPC_TIMEOUT_MS` | No | `10000` | RPC call timeout in ms |
| `INDEXER_ENABLED` | No | `true` | Enable event indexer |
| `INDEXER_POLL_INTERVAL_MS` | No | `5000` | Indexer polling interval |
| `DAO_SYNC_INTERVAL_MS` | No | `30000` | DAO sync interval |
| `MEMBERSHIP_SYNC_INTERVAL_MS` | No | `600000` | Membership cache refresh interval |

## API Reference

### Health & Status

#### `GET /health`
Basic health check (no auth required).

```bash
curl http://localhost:3001/health
```

Response:
```json
{
  "status": "ok",
  "rpc": { "ok": true }
}
```

With auth token, additional details are exposed.

#### `GET /ready`
Readiness check - verifies RPC connectivity.

```bash
curl http://localhost:3001/ready
```

Response:
```json
{ "status": "ready" }
```

#### `GET /config`
Get relayer configuration (requires auth).

```bash
curl -H "X-Relayer-Auth: <token>" http://localhost:3001/config
```

Response:
```json
{
  "votingContract": "CXXX...",
  "treeContract": "CXXX...",
  "networkPassphrase": "...",
  "rpc": "http://...",
  "vkVersion": 1
}
```

### Voting

#### `POST /vote`
Submit anonymous vote with ZK proof (requires auth).

**Rate limit:** 10/minute per IP

```bash
curl -X POST http://localhost:3001/vote \
  -H "Content-Type: application/json" \
  -H "X-Relayer-Auth: <token>" \
  -d '{
    "daoId": 1,
    "proposalId": 1,
    "choice": true,
    "nullifier": "0x123...",
    "root": "0xabc...",
    "commitment": "0xdef...",
    "proof": {
      "a": "0x...",
      "b": "0x...",
      "c": "0x..."
    }
  }'
```

| Field | Type | Description |
|-------|------|-------------|
| `daoId` | integer | DAO ID |
| `proposalId` | integer | Proposal ID |
| `choice` | boolean | `true` for yes, `false` for no |
| `nullifier` | hex string | Nullifier (< BN254 modulus, 32 bytes) |
| `root` | hex string | Merkle root (< BN254 modulus, 32 bytes) |
| `commitment` | hex string | Identity commitment (< BN254 modulus, 32 bytes) |
| `proof.a` | hex string | G1 point (64 bytes) |
| `proof.b` | hex string | G2 point (128 bytes) |
| `proof.c` | hex string | G1 point (64 bytes) |

Response:
```json
{
  "success": true,
  "txHash": "abc123...",
  "status": "SUCCESS"
}
```

#### `GET /proposal/:daoId/:proposalId`
Get vote results for a proposal.

**Rate limit:** 60/minute per IP

```bash
curl http://localhost:3001/proposal/1/1
```

Response:
```json
{
  "daoId": "1",
  "proposalId": "1",
  "yesVotes": 5,
  "noVotes": 3
}
```

#### `GET /root/:daoId`
Get current Merkle root for a DAO.

**Rate limit:** 60/minute per IP

```bash
curl http://localhost:3001/root/1
```

Response:
```json
{
  "daoId": "1",
  "root": "0x..."
}
```

### DAOs

#### `GET /daos`
Get all cached DAOs, optionally with user membership info.

**Rate limit:** 60/minute per IP

```bash
# All DAOs
curl http://localhost:3001/daos

# With membership info for a user
curl "http://localhost:3001/daos?user=GXXX..."
```

Response:
```json
{
  "daos": [
    {
      "id": 1,
      "name": "Test DAO",
      "creator": "GXXX...",
      "open_membership": true,
      "role": "admin"
    }
  ],
  "total": 1,
  "lastSync": "2024-01-15T10:30:00Z",
  "cached": true
}
```

#### `GET /dao/:daoId`
Get a specific DAO from cache.

**Rate limit:** 60/minute per IP

```bash
curl http://localhost:3001/dao/1
```

#### `POST /daos/sync`
Trigger manual DAO sync from contract (requires auth).

```bash
curl -X POST -H "X-Relayer-Auth: <token>" http://localhost:3001/daos/sync
```

### Events

#### `GET /events/:daoId`
Get indexed events for a DAO.

**Rate limit:** 60/minute per IP

```bash
curl "http://localhost:3001/events/1?limit=50&offset=0&types=vote,proposal_created"
```

Query params:
- `limit` (default: 50, max: 100)
- `offset` (default: 0)
- `types` (comma-separated event types)

#### `GET /indexer/status`
Get event indexer status.

#### `GET /indexer/daos`
List all indexed DAOs.

#### `POST /events`
Add manual event (requires auth).

#### `POST /events/notify`
Notify relayer of an event with txHash for verification.

**Rate limit:** 60/minute per IP

```bash
curl -X POST http://localhost:3001/events/notify \
  -H "Content-Type: application/json" \
  -d '{
    "daoId": 1,
    "type": "sbt_mint",
    "txHash": "abc123...",
    "data": {}
  }'
```

### Comments

#### `GET /comments/:daoId/:proposalId`
Get comments for a proposal.

**Rate limit:** 60/minute per IP

```bash
curl "http://localhost:3001/comments/1/1?limit=50&offset=0"
```

Response:
```json
{
  "comments": [
    {
      "id": 1,
      "daoId": 1,
      "proposalId": 1,
      "author": "GXXX...",
      "contentCid": "Qm...",
      "parentId": null,
      "createdAt": 1705319400,
      "isAnonymous": false
    }
  ],
  "total": 1
}
```

#### `GET /comment/:daoId/:proposalId/:commentId`
Get a single comment.

#### `GET /comments/:daoId/:proposalId/nonce`
Get next comment nonce for a commitment (for multiple anonymous comments).

```bash
curl "http://localhost:3001/comments/1/1/nonce?commitment=0xabc..."
```

#### `POST /comment/anonymous`
Submit anonymous comment with ZK proof (requires auth).

**Rate limit:** 20/minute per IP

```bash
curl -X POST http://localhost:3001/comment/anonymous \
  -H "Content-Type: application/json" \
  -H "X-Relayer-Auth: <token>" \
  -d '{
    "daoId": 1,
    "proposalId": 1,
    "contentCid": "Qm...",
    "parentId": null,
    "voteChoice": true,
    "nullifier": "0x...",
    "root": "0x...",
    "commitment": "0x...",
    "proof": { "a": "0x...", "b": "0x...", "c": "0x..." }
  }'
```

#### `POST /comment/edit`
Edit a public comment (requires auth).

#### `POST /comment/delete`
Delete a public comment (requires auth).

### IPFS

#### `GET /ipfs/health`
Check IPFS/Pinata service status.

```bash
curl http://localhost:3001/ipfs/health
```

Response:
```json
{
  "enabled": true,
  "status": "healthy"
}
```

#### `POST /ipfs/image`
Upload an image to IPFS (requires auth).

**Rate limit:** 10/minute per IP

```bash
curl -X POST http://localhost:3001/ipfs/image \
  -H "X-Relayer-Auth: <token>" \
  -F "image=@/path/to/image.jpg"
```

Max size: 5MB. Supported formats: JPEG, PNG, GIF, WebP, AVIF, HEIC, SVG.

Response:
```json
{
  "cid": "Qm...",
  "size": 12345,
  "filename": "image.jpg",
  "mimeType": "image/jpeg"
}
```

#### `POST /ipfs/metadata`
Upload JSON metadata to IPFS (requires auth).

**Rate limit:** 10/minute per IP

```bash
curl -X POST http://localhost:3001/ipfs/metadata \
  -H "Content-Type: application/json" \
  -H "X-Relayer-Auth: <token>" \
  -d '{
    "version": 1,
    "description": "Proposal description...",
    "videoUrl": "https://youtube.com/..."
  }'
```

Max size: 100KB. `version` field is required.

#### `GET /ipfs/:cid`
Fetch JSON content from IPFS (cached for 15 min).

```bash
curl http://localhost:3001/ipfs/QmXYZ...
```

#### `GET /ipfs/image/:cid`
Fetch raw image from IPFS (for `<img src>`).

```bash
curl http://localhost:3001/ipfs/image/QmXYZ...
```

Returns binary image with appropriate `Content-Type` header.

## Security

### Implemented Measures

- **Rate Limiting**: Per-endpoint limits (10 votes/min, 60 queries/min, 10 uploads/min, 20 comments/min)
- **Authentication**: Required auth token for write endpoints (`X-Relayer-Auth` header)
- **Token Strength**: Minimum 32 characters required for auth token
- **CORS**: Configurable origins via `CORS_ORIGIN` env var
- **CSRF Protection**: Multi-layered CSRF protection following OWASP recommendations:
  - **Origin/Referer Validation**: Exact origin matching (no wildcard subdomains)
  - **Null Origin Rejection**: Explicitly blocks `Origin: null` from sandboxed iframes/data URIs
  - **Missing Header Rejection**: Requires either Origin or Referer header on write endpoints
  - **CSRF Token Validation**: Token-based protection as defense-in-depth (`X-CSRF-Token` header)
  - **Fail-Closed**: Rejects requests when CORS_ORIGIN is wildcard on write endpoints
- **Helmet**: HTTP security headers
- **Input Validation**: All inputs validated for type, length, and format
- **BN254 Field Validation**: Values validated to be within BN254 scalar field
- **Proof Validation**: Proof components cannot be all zeros
- **IP Hashing**: Client IPs hashed in logs (configurable)
- **Proof Redaction**: Sensitive fields redacted from logs

### Production Recommendations

1. Set `CORS_ORIGIN` to specific frontend origins (exact origins, no wildcards)
2. Use strong `RELAYER_AUTH_TOKEN` (32+ chars)
3. Set `LOG_CLIENT_IP=hash` to anonymize IPs
4. Set `HEALTH_EXPOSE_DETAILS=false` to hide contract IDs
5. Deploy behind reverse proxy with DDoS protection
6. Use HTTPS/TLS termination
7. Ensure frontend includes `X-CSRF-Token` header in all write requests
8. Retrieve CSRF token from `X-CSRF-Token` response header or `csrf_token` cookie

## Architecture

```
User (off-chain)
  ├── Generate identity secrets (secret, salt)
  ├── Compute commitment = Poseidon(secret, salt)
  ├── Generate ZK proof (Circom/SnarkJS)
  └── Send vote request to relayer
         │
         ▼
Relayer (this service)
  ├── Validates request & auth token
  ├── Rate limits by IP
  ├── Builds Soroban transaction
  ├── Signs with relayer account
  └── Submits to network
         │
         ▼
Voting Contract (on-chain)
  ├── Verifies Merkle root is valid
  ├── Checks nullifier not spent
  ├── Verifies Groth16 proof (BN254 pairing)
  └── Records vote (anonymous)
```

The key insight: **transaction source (relayer) ≠ voter identity**, providing anonymity at the blockchain level. The ZK proof provides anonymity at the vote level (no one knows which commitment voted which way).

## SQLite Storage

The relayer uses SQLite for persistent storage:

- **Location**: `data/relayer.db`
- **Tables**: `daos`, `events`, `settings`
- **Caching**: DAOs and events are cached locally for fast queries

## Testing

```bash
# Run tests
npm test

# Run IPFS tests
npm run test:ipfs
```
