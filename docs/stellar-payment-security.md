# Stellar payment security invariants

This document records the payment/swap invariants enforced by the relayer.

## Pinned protocol versions

| Surface | Pinned version / unit |
| --- | --- |
| Soroban SDK | `25.3.0` |
| Stellar JavaScript SDK | `15.1.0` |
| `snarkjs` | `0.7.5` |
| Horizon classic-asset precision | 7 decimals (`10^7` stroops per unit) |
| Soroban token precision used by payment bridges | 12 decimals |

A Horizon stroop maps to exactly `10^5` Soroban token units. Conversions use integer arithmetic only. A 12-decimal Soroban amount that is not divisible by `10^5` is rejected rather than rounded for Horizon.

## Soroswap contract pinning

`SOROSWAP_API` is not trusted to choose the contract that a quote represents. Soroswap fallback remains disabled unless `SOROSWAP_CONTRACT_ID` is configured with the exact reviewed `C...` router contract. Every fallback response must return the same contract id; missing or mismatched ids are rejected and counted by `zkvote_swap_contract_rejected_total`.

The frontend independently checks `VITE_SOROSWAP_CONTRACT_ID` before displaying a Soroswap quote. Backend and frontend pins must match at deployment time.

## Trustlines

XLM does not use a trustline. USDC/EURC payments require both the relayer and destination account to have the matching asset trustline.

The relayer can sign `changeTrust` for its own account and therefore creates its missing trustline automatically. It cannot create a trustline for an arbitrary destination account: that operation requires the destination account signature. The payment API therefore preflights destination trustlines and returns an actionable error before submitting a payment when the line is missing or awaiting issuer authorization.

`GET /pay/trustline?account=G...&asset=USDC` exposes that preflight to the UI. Failures are counted by `zkvote_trustline_preflight_failure_total`.

## BN254 host-call bound

The Groth16 verifier rejects BN254 pairing vectors unless both sides contain exactly four terms. Voting batch size is currently capped at one proof so an attacker cannot amplify Protocol-25 host pairing cost through an `N + 3` batch vector. The length check occurs before the host pairing function is invoked.

## Settlement reconciliation (SPIKE-037 / #720)

Multi-anchor SEP-31 receive flows require reconciliation between anchor-confirmed and chain-settled state to establish terminal settlement truth.

### Settlement state machine

Every settlement progresses through deterministic states:

- **pending**: Initiated, awaiting anchor confirmation
- **confirmed**: Anchor confirmed, awaiting chain finality
- **settled**: Chain-finalized and reconciled (terminal)
- **disputed**: Anchor vs chain disagree (support intervention)
- **failed**: Permanently failed (terminal)

### Conflict resolution rules

Deterministic resolution for anchor-vs-chain divergence:

| Conflict Type | Resolution Rule |
|---------------|-----------------|
| `amount_mismatch` | Chain amount is terminal truth. Delta < 1% reconciles silently. Delta >= 1% marks disputed. |
| `memo_mismatch` | If chain tx matches account, reconcile. Muxed/memo mismatch marks disputed (credit risk). |
| `status_divergence` | Wait 5 min for finality. If anchor says settled but chain pending after timeout, mark disputed. |
| `fee_mismatch` | Delta < 0.1% reconciles silently. Delta 0.1-5% logs and updates. Delta > 5% marks disputed. |
| `double_callback` | Idempotency key: `(anchorTxId, chainHash)`. Accept first, reject duplicates. Alert on divergent hashes. |
| `missing_chain_tx` | Wait 10 min. If anchor confirmed but no chain tx, mark disputed (settlement failed). |
| `missing_anchor_conf` | Match chain tx by amount + memo. Exact match reconciles. Otherwise, mark disputed. |

### Fee accounting

Fee breakdown tracks:
- **Quoted amount**: User-visible pre-transaction
- **Anchor fees**: Network + service fees deducted anchor-side
- **Chain fees**: On-chain transaction fees
- **Settled amount**: Final amount credited (terminal truth)

All fees explicit and user-visible before settlement.

### Aging alerts

Settlements aging beyond thresholds trigger monitoring alerts:
- **10 minutes**: Warning (normal finality exceeded)
- **30 minutes**: Error (likely stuck, support review)
- **2 hours**: Critical (definite failure, manual intervention)

Alerts fire before user complaints.

### Data model

Settlement records (`settlementReconciliation.ts`) store:
- Anchor state: txId, status, confirmedAt, amount
- Chain state: txHash, ledger, finalizedAt, amount, memo
- Fee breakdown: quoted/anchor/chain/settled amounts
- Conflict tracking: type, detectedAt, resolution

### Implementation status

**Current:** Foundation types and conflict rules defined.

**Required (SPIKE-037 acceptance):**
- Callback-chaos tested convergence
- Fee audit (quoted vs deducted vs received)
- Multi-anchor adapter pattern
- Dispute view for support
- Aging-unsettled monitoring alerts
- Storage layer (migrations)

See `backend/src/services/settlementReconciliation.ts` for implementation.
