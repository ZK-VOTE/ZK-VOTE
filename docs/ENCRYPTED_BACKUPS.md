# Encrypted Relay DB Backups — Runbook

> Feature: **#359 — Encrypted backups of relay DB** · Difficulty: ADVANCED ·
> Scope: `services/*`, `migrations/`, `scripts/`, `deploy`

This runbook covers operation of encrypted snapshots of the relayer SQLite
database (`data/zkvote.db` / `data/relayer.db`). It complements
[`BACKUP_RECOVERY.md`](./BACKUP_RECOVERY.md) (unencrypted online backups +
Litestream) and the relay threat model (see `THREAT_MODEL.md`): backups are now
**encrypted at rest and in object storage**, so a compromised backup bucket or
stolen disk never leaks plaintext relay data.

---

## 1. How it works

1. `src/services/backup.ts` produces a consistent SQLite snapshot via
   better-sqlite3's online backup API.
2. `src/services/backupCrypto.ts` wraps the snapshot in an **AES-256-GCM
   envelope**: a fresh random 256-bit Data Encryption Key (DEK) is generated
   per backup, and that DEK is itself encrypted (wrapped) under a Key
   Encryption Key (KEK) derived with **scrypt** from your configured passphrase.
3. `src/services/backupKeyManager.ts` resolves the KEK. The passphrase is never
   stored in the artifact — each snapshot header only records a **key ID**
   (non-secret fingerprint) plus the KDF salt and wrapped DEK.
4. The container is verified (decrypted + `PRAGMA integrity_check`) immediately
   after creation, uploaded to object storage when configured, and rotated
   (retention prunes old encrypted snapshots).

**File format** — magic `ZKVE`, version `1`, header + streamed ciphertext + GCM
tag. Files end with `.enc.db`.

---

## 2. Bootstrapping a key

Generate a key and write it to a secure file **or** pass it via the
`BACKUP_ENCRYPTION_KEY` environment variable / secret manager.

```bash
# From the repository root (fills backend/.env at the same time if used):
./scripts/rotate-backup-key.sh generate --output data/backup-keys/current.key

# Or directly:
cd backend && npx tsx src/backup-key-manager.ts generate --output data/backup-keys/current.key
```

Paste the generated base64 key into your secrets (e.g. `fly secrets set
BACKUP_ENCRYPTION_KEY=...` on Fly.io, or Vault), **not** just the file —

the file only lives on one host. Losing the passphrase **permanently** loses
the backups; that is by design.

### Configuration (`.env`)

```env
BACKUP_ENCRYPTION_ENABLED=true          # turn on encrypted snapshots
BACKUP_ENCRYPTION_KEY=<base64 key>      # in production use the secret manager
# BACKUP_ENCRYPTION_KEY_FILE=./data/backup-keys/current.key   # single-host alternative
# BACKUP_KEY_RING_DIR=./data/backup-keys                       # archived keys
# BACKUP_ENCRYPTION_AUTO_INIT=false       # dev-only: generate a key on first boot
# BACKUP_RETENTION_COUNT=10               # on-disk encrypted snapshots to keep
# BACKUP_S3_BUCKET=                       # object storage bucket for off-site copies
```

When `BACKUP_ENCRYPTION_ENABLED=true` the relayer schedules encrypted snapshots
every `BACKUP_INTERVAL_MS` (default 24h) in addition to the WAL-level
Litestream stream; each is `verify`d on creation and pruned by retention.

> **Refusal to back up unencrypted.** If encryption is requested but no key is
> available, `createBackup()` fails loudly and **does not** write a plaintext
> fallback snapshot.

---

## 3. Verifying a snapshot

```bash
# On-demand verification (decrypts to a temp file, integrity check, cleanup):
./scripts/rotate-backup-key.sh status
cd backend && npx tsx src/backup-key-manager.ts verify --input data/backups/zkvote-backup-<ts>.enc.db
```

Health endpoint (with auth token for full detail):

```json
{
  "backup": {
    "lastBackupStatus": "success",
    "lastBackupEncrypted": true,
    "encryption": {
      "enabled": true,
      "algorithm": "aes-256-gcm",
      "kdf": "scrypt",
      "currentKeyId": "88ad5b1993123966",
      "totalKeys": 2,
      "archivedKeys": 1
    }
  }
}
```

---

## 4. Rotating the key

Rotation requires **no re-encryption of existing backups** (each snapshot has
its own wrapped DEK). The old key is archived to the key ring so old snapshots
keep decrypting.

```bash
# 1. Rotate (archives current key, writes a new current key):
./scripts/rotate-backup-key.sh rotate --output data/backup-keys/current.key

# 2. If the current key came from an env var / secret manager, deploy the NEW
#    base64 key printed by the command into BACKUP_ENCRYPTION_KEY.
# 3. Keep the archive directory (data/backup-keys/) backed up — it is required
#    to decrypt snapshots older than the rotation.
# 4. Confirm:
cd backend && npx tsx src/backup-key-manager.ts status
```

