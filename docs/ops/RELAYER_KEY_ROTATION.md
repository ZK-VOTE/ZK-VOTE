# Operations Runbook: Zero-Downtime Relayer Key Rotation & Multi-Key Management

**Issue:** #177  
**Type:** Security & Operational Architecture Runbook  
**Status:** Production Ready  

---

## 1. Overview & Objectives

The ZKVote Relayer submits zero-knowledge vote transactions on behalf of users on Stellar/Soroban. The relayer key manager supports:
- **Multiple Relayer Keys**: Primary active key alongside secondary/standby keys.
- **Zero-Downtime Hot Key Rotation**: Swapping signing keys dynamically without restarting the server or dropping in-flight transactions.
- **Automated Low-Balance Failover**: Monitoring XLM gas reserves and automatically failing over to funded secondary keys when the active balance drops below the threshold.
- **Automated Key Generation & Funding**: Generating new keypairs and funding them via Friendbot (testnet/futurenet) or on-chain transfer.
- **Privileged Admin API**: Protected administrative endpoints to manage, rotate, fund, and inspect relayer keys.
- **Health Monitoring & Prometheus Metrics**: Key age, transaction counts, balance tracking, and rotation auditing.

---

## 2. Multi-Key Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   ZKVote Relayer Process                    │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                 RelayerKeyManager                     │  │
│  │                                                       │  │
│  │  ┌───────────────────────┐ ┌───────────────────────┐  │  │
│  │  │   Primary Active Key  │ │  Secondary / Standby  │  │  │
│  │  │ (Active Signing Key)  │ │ (Funded Failover Key) │  │  │
│  │  └───────────┬───────────┘ └───────────▲───────────┘  │  │
│  │              │                         │              │  │
│  │              │   Zero-Downtime Hot     │              │  │
│  │              └─── Swap / Failover ─────┘              │  │
│  └──────────────────────┬────────────────────────────────┘  │
│                         │                                   │
│                         ▼ (Active Signer)                   │
│             ┌───────────────────────┐                       │
│             │   Transaction Builder │                       │
│             └───────────────────────┘                       │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Configuration & Environment Variables

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `RELAYER_SECRET_KEY` | `string` | *(Required)* | Primary Stellar secret key (`S...`) |
| `RELAYER_PUBLIC_KEY` | `string` | `""` | Primary Stellar public address (`G...`) |
| `RELAYER_SECONDARY_SECRET_KEY` | `string` | `""` | Optional pre-configured secondary secret key |
| `RELAYER_SECONDARY_PUBLIC_KEY` | `string` | `""` | Optional secondary public address |
| `RELAYER_MIN_BALANCE_XLM` | `number` | `5` | Minimum XLM balance before low-balance warning/failover |
| `RELAYER_AUTO_ROTATE_LOW_BALANCE`| `boolean`| `true` | Automatically hot-swap to secondary key on low balance |
| `FRIENDBOT_URL` | `string` | Futurenet | Friendbot endpoint for testnet funding |
| `RELAYER_AUTH_TOKEN` | `string` | *(Required)* | Master admin bearer token for privileged API operations |

---

## 4. Operational Procedures

### 4.1. Manual Zero-Downtime Key Rotation via Admin API

To rotate from the current active key to the standby key:

```bash
curl -X POST http://localhost:3001/admin/relayer/rotate \
  -H "Authorization: Bearer $RELAYER_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "routine_monthly_rotation"}'
```

**Response (200 OK):**
```json
{
  "status": "success",
  "message": "Relayer key rotated successfully with zero downtime",
  "activeKey": {
    "id": "relayer-secondary",
    "publicKey": "GBX...SECONDARY",
    "role": "primary",
    "status": "active",
    "balanceXlm": 100.0,
    "txCount": 0
  },
  "previousKey": {
    "id": "relayer-primary",
    "publicKey": "GA1...PRIMARY",
    "role": "secondary",
    "status": "standby"
  }
}
```

### 4.2. Inspecting Relayer Key Health & Balances

```bash
curl -X GET http://localhost:3001/admin/relayer/health \
  -H "Authorization: Bearer $RELAYER_AUTH_TOKEN"
```

**Response (200 OK):**
```json
{
  "status": "healthy",
  "activeKey": {
    "id": "relayer-primary",
    "publicKey": "GA1...PRIMARY",
    "role": "primary",
    "status": "active",
    "balanceXlm": 45.2,
    "ageDays": 12,
    "txCount": 1420
  },
  "secondaryKey": {
    "id": "relayer-secondary",
    "publicKey": "GBX...SECONDARY",
    "role": "secondary",
    "status": "standby",
    "balanceXlm": 50.0
  },
  "totalKeys": 2,
  "availableStandbyKeys": 2,
  "minBalanceThresholdXlm": 5,
  "autoRotateEnabled": true,
  "alerts": []
}
```

### 4.3. Generating & Registering a New Secondary Key

```bash
# 1. Generate a new keypair
curl -X POST http://localhost:3001/admin/relayer/generate \
  -H "Authorization: Bearer $RELAYER_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role": "secondary", "makeActive": false}'

# 2. Fund the newly generated key on testnet/futurenet
curl -X POST http://localhost:3001/admin/relayer/fund \
  -H "Authorization: Bearer $RELAYER_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"publicKey": "GNEW...PUBLICKEY"}'
```

### 4.4. Automated Low-Balance Failover

1. The service periodically checks the active key's native XLM balance.
2. If `balanceXlm < RELAYER_MIN_BALANCE_XLM` (e.g. < 5 XLM), a `relayer_low_balance_detected` warning is logged.
3. If `RELAYER_AUTO_ROTATE_LOW_BALANCE=true` and a funded secondary key is available, `relayerKeyManager` automatically executes a hot-swap.
4. Nonce tracking is updated via `sequenceManager.markDirty()`, ensuring no transactions fail.

---

## 5. Prometheus Metrics

- `zkvote_relayer_key_balance_xlm`: Current XLM balance by key ID, public key, and role.
- `zkvote_relayer_key_rotations_total`: Counter for rotation events by trigger (`manual`, `low_balance`, `api`, `scheduled`).
- `zkvote_relayer_key_age_seconds`: Age in seconds since key activation.
- `zkvote_relayer_key_transactions_total`: Cumulative transaction count signed by each key.
