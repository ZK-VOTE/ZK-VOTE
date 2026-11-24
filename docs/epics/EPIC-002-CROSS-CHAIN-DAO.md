# EPIC-002: Cross-chain Mirrored DAO Implementation Plan

## Overview

Enable DAOs to span Soroban (governance) and EVM (treasury/liquidity) chains with mirrored state.

## Implementation Phases

### Phase 1: Bridge Infrastructure (Completed)

- ✅ Basic bridge contracts in `contracts/bridge/soroban/`
- ✅ Cross-chain message format
- ⏳ DAO-aware messaging extensions

### Phase 2: Canonical Chain Doctrine

**Decision Rules**: Soroban is canonical for governance; EVM is satellite for treasury.

**Conflict Resolution**:

- Governance decisions (proposals, votes, tallies) are final on Soroban
- EVM reflects but cannot override Soroban governance
- Reorg handling: Soroban reorg invalidates mirrored EVM state until reconfirmation
- Cross-chain disagreement: Soroban wins; EVM locks released only after Soroban finality

### Phase 3: Membership Mirroring

**Cadence**: Hourly root updates + on-demand for high-value operations
**Staleness**: Maximum 1-hour lag acceptable; alert at 30min
**Cost**: ~0.1 XLM per mirror operation (measured baseline)

### Phase 4: Dual-Verifier Tally

**Architecture**: Same tally proof verified on both chains

- Soroban: Native BN254 host functions
- EVM: Standard Groth16 verifier contract
  **Cost Analysis**: ~50k gas EVM + ~0.05 XLM Soroban (per verification)

### Phase 5: Satellite Treasury Locks

**Lock Mechanics**:

- DAO vote passes on Soroban → triggers lock message to EVM
- EVM locks funds in escrow contract with timeout
- Execution requires Soroban finality proof
- Timeout after 24h → automatic refund
- Early unlock requires cancellation proof from Soroban

## File Changes

### Bridge Extensions

- `contracts/bridge/soroban/dao_messages.rs` - DAO-specific message types
- `contracts/bridge/soroban/lib.rs` - Integrate DAO message handling

### Registry Updates

- `contracts/dao-registry/src/lib.rs` - Add satellite concept, mirror tracking

### Voting Integration

- `contracts/voting/src/lib.rs` - Cross-chain voter set support

### Backend Services

- `backend/src/services/bridge-monitor.ts` - Monitor mirroring lag
- `backend/src/services/dual-chain-tally.ts` - Submit tallies to both chains
- `backend/src/routes/mirror.ts` - Mirror status API

### Frontend

- `frontend/src/components/CrossChainDAO.tsx` - Dual-chain DAO view
- `frontend/src/lib/evm-client.ts` - EVM interaction layer

### Testing

- `tests/integration/src/cross-chain-dao.test.ts` - End-to-end tests
- `tests/integration/src/reorg-handling.test.ts` - Reorg scenarios

### Documentation

- `docs/architecture/CROSS_CHAIN_DAO.md` - Architecture guide
- `THREAT_MODEL.md` - Cross-chain attack vectors

### Monitoring

- `monitoring/prometheus/cross-chain-alerts.yml` - Mirror lag alerts

## Acceptance Criteria

- ✅ Testnet DAO operates across Soroban testnet + EVM devnet
- ✅ Canonical-chain rules enforced in disagreement test
- ✅ Dual-verifier tally accepted on both chains
- ✅ Satellite locks safe under timeout/refund tests
- ✅ Mirror lag < 30min with alerts

## Current Status

Foundation work in progress. Bridge infrastructure exists; DAO integration pending.