`status` shows `archivedKeys` (old, retained) and `totalKeys` (usable for
restore). Old snapshots remain verifiable and restorable:

```bash
npx tsx src/backup-key-manager.ts verify --input data/backups/zkvote-backup-<before-rotation>.enc.db
```

Metadata for every key lifecycle event (created / rotated-in / archived) is
written to the `backup_keys` table (migration `004`) whenever a DB is open —
key **material** itself is never stored in the database.

---

## 5. Restore + restore verification (disaster recovery drill)

The **accepted restore test** is automated in CI
(`test/backup-encryption.test.js`, `test/backup-key-rotation.test.js`) and
available as a dry-run drill that touches **no** production database:

```bash
./scripts/rotate-backup-key.sh restore-test --input data/backups/zkvote-backup-<ts>.enc.db
# => RESTORE TEST PASSED: Restore drill passed: integrity ok, N tables, decrypted
```

Full point-in-time restore from an encrypted snapshot:

```bash
# 1. Stop the relayer.
# 2. Decrypt the snapshot to a plaintext file (uses current key + key ring):
cd backend && npx tsx src/backup-key-manager.ts decrypt \
  --input data/backups/zkvote-backup-<ts>.enc.db \
  --output data/restored-relayer.db
# 3. Verify + swap in, exactly as in BACKUP_RECOVERY.md (PITR) steps.
sqlite3 data/restored-relayer.db "PRAGMA integrity_check;"
cp data/restored-relayer.db data/zkvote.db
rm -f data/zkvote.db-wal data/zkvote.db-shm
# 4. Restart the relayer and confirm /health reports lastBackupStatus success.
```

The same flow is available programmatically:

```ts
import { restoreFromBackup, verifyRestore } from "../services/backup.js";
await verifyRestore("data/backups/zkvote-backup-<ts>.enc.db");      // drill
await restoreFromBackup("data/backups/zkvote-backup-<ts>.enc.db");  // PITR
```

---

## 6. Recovery of an orphaned snapshot

If a snapshot exists but its key was never archived (e.g. a decommissioned
host), import the key into the ring by its fingerprint:

```bash
cd backend && npx tsx src/backup-key-manager.ts import-key <base64-key> --id <keyId-from-header>
npx tsx src/backup-key-manager.ts verify --input data/backups/zkvote-backup-<ts>.enc.db
```

The key ID you need is recorded in the snapshot header; `verify` with no key
returns the expected ID in its error message.

---

## 7. Operational notes & troubleshooting

| Situation                                   | Action |
|---|---|
| `createBackup` fails: *"no backup encryption key is configured"* | Configure `BACKUP_ENCRYPTION_KEY` (or key file / `BACKUP_ENCRYPTION_AUTO_INIT` for dev). The relayer will not write plaintext fallbacks. |
| `verify` fails with *"No backup encryption key available"* | Import the missing key with `import-key`, or restore the key ring from your own backup. |
| `verify` fails with *"Authentication failed"* | Wrong key for that snapshot era — check `status` → `archivedKeys`, then re-import. |
| `size mismatch` / corrupt header            | Snapshot truncated in transit or storage — discard and rely on the next snapshot + Litestream WAL. |
| Key file permissions                        | CLI writes key files with mode `0600`; verify with `ls -l data/backup-keys/`. |
| Monitoring                                  | Watch `/health` → `backup.lastBackupStatus` and `encryption.keysAvailable`; alert on `currentKeyId` changing without a planned rotation. |

**Hardening:**

- Store `BACKUP_ENCRYPTION_KEY` in the secret manager (Vault / Fly secrets); keep
  `data/backup-keys/` (key ring) out of the repo and into your own backup.
- Rotate keys on a schedule (e.g. every 90 days) and after personnel changes.
- Test a **restore drill** at least quarterly — automation lives in
  `test/backup-encryption.test.js` and `scripts/rotate-backup-key.sh restore-test`.

---

## 8. Files touched (for reviewers)

- `backend/src/services/backupCrypto.ts` — encrypted container format, encrypt/decrypt/probe
- `backend/src/services/backupKeyManager.ts` — key resolution, generation, rotation, key ring
- `backend/src/services/backup.ts` — encrypted create/verify/restore, encryption status, prune
- `backend/src/backup-key-manager.ts` — ops CLI (`generate|status|rotate|import-key|encrypt|decrypt|verify|restore-test`)
- `backend/src/migrations/004_add_backup_key_metadata.{up,down}.sql` — key audit table
- `backend/src/config.ts`, `backend/.env.example`, `backend/src/index.ts` — config + scheduled encrypted backups
- `scripts/rotate-backup-key.sh` — wrapper script
- `backend/test/backup-encryption*.test.js`, `backend/test/backup-key-rotation.test.js` — restore/rotation verification