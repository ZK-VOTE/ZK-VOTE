# IPFS Pinning Redundancy Architecture

## Overview
The ZK-VOTE IPFS architecture is designed to prevent data loss resulting from content unpinning, API rate limits, or quota exhaustion at any single provider. Given that IPFS CIDs serve as the immutable link between on-chain proposals and their off-chain metadata, ensuring permanent data availability is critical.

The redundancy architecture achieves this through three core mechanisms:
1. **Local Backup:** All content is cached to local disk *before* any pinning operation occurs.
2. **Secondary Pinning:** Content is pushed to Web3.Storage as a fallback redundancy layer, in addition to Pinata.
3. **Active Monitoring & Auto-Repin:** A background scheduler actively polls public gateways to verify CID reachability and automatically re-pins unreachable content from the local backup cache.

## 1. Local Backup Cache
Before a `/ipfs/image` or `/ipfs/metadata` upload hits the Pinata API, the data is synchronously written to the relayer's local filesystem (`IPFS_BACKUP_DIR`).
- **Files:** Backed up to `<backup_dir>/files/`
- **JSON Metadata:** Backed up to `<backup_dir>/json/`
- **Pin Meta-Registry:** The mapping of CID to local backup path, size, and cost estimates is stored in `<backup_dir>/meta/<cid>.json`

This ensures that even if a network interruption causes the Pinata upload to fail, or if Pinata later scrubs the data due to billing issues, the relayer has the raw bytes necessary to re-create the exact same CID later.

## 2. Multi-Provider Pinning
The primary IPFS provider is **Pinata**. However, relying on a single SaaS provider creates a single point of failure.

To mitigate this, the architecture introduces **Secondary Pinning** via **Web3.Storage**. After the Pinata upload succeeds and the content is backed up locally, an asynchronous fire-and-forget task uploads the local backup blob to Web3.Storage.
- This prevents latency spikes on the frontend, as the response returns as soon as the Pinata upload completes.
- It ensures the CID is pinned across multiple IPFS nodes operated by completely different infrastructure providers.

## 3. The Pin Verification Monitor
A persistent background loop (`ipfs-monitor.ts`) runs at configured intervals (default: every 1 hour) to verify the health of all registered pins.

### Verification Logic
1. The monitor fetches all registered CIDs from the local meta-registry.
2. For each CID, it performs a lightweight HTTP `HEAD` request against a list of robust public gateways (e.g., `ipfs.io`, `dweb.link`, `cloudflare-ipfs.com`).
3. If the CID resolves on *any* gateway, it is marked as "Healthy".
4. If it fails to resolve across *all* gateways within a timeout period, its `consecutiveFailures` counter is incremented.

### Alerting & Auto-Repin
If a CID's `consecutiveFailures` exceeds the `PIN_ALERT_THRESHOLD` (default: 3):
- A **Warning/Critical Alert** is generated and surfaced via the `/ipfs/health` endpoint.
- If `PIN_AUTO_REPIN` is enabled (default: true), the monitor reads the raw data from the local backup cache and pushes it back up to the primary Pinata node.
- This self-healing mechanism requires zero operator intervention and resolves temporary data unavailability silently.

## 4. Cost Tracking
Pinata's free tier caps at 500 MB. To assist node operators in capacity planning, the pin manager tracks the cumulative byte-size of all active pins and calculates a projected `estimatedMonthlyCostUsd` based on standard pinning rates. This data is available via `/ipfs/health`.

## Environment Variables
Operators can configure the redundancy layer using the following environment variables in `backend/.env`:

| Variable | Default | Description |
|---|---|---|
| `IPFS_BACKUP_DIR` | `./data/ipfs-backup` | Path to the local disk directory for storing backups. |
| `WEB3_STORAGE_TOKEN` | *None* | Optional token to enable secondary pinning to Web3.Storage. |
| `PIN_VERIFY_INTERVAL_MS`| `3600000` | How often the monitor verifies CID health (1 hour). |
| `PIN_ALERT_THRESHOLD` | `3` | How many consecutive failures before triggering auto-repin. |
| `PIN_AUTO_REPIN` | `true` | Whether to automatically re-upload failed pins from local backup. |

## Endpoints

### `GET /ipfs/health`
Returns the status of the IPFS connection alongside rich statistics from the Pin Monitor.

```json
{
  "enabled": true,
  "status": "healthy",
  "pinVerification": {
    "monitorRunning": true,
    "totalPins": 42,
    "healthyPins": 42,
    "degradedPins": 0,
    "failedPins": 0,
    "totalSizeBytes": 10485760,
    "estimatedMonthlyCostUsd": 0.001,
    "lastScanAt": "2026-07-27T01:00:00.000Z",
    "nextScanAt": "2026-07-27T02:00:00.000Z",
    "activeAlerts": 0,
    "alerts": []
  }
}
```


## 5. Upload malware gate and quarantine (ZV-138)

Every public IPFS pin operation scans the bytes at the service boundary before
backup, pinning, secondary replication, or gateway propagation. JSON metadata
is scanned before sanitization; images are scanned before image decoding and
again at the pinning boundary. Pinata CID keyvalues record `scan_status`,
`scan_engine`, and `scan_at` for clean uploads.

Production requires a reachable ClamAV daemon. Configure either
`CLAMAV_SOCKET` or `CLAMAV_HOST` (and optionally `CLAMAV_PORT`). When the
scanner is absent or unavailable:

- `/ready` and `/readyz` return HTTP 503 and report the scanner as unavailable.
- IPFS image and metadata uploads return HTTP 503 and are not queued for later
  pinning, backed up, or replicated.
- A clean result is never inferred from a failed scan.

Rejected EICAR or ClamAV-positive payloads are written to a private quarantine
directory (default: `backend/data/ipfs-quarantine`, override with
`IPFS_QUARANTINE_DIR`) with restrictive directory/file permissions and a
sidecar record containing a content hash, reason, timestamp, and quarantine
status. Quarantined files are not registered as CIDs, pinned, or served.

For local development only, if no ClamAV endpoint is configured, the service
uses an explicitly labelled EICAR-only fallback. This fallback is never
accepted in production. CI includes the EICAR regression test.
