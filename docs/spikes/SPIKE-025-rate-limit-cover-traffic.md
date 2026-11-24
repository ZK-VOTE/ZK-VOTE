# SPIKE-025 — Rate limiting and cover-traffic stubs (#710)

Status: **partial**. This records what the code does today, fixes the
cover-traffic stub's lifecycle and randomness, and lists what is not done.

## What the issue claimed vs. what the code does

| Claim | Code at `3638126` |
|---|---|
| Rate limits are "10 votes/min, 60 queries/min **per IP**" | **Votes are not keyed by IP.** `voteLimiter` (`backend/src/middleware/rateLimit.ts`) uses `walletKeyGenerator` (SHA-256 of the wallet address) with no IP fallback, because Tor/relay clients share egress IPs. Only `queryLimiter` (60/min) is per hashed IP. |
| Polling burns the budget and locks users out of voting | **Not at the limiter level.** `voteLimiter` and `queryLimiter` are separate named buckets with separate stores, and `graduatedSlowDown` skips critical (vote) requests. Polling can exhaust the *query* budget (so reads 429), but it cannot consume the vote bucket. The frontend polling rate itself was not measured. |
| NAT-shared voters are collaterally blocked | Not for votes (wallet-keyed). Still true for queries, comments and IPFS routes, which are per hashed IP. |
| Colluding submitters bypass limits | Plausible for votes: a wallet key is free to mint, so one actor can rotate wallets. Not tested. |
| `scheduleCoverTraffic` is a stub | **Yes.** It logs `cover_traffic_scheduled` at a 10% chance every 5s and sends nothing. It also used `Math.random()` and a `setInterval` that was never cleared, so the process could not stop it on shutdown. |
| Limiter state is not shared across replicas | **Yes**, documented in the `#131` comment: each instance counts independently, so the effective limit scales with instance count. Needs a shared store (for example Redis); not done. |

## Delivered

- `backend/src/services/cover-traffic.ts`: a scheduler that fires as a Poisson process (exponential inter-arrival times, CSPRNG source) instead of a fixed 5s grid with `Math.random()`. `start()` is idempotent and `stop()` cancels the timer. The timer is `unref`'d and a throwing tick does not stop scheduling.
- `scheduleCoverTraffic()` uses it with a 50s mean (the same expected rate as before: 10% per 5s). New `stopCoverTraffic()` is called from `gracefulShutdown`.
- New counter `zkvote_cover_traffic_scheduled_total`.
- `backend/tests/cover-traffic.test.ts`.

## Still a stub

The scheduler still **sends nothing**. Real cover traffic needs (a) a funded cover account and a fee budget someone has approved, (b) a decision on what a dummy looks like on chain so it matches a real vote's size and timing, and (c) a classifier test of real vs. dummy. Until then the anonymity-set protection the issue describes does not exist, and the docs should not imply it does.

## Not done

- Measuring the frontend polling rate (`Homepage` / `VoteModal`) against the 60/min query budget.
- NAT-fair limiting design (blinded tokens, PoW, per-DAO buckets) and a spam/collateral harness.
- Shared limiter store for multiple replicas, and a bypass test across instances.
- Costing dummy traffic at 1x/10x volume on testnet.
- Alerts in `monitoring/prometheus/zkvote-alerts.yml` for limiter and cover health.
- Updating `SECURITY.md` / `docs/CSP.md` posture text.
