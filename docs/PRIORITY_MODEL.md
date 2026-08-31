# Request Priority Model (#188)

## Tiers

| Tier | Examples | Concurrency | Rate limit | Max queue wait |
|---|---|---|---|---|
| CRITICAL | `POST /vote` | 32 | 600 req/min | 5s |
| HIGH | comments, notifications | 16 | 300 req/min | 8s |
| MEDIUM | proposal results, Merkle root queries | 8 | 150 req/min | 15s |
| LOW | DAO listings, health checks, IPFS fetches | 4 | 60 req/min | 30s |

Defined in `src/priority/priorityConfig.ts`.

## How it works

1. `priorityMiddleware` classifies every request by method + path (`classifyRequest`) and tags it with a tier.
2. A per-tier sliding-window rate limiter rejects (`429`) requests that exceed that tier's limit — critical operations get the most headroom.
3. Each request's remaining handler chain is submitted to a shared `PriorityQueue` as a unit of work for its tier.
4. The queue drains tiers in priority order on every pass (`CRITICAL → HIGH → MEDIUM → LOW`), so CRITICAL work always claims available CRITICAL-tier concurrency first. Lower tiers run concurrently up to their own caps — they are not blocked outright, they simply never preempt CRITICAL capacity.
5. Requests that wait past `maxQueueWaitMs` for their tier are rejected with `503 queue_timeout` rather than hanging indefinitely.
6. `GET /internal/queue-metrics` exposes live queue depth / in-flight counts per tier for monitoring.

## Why not separate processes?

The issue notes Fly.io can route by process group/path for stronger isolation. This PR implements the software-layer prioritization (assignment, queuing, rate limiting, monitoring) that's needed regardless of deployment topology. Splitting into separate Fly.io process groups for read vs. write paths is an infra change we recommend as a **follow-up**, layered on top of this: it would give process-level isolation in addition to the in-process guarantees here.

## Testing

`src/priority/priorityQueue.test.ts` simulates concurrent load across all four tiers and asserts:
- CRITICAL requests complete with the lowest average latency even when LOW-tier traffic floods the queue
- No CRITICAL request is rejected due to LOW/MEDIUM tier congestion
- Rate limiting correctly rejects tiers that exceed their configured cap
