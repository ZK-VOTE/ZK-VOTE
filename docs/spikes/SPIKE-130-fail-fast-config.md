# SPIKE-130: Fail-Fast Configuration

## Decision

Configuration validation is staged. Fast checks run during every boot; network checks run in deployment preflight and can be explicitly enabled for local development. Validation returns field names and remediation, never secret values.

## Validation matrix

| Value | Fast check | Deep/pre-deploy check |
| --- | --- | --- |
| RPC URL | absolute HTTPS URL outside development | bounded health request and network identity |
| Contract IDs | Soroban `C...` format | contract exists on the configured network |
| Asset issuers | Stellar public-key format | issuer/network consistency |
| Secrets | required, non-placeholder, minimum length | secret-canary test confirms redaction |
| CORS origins | explicit origins outside development | origin and deployment-host consistency |
| Frontend `VITE_*` | required and non-placeholder at build | manifest matches runtime network and contract IDs |

Unknown environment keys are errors in production. Development may opt into warnings, but the warning must identify the key and remediation without printing its value.

## Required behavior

Boot must refuse to start when a required value is absent, a placeholder is used, or a value has the wrong format. Deployment preflight must refuse stale contract IDs, unreachable RPC, and network mismatches. The frontend build must fail before producing an artifact when its public configuration is invalid.

## Test battery

The preflight suite should cover missing values, typoed keys, wildcard CORS, invalid Stellar keys, wrong network, unreachable RPC, stale contract IDs, and a canary secret. Assertions must verify that neither thrown errors nor logs contain the canary value.

