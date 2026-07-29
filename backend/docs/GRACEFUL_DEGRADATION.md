# Graceful Degradation for Non-Critical Services (#204)

## Principle

> The system is always available, but may offer reduced functionality during failures.

Critical voting/proposal writes stay **fail-closed**. Non-critical and background failures produce **partial responses**, **headers**, and **queued retries** instead of taking down the API.

## Service tiers

| Tier | Services | Behavior |
|------|----------|----------|
| **critical** | `soroban_rpc` | Fail closed (503). No LKG for vote success. |
| **important** | `sqlite` | Serve from cache / continue reads when possible. |
| **non-critical** | `ipfs`, `comments` | LKG / placeholders / queue writes; UI banner. |
| **background** | `indexer`, `dao_sync`, `ttl_renewal` | Mark degraded; HTTP keeps serving SQLite/cache. |

## Headers

Every JSON response may include:

- `X-Service-Degraded: ipfs,comments`
- `X-Service-Status: ipfs=degraded;comments=degraded`

CORS exposes these via `exposedHeaders`.

## Components

| Module | Role |
|--------|------|
| `services/service-health.ts` | Registry, LKG cache, durable write queue (`data/degraded-write-queue.json`) |
| `middleware/degradation.ts` | Request ALS + header injection + `sendPartial` |
| `routes/health.ts` | `services` block + overall `status: ok \| degraded` |
| `routes/ipfs.ts` | Cache/LKG/placeholder on fetch; queue `pinJSON` on upload failure (202) |
| `routes/comments.ts` | LKG list on RPC failure; `disabled` when contract missing |
| `indexer` / `sync` / `ttl` | `markDegraded` / `markHealthy` on poll cycles |
| Frontend `ServiceDegradationBanner` | Shows degraded services from `/health` + headers |

## Degradation scenarios

1. **IPFS read fail** → route cache → LKG → placeholder JSON + headers (200 partial).
2. **IPFS write fail** → enqueue + `202 { queued: true }` + headers; drain on `/ipfs/health` recovery.
3. **Comments GET fail** → LKG comments + headers; else 503 `disabled`.
4. **Indexer/sync/TTL fail** → health shows background degraded; `/daos` and events still served from DB.
5. **Vote / proposal write** → unchanged hard errors (no fake success).

## Tests

```bash
cd backend && RELAYER_TEST_MODE=true node --import tsx --test --test-concurrency=1 test/graceful-degradation.test.js
```
