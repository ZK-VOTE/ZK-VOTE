# Zero-Downtime Deployment

How the relayer is deployed to Fly.io without dropping in-flight requests,
and the constraints that shape the approach (see #190).

## Constraints

- **Single-instance data volume.** The SQLite database lives on a Fly
  Volume (`zkvote_data`, mounted at `/app/data`), and a volume can only be
  attached to one machine at a time. True blue-green (two versions running
  concurrently against the same data) isn't possible without moving off a
  local SQLite file. `min_machines_running = 1` reflects this — the app
  runs as a single instance per region.
- **In-process state.** `withSequenceLock` (relayer transaction mutex) and
  the DAO/membership caches in `services/sync.ts` are in-memory and reset
  on restart. A deploy always has a brief window where a fresh instance is
  rebuilding this state; it does not accept traffic until its health check
  passes, so this window isn't visible to clients.

## What happens on `fly deploy`

1. **Rolling strategy** (`[deploy] strategy = "rolling"` in `fly.toml`):
   Fly starts the new machine, waits for both `/health` and `/metrics`
   checks to pass (`[[http_service.checks]]`), then stops the old one. If
   the new machine never becomes healthy, the old one keeps serving and the
   deploy is reported as failed — this is the rollback trigger.
2. **Migrations run automatically on boot**, inside `initDb()`
   (`src/services/db.ts` → `migrateUp()`). They're wrapped per-migration in
   a transaction and guarded by a lock row in the `metadata` table, so a
   migration that's already applied (or already in progress on another
   instance) is skipped rather than double-run. This intentionally runs
   in-process rather than as a Fly `release_command`, because a
   `release_command` runs on a separate ephemeral machine that cannot
   attach the single-attach data volume.
3. **Graceful shutdown drains in-flight requests.** When Fly sends
   `SIGTERM` to the outgoing machine, `gracefulShutdown()` in `src/index.ts`
   stops background interval services, calls `httpServer.close()` (stop
   accepting new connections, let in-flight ones finish), and exits once
   drained or after a 25s hard timeout, whichever comes first.
   `kill_timeout = "35s"` in `fly.toml` gives that drain room to complete
   before Fly force-kills the process.

## Rollback

```sh
fly releases                        # find the last good release
fly deploy --image <previous-image> # redeploy it
```

Because deploys are rolling and health-check-gated, a bad release is
usually caught automatically before it replaces the healthy instance — the
above is for rolling back a release that *did* go live but is misbehaving
in a way health checks don't catch (e.g. a business-logic regression).

## Encrypted SQLite backups (Issue #359)

When `BACKUP_ENCRYPTION_ENABLED=true`, the relayer's scheduled snapshots are
AES-256-GCM encrypted before hitting disk / object storage
(`docs/ENCRYPTED_BACKUPS.md`). Deploy notes:

- Set `BACKUP_ENCRYPTION_KEY` via `fly secrets set` and rotate it with
  `./scripts/rotate-backup-key.sh rotate`. The key ring
  (`data/backup-keys/`) lives on the same `zkvote_data` volume as the DB, so
  old snapshots stay decryptable across rotations; keep a copy of the ring
  off-box too.
- Migration `004_add_backup_key_metadata` (backup-key audit table) runs
  automatically on boot like any other migration.

## Testing a deploy is actually zero-downtime

Run a small load generator against `/health` (or any read endpoint) during
`fly deploy` and confirm there are no failed requests:

```sh
while true; do
  curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" https://<app>.fly.dev/health
  sleep 0.5
done
```

Watch for non-2xx responses or gaps while the deploy is in progress.

## Observability during a deploy

- `/health` reports circuit breaker state, memory usage, and DB status —
  useful for spotting a new release struggling before it fully replaces
  the old one.
- `/metrics` (Prometheus) exposes `zkvote_service_running`,
  `zkvote_circuit_breaker_state`, and `zkvote_memory_usage_ratio`, which
  can be graphed across a deploy window.
