# Request Priority Model (#602, extended under ZV-110)

## Scheduling contract

| Tier | Requests | Reserved concurrency | Maximum queue wait |
|---|---|---:|---:|
| `CRITICAL` | `POST /vote`, `/vote/commit`, `/vote/batch` | 16 | 5 seconds |
| `HIGH` | `POST /admin/**`, `POST /dispute(s)/**` | 8 | 10 seconds |
| `NORMAL` | `POST /pay`, `/pay/batch`, `/swap`, `/ramp/**` | 8 | 20 seconds |
| `LOW` | All `POST /comment` and `POST /comments` actions | 4 | 30 seconds |

`HIGH` exists so an incident responder (admin intervention) or a dispute
report can never be stuck behind a payment burst — the original two-tier
model only separated votes from comments, so payments, admin operations,
and dispute intake all fell through to no scheduling at all and competed
for the same unbounded capacity.

The same classifier (`backend/src/priority/priorityConfig.ts`) runs before
the unversioned, `/api/v1`, and `/api/v2` mounts — it is wired into a single
`app.use(priorityMiddleware())` call ahead of every route mount in
`backend/src/index.ts`, not per-route, so there is only one place that can
drift out of sync across the three public aliases. API prefixes are removed
before matching, so the public aliases cannot bypass scheduling.

`backend/src/priority/priorityQueue.ts` uses separate worker pools per tier.
A burst in one tier can fill only that tier's own pool; it can never occupy
a higher tier's workers or sit in front of a higher tier's request in the
same FIFO. Only `POST` requests are classified — reads keep their existing
route-specific rate limits (e.g. `queryLimiter`), since this queue exists to
protect write-path throughput, not to schedule cheap reads.

The global slowdown middleware skips critical vote requests because those
requests already pass through the wallet and vote limiters. This prevents a
burst of lower-priority traffic from consuming a shared IP slowdown budget
before a time-sensitive vote arrives.

There is currently no live `disputes` route in the backend — the classifier
recognizes `/dispute(s)/**` ahead of that feature landing so dispute intake
gets the same scheduling guarantee from day one instead of needing a second
change later.

## Monitoring

- `zkvote_priority_starvation_total{priority,route}` increments whenever a
  queued request waits at least `starvationThresholdMs` (default 1s) before
  starting.
- `zkvote_priority_queue_depth{tier}` and `zkvote_priority_queue_in_flight{tier}`
  report each tier's current queued/running count, updated after every
  drain pass.
- Alerts (`monitoring/prometheus/priority-queue-alerts.yml`, registered in
  `prometheus.yml`'s `rule_files` and mounted in `docker-compose.yml`):
  - `ZKVotePriorityStarvation` — any `CRITICAL` (vote) starvation, `severity: critical`.
  - `ZKVoteAdminDisputePriorityStarvation` — any `HIGH` (admin/dispute) starvation, `severity: critical`.
  - `ZKVotePaymentPriorityStarvation` — sustained `NORMAL` (payment) starvation, `severity: warning`.

  (`monitoring/prometheus/zkvote-alerts.yml` previously documented a
  `ZKVotePriorityStarvation` alert that didn't actually exist in that file,
  and that file does not currently parse as valid YAML — see the note in
  this repo's most recent priority-model PR. The alert now lives in its own
  file so it isn't blocked on fixing that unrelated breakage.)

## Regression tests

`backend/test/priority-preemption.test.ts` covers:

- classification of vote/admin/dispute/payment/comment writes, identically
  across the unversioned, `/api/v1`, and `/api/v2` mounts;
- that GET requests and lookalike paths (`/paylater`, `/administrator`)
  are never classified;
- that a 100-request backlog in a lower tier never delays a higher tier,
  for both the original vote-vs-comment pair and the new
  admin/dispute-vs-payment pair;
- that one tier's worker pool is never shared with another tier's;
- the starvation metric incrementing for both `CRITICAL` and `HIGH`;
- the new per-tier depth/in-flight reporting hook; and
- a queued request timing out once it exceeds its tier's max wait.
