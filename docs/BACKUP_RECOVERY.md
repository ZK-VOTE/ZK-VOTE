# ZK-VOTE Database Backup & Point-in-Time Recovery (PITR) Guide

## Overview

The ZK-VOTE database (`data/zkvote.db`) stores critical blockchain indexer events, DAO metadata, comments, and system configuration. To ensure maximum reliability and operational resilience, ZK-VOTE implements a multi-tier backup and recovery system:

1. **Automated Daily Online Backups**: Uses SQLite's `backup()` API (`better-sqlite3`) to create consistent database snapshots without interrupting service.
2. **Backup Verification**: Immediate `PRAGMA integrity_check` validation on created backups.
3. **Encrypted Snapshots**: Optional AES-256-GCM encrypted snapshots so disaster-recovery copies never contain plaintext relay data. See [`ENCRYPTED_BACKUPS.md`](./ENCRYPTED_BACKUPS.md) for the full runbook (key management, rotation, restore drills).
4. **Point-in-Time Recovery (PITR)**: Safe automated and manual restoration capabilities from backup snapshots.
5. **Litestream Continuous WAL Replication**: Continuous streaming of Write-Ahead Log (WAL) changes to external S3-compatible object storage (ideal for Fly.io deployments).
6. **Health Endpoint Monitoring**: Exposes real-time backup metrics on `GET /health`.

---

## 1. Automated Backups

Backups are executed programmatically via `src/services/backup.ts`.

### Configuration
Environment variables in `.env`:
```env
BACKUP_INTERVAL_MS=86400000        # Daily (24 hours)
BACKUP_S3_BUCKET=my-zkvote-backups  # Optional S3 bucket for external copies
LITESTREAM_ENABLED=true             # Continuous WAL replication flag
```

### Manual Backup Trigger
You can programmatically trigger a backup in Node.js:
```typescript
import { createBackup } from "./services/backup.js";

const result = await createBackup();
console.log(result);
// { success: true, fileName: 'zkvote-backup-...db', checksum: '...', durationMs: 45 }
```

---

## 2. Litestream Continuous Replication

Litestream runs alongside the backend server on Fly.io / Linux to continuously stream SQLite WAL frames to S3/GCS.

### Configuration (`litestream.yml`)
```yaml
dbs:
  - path: ./data/zkvote.db
    replicas:
      - type: s3
        bucket: ${LITESTREAM_S3_BUCKET}
        path: zkvote-db-replication
        sync-interval: 1s
        snapshot-interval: 24h
```

### Running Litestream in Production
In Dockerfile / Fly.io entrypoint:
```bash
litestream replicate -config litestream.yml &
```

---

## 3. Point-in-Time Recovery (PITR)

### Automated Code Restoration
Use `restoreFromBackup(backupFilePath)` from `src/services/backup.ts`:
```typescript
import { restoreFromBackup } from "./services/backup.js";

const result = await restoreFromBackup("./data/backups/zkvote-backup-2026-07-27.db");
if (result.success) {
  console.log("Database restored successfully.");
}
```

### Manual Restoration Steps
1. Stop the ZK-VOTE backend service:
   ```bash
   npm run stop # or stop container
   ```
2. Run backup integrity check:
   ```bash
   sqlite3 ./data/backups/target-backup.db "PRAGMA integrity_check;"
   ```
3. Replace active database file:
   ```bash
   cp ./data/backups/target-backup.db ./data/zkvote.db
   rm -f ./data/zkvote.db-wal ./data/zkvote.db-shm
   ```
4. Restart ZK-VOTE backend service:
   ```bash
   npm run relayer
   ```

---

## 4. Verification and Health Check

Check `/health` endpoint to monitor backup status:
```bash
curl http://localhost:3001/health
```
Response:
```json
{
  "status": "ok",
  "db": {
    "totalEvents": 1420,
    "daoCount": 5
  },
  "backup": {
    "lastBackupAt": "2026-07-27T12:00:00.000Z",
    "lastBackupStatus": "success",
    "backupCount": 14,
    "litestream": {
      "enabled": true,
      "status": "active"
    }
  }
}
```
