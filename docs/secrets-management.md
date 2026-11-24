# Secrets Management Architecture

## Overview

ZK-VOTE implements a multi-backend secrets management system that supports dynamic secret retrieval
at runtime, audit logging, automatic rotation monitoring, and encryption at rest.

## Backends

The secrets manager supports three backends in priority order:

1. **HashiCorp Vault** (primary) — Secrets fetched dynamically via Vault's HTTP API
2. **Fly.io secrets** (fallback) — Secrets set via `fly secrets`, injected as env vars
3. **Environment variables** (last resort) — Direct `process.env` access

## Architecture

### Components

- **`backend/src/services/secrets/secret-manager.ts`** — Main secret retrieval service with Vault
  integration, Fly.io secrets fallback, and env var fallback. Every access is audited.
- **`backend/src/services/secrets/encryptor.ts`** — AES-256-GCM encryption at rest for secret
  values. Uses PBKDF2 key derivation with a master key.
- **`backend/src/services/secrets/audit-logger.ts`** — Structured JSON audit logging for every
  secret access event (get, set, rotate).
- **`backend/src/services/secrets/rotation-monitor.ts`** — Tracks secret rotation status and
  expiration. Reports overdue and expiring-soon secrets.
- **`backend/src/services/secrets/types.ts`** — TypeScript type definitions for all secret
  management interfaces.

### Secret Retrieval Flow

```
getSecret("RELAYER_SECRET_KEY")
  |
  +--> Vault configured? --> fetchFromVault("RELAYER_SECRET_KEY")
  |       |
  |       +--> found? --> return value
  |       +--> not found / error --> fallback to env
  |
  +--> Env var set? --> return value
  |
  +--> return undefined
```

Every access is recorded in the audit log with:
- Timestamp
- Secret key (e.g., `RELAYER_SECRET_KEY`)
- Operation type (`get`, `set`, `rotate`)
- Success/failure status
- Request ID for correlation
- Source backend (`vault`, `env`, `fly-secrets`)

### Encryption at Rest

When secrets are stored via `setSecret()`, they are encrypted with AES-256-GCM before being
written to Vault or env vars. The encryption key is derived using PBKDF2 with 100,000 iterations
and a random 16-byte salt.

**Encrypted payload format:**
```json
{
  "s": "<base64 salt>",
  "i": "<base64 IV>",
  "a": "<base64 auth tag>",
  "c": "<base64 ciphertext>"
}
```

### Rotation Monitoring

The rotation monitor tracks per-secret rotation intervals:

| Secret Key | Default Rotation Interval |
|---|---|
| `RELAYER_SECRET_KEY` | 30 days |
| `RELAYER_AUTH_TOKEN` | 7 days |
| `PINATA_JWT` | 30 days |

Rotation status values:
- **`healthy`** — Secret is within its rotation window
- **`expiring-soon`** — Secret expires within 7 days
- **`overdue`** — Secret has exceeded its rotation interval or expiration date
- **`unknown`** — No rotation metadata available

### Health Monitoring

The following endpoints are available:

| Endpoint | Description | Auth Required |
|---|---|---|
| `GET /health/secrets` | Secret health monitoring — rotation status, backend availability | No config-level auth; use `healthExposeDetails` + RELAYER_AUTH_TOKEN for full access |
| `GET /health/backend` | Backend configuration summary (no secret values) | No |

## Configuration

### Environment Variables

| Variable | Description |
|---|---|
| `VAULT_URL` | HashiCorp Vault API URL (e.g., `https://vault.example.com:8200`) |
| `VAULT_TOKEN` | Vault token for token-based auth |
| `VAULT_ROLE_ID` | AppRole role ID for AppRole auth |
| `VAULT_SECRET_ID` | AppRole secret ID for AppRole auth |
| `VAULT_MOUNT_PATH` | Vault mount path (default: `secret`) |
| `VAULT_SECRETS_PATH` | Vault secrets path (default: `kv/data/zkvote`) |

### Initialization

The secrets manager is initialized automatically on first secret access via the fallback-to-env
configuration. For Vault integration, set `VAULT_URL` and one of `VAULT_TOKEN` or `VAULT_ROLE_ID`/`VAULT_SECRET_ID`.

```typescript
import { initSecretManager } from "./services/secrets/index.js";

initSecretManager({
  vault: {
    url: process.env.VAULT_URL,
    token: process.env.VAULT_TOKEN,
  },
  fallbackToEnv: true,
});
```

## Security Notes

1. **No secrets in health endpoints** — The `/health` and `/ready` endpoints never expose secret values. Only derived public data (e.g., relayer public key) is shown.
2. **Audit trail** — Every secret access is logged with a structured audit entry.
3. **Encryption at rest** — Secrets stored via `setSecret()` are encrypted with AES-256-GCM.
4. **Rotation monitoring** — Secrets are tracked for expiration and overdue rotation.
5. **Coalesced fetches** — In-flight duplicate secret fetches are coalesced to avoid redundant Vault requests.

## Relayer Signing Keys (Issue #746)

Relayer secrets differ from the other secrets here: each one **is a Stellar
account**, so rotating it changes the relayer's on-chain identity (new
sequence chain, new balance). Rotation is therefore a runtime operation run by
the rotation orchestrator, not a secret-store update. The runbook is
`docs/ops/RELAYER_KEY_ROTATION.md`; this section only states the storage rules.

| Secret | Holder | Rule |
| :--- | :--- | :--- |
| `RELAYER_SECRET_KEY` | relayer | Active identity. Max age `RELAYER_KEY_MAX_AGE_DAYS` (alerted) |
| `RELAYER_SECONDARY_SECRET_KEY` | relayer | Standby; must be **funded** before it is needed |
| `RELAYER_COSIGNER_KEYS` | relayer (verifier) | One HMAC secret per co-signer, `id:secret` |
| `RELAYER_COSIGNER_SECRET` | each co-signer, on their own machine | Never stored with the relayer's admin token |
| `RELAYER_BREAK_GLASS_SECRET` | sealed, ≥ 32 chars | Warm tier only; every use is audited |
| `RELAYER_SWEEP_SAFE_ACCOUNT` | config (public key) | Cold account; its secret is never on the relayer |

Rotation spec:
1. **Order:** register + fund the new identity → rotate at runtime → update the secret store → retire the old secret after the drain window. Updating the secret store first would boot the next instance on an identity that was never cut over.
2. **Compromise:** declare first (runtime revocation is persisted in `relayer_key_revocations`), then remove the secret from the store. Removing the secret alone does not stop the running process signing with it.
3. **Co-signer secrets** rotate independently. Approvals expire, so rotating a co-signer secret invalidates only outstanding approvals from that co-signer.
4. A leaked relayer secret's **funds** are recovered by the two-person sweep, never by importing the secret elsewhere.

## Future Enhancements

- Automatic secret rotation (scheduled rotation via Vault's built-in rotation engine)
- Vault AppRole authentication with automatic token renewal
- Integration with Vault's PKI secrets engine for TLS certificate management
- Metrics export for secret access patterns (Prometheus)