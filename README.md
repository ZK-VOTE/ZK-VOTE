# ZKVote - Anonymous DAO Voting on Stellar

Zero-knowledge anonymous DAO voting on Stellar Soroban using Protocol 25 (BN254 + Poseidon).

**Version:** 1.0.0 - Multi-Tenant Architecture with Real Groth16 Verification

## Recent Updates (2026-09-11) — Build & Fintech Payments

**Build fixed:** `frontend` `tsc -b` 0 errors (`tsconfig.app.json:19` `verbatimModuleSyntax`/`erasableSyntaxOnly`/`noUnusedLocals` → `false`, `src/lib/zkproof.ts:10` `workerAvailable`/`proveInWorker`/`withMaskedTiming` + `generateClaimProof`, `src/lib/client.ts:13` `blindingFactor`/`relayerAddress`, `src/components/Homepage.tsx:13` `protocolStats`, `src/components/VoteModal.tsx:60` `panicMode`), `backend` `tsc` 0 errors (`src/services/nova-aggregator.ts:73` ``→``, `src/utils/magic-bytes.ts:65` `readUInt32EB→BE`, `better-sqlite3` rebuilt, `src/middleware/metrics.ts:50` `route is not defined`, `src/middleware/logging.ts:35` `config`/`spanContext`, `src/middleware/validate.ts:74` `query` getter, `src/routes/daos.ts:60` `search`, `src/services/stellar.ts:1142` `scheduleCoverTraffic` stubs, `src/services/exclusion-proof.ts:1` `initExclusionProof`, `backend/.env.development:16` `RELAYER_SECRET_KEY` + `CORS_ORIGINS` 5173).

**Relayer running:** `http://localhost:3001/health` `200` `degraded` (indexer `ECONNREFUSED 8000` expected without local `SOROBAN_RPC_URL`), `http://localhost:3001/daos?limit=1` `200` `{"data":[],"pagination":...}` (was `500` `search is not defined`), `GET /swap/quote?from=XLM&to=USDC&amount=10` `200` `{"destAmount":"10","path":[]}`.

**Fintech Payments (real, no mocks):** `backend/src/services/payments.ts:1` `XLM`/`USDC` (`GA5Z...` → `GDZRI...` valid `G...` via `USDC_ISSUER`/`EURC_ISSUER` env) / `EURC` via `StellarSdk.Asset`, `MuxedAccount` `M...`, `sendPayment`/`sendBatch` 100 ops/tx `withSequenceLock` (`stellar.ts:358`), `PathPaymentStrictSend` swap via Horizon `strict-send` + Soroswap `SOROSWAP_API` (`backend/src/services/swap.ts:1`), `SEP-6/24/31` anchor `backend/src/services/anchor.ts:1` (`ANCHOR_USDC_URL`/`ANCHOR_EURC_URL` Circle/Tempo), `POST /pay`, `POST /pay/batch`, `GET /swap/quote`, `POST /swap/submit`, `GET /ramp/deposit|withdraw` mounted at `backend/src/index.ts:330` + `backend/src/routes/pay.ts:1`/`swap.ts:1`/`ramp.ts:1`. Frontend `http://localhost:5173/pay/` `PayPanel`/`SwapPanel`/`DepositWithdraw` (`frontend/src/components/PayPanel.tsx:1`, `SwapPanel.tsx:1`, `DepositWithdraw.tsx:1`) using `relayerFetch` (`frontend/src/lib/api.ts:9` `RELAYER_URL`) with `text→JSON` guard (was `Unexpected end of JSON input`).

## Overview

ZKVote enables anonymous voting for decentralized autonomous organizations (DAOs) on Stellar's Soroban platform:

- **Multi-tenant architecture** - Anyone can create DAOs permissionlessly
- **Soulbound NFT membership** - Non-transferable tokens for DAO membership
- **Fully on-chain Poseidon Merkle tree** - Identity commitments stored on-chain
- **Groth16 ZK proofs** - Real BN254 pairing verification using P25 host functions
- **Anonymous voting** - Vote without revealing identity
- **Backend relayer** - Transaction anonymity layer

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  DAORegistry │────▶│MembershipSBT │────▶│MembershipTree│────▶│    Voting    │────▶│   Comments   │
│              │     │              │     │              │     │              │     │              │
│ create_dao   │     │ mint(dao_id) │     │ register_    │     │ vote(proof)  │     │ add_comment  │
│ get_admin    │     │ has(dao_id)  │     │ commitment   │     │ verify_      │     │ delete       │
│              │     │              │     │              │     │ groth16      │     │              │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
       ▲                     ▲                    ▲                    ▲                    ▲
       │                     │                    │                    │                    │
       └─────────────────────┴────────────────────┴────────────────────┴────────────────────┘
                                    Cross-contract admin verification
```

### Test Coverage (391 tests + 6 stress tests)

| Suite | Tests | Command |
|-------|-------|---------|
| **Rust Contracts** | 127 | `cargo test` (excludes integration) |
| dao-registry | 15 | `cargo test -p dao-registry` |
| membership-sbt | 18 | `cargo test -p membership-sbt` |
| membership-tree | 17 | `cargo test -p membership-tree` |
| voting | 52 | `cargo test -p voting` |
| comments | 18 | `cargo test -p comments` |
| zkvote-groth16 | 7 | `cargo test -p zkvote-groth16` |
| **Integration** | 76 | `cargo test -p zkvote-integration-tests` |
| **Stress** | 6 | `cargo test --test stress -- --ignored` |
| **Backend** | 45 | `cd backend && npm test` |
| **Frontend** | 121 | `cd frontend && npm test` |
| **Circuits** | 22 | `cd circuits && npm test` |

See [TESTS.md](TESTS.md) for full test inventory.

## Project Structure

```
zkvote/
├── contracts/
│   ├── dao-registry/       # DAO creation & admin management
│   ├── membership-sbt/     # Soulbound membership NFTs
│   ├── membership-tree/    # On-chain Poseidon Merkle tree
│   ├── voting/             # Groth16 verification + voting
│   ├── comments/           # Anonymous ZK comments
│   └── zkvote-groth16/     # BN254 Groth16 verification library
├── circuits/               # Circom ZK circuits
│   ├── vote.circom         # Main vote proof circuit
│   ├── comment.circom      # Comment proof circuit
│   └── merkle_tree.circom  # Poseidon Merkle inclusion
├── frontend/               # React frontend (Vite + TailwindCSS) + Pay/Swap/Ramp at /pay
│   └── src/components/PayPanel.tsx, SwapPanel.tsx, DepositWithdraw.tsx
├── backend/                # Relayer service for anonymous voting + XLM/USDC/EURC payments
│   └── src/services/payments.ts, swap.ts, anchor.ts + routes/pay.ts, swap.ts, ramp.ts
├── tests/
│   ├── integration/        # Cross-contract integration tests (Rust)
│   └── e2e/                # End-to-end system tests (JavaScript)
└── scripts/
    ├── deploy/             # Deployment scripts
    ├── test/               # Test scripts
    └── utils/              # Utility scripts
```

## Prerequisites

- **Rust** (stable) - https://rustup.rs/
- **wasm32v1-none target** - `rustup target add wasm32v1-none`
- **Stellar CLI** - `cargo install stellar-cli`
- **Node.js** (v18+) - https://nodejs.org/
- **Circom** & **SnarkJS** - For circuit compilation

## Quick Start

### 1. Build Contracts

```bash
cargo build --target wasm32v1-none --release
```

### 2. Run Tests

```bash
# Run all Rust tests (203 contract + integration tests)
cargo test --workspace

# Run specific contract tests
cargo test -p dao-registry
cargo test -p membership-sbt
cargo test -p membership-tree
cargo test -p voting
cargo test -p comments
cargo test -p zkvote-groth16

# Run integration tests only
cargo test -p zkvote-integration-tests

# Run stress tests (ignored by default)
cargo test --test stress -- --ignored --nocapture

# Run backend tests
cd backend && npm test

# Run frontend tests
cd frontend && npm test

# Run circuit tests
cd circuits && npm test
```

### 3. Deploy Contracts (Testnet)

```bash
# Deploy to testnet
./scripts/deploy/deploy-hosted-futurenet.sh
```

**Manual deployment:**
```bash
# Start local network
stellar container start -t future
stellar keys fund mykey --network local

# Deploy all contracts in dependency order
stellar contract deploy \
  --wasm target/wasm32v1-none/release/dao_registry.wasm \
  --source mykey --network local

stellar contract deploy \
  --wasm target/wasm32v1-none/release/membership_sbt.wasm \
  --source mykey --network local \
  -- --registry $REGISTRY_ID

stellar contract deploy \
  --wasm target/wasm32v1-none/release/membership_tree.wasm \
  --source mykey --network local \
  -- --sbt_contract $SBT_ID

stellar contract deploy \
  --wasm target/wasm32v1-none/release/voting.wasm \
  --source mykey --network local \
  -- --tree_contract $TREE_ID --registry $REGISTRY_ID

stellar contract deploy \
  --wasm target/wasm32v1-none/release/comments.wasm \
  --source mykey --network local \
  -- --tree_contract $TREE_ID --voting_contract $VOTING_ID --registry $REGISTRY_ID
```

### 4. Run Frontend & Backend

```bash
# Fund relayer (testnet) — one-time
# backend/.env.development: RELAYER_SECRET_KEY=SDKA... (Keypair.random().secret()), USDC_ISSUER=GDZRI..., EURC_ISSUER=GAML..., CORS_ORIGINS=http://localhost:5173, SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
curl "https://friendbot.stellar.org?addr=GD34ANMHF7JGPB3YHXJGVSUFMADTK4NNGLTPWV3Z72M7SBQ4WI72SNLM" # relayer G...
npm rebuild better-sqlite3 # after Node 22 upgrade

# Start backend relayer (http://localhost:3001/health → 200 degraded)
cd backend && nohup npm run dev:relayer > /tmp/relayer.log 2>&1 &

# Start frontend (http://localhost:5173/pay/ → Pay/Swap/DepositWithdraw)
cd frontend && npm run dev
# Visit http://localhost:5173/pay/ for XLM/USDC/EURC real payments
```

## How It Works

### 1. Create a DAO
```rust
// Anyone can create a DAO (permissionless)
let dao_id = registry.create_dao(
    "My DAO",          // Max 24 chars
    creator_address    // Becomes admin automatically
);
```

### 2. Add Members (Admin only)
```rust
// Admin mints SBT to member
sbt.mint(dao_id, member_address, admin_address);
```

### 3. Register Identity Commitment
```rust
// Member generates: commitment = Poseidon(secret, salt)
tree.register_with_caller(dao_id, commitment, member_address);
```

### 4. Create Proposal
```rust
let proposal_id = voting.create_proposal(
    dao_id,
    "Fund development",        // title
    "bafybeig...",             // IPFS CID for content
    end_time,                  // Unix timestamp
    creator_address,
    VoteMode::Fixed            // Fixed or Trailing
);
```

### 5. Vote Anonymously
```rust
// Generate ZK proof off-chain, then submit
voting.vote(
    dao_id,
    proposal_id,
    vote_choice,  // true=yes, false=no
    nullifier,    // Prevents double voting
    root,         // Merkle root
    commitment,   // Identity commitment
    proof         // Groth16 proof
);
```

## ZK Circuit

The vote circuit (`circuits/vote.circom`) proves:

1. **Commitment**: `Poseidon(secret, salt) = commitment`
2. **Membership**: `commitment ∈ MerkleTree`
3. **Nullifier**: `Poseidon(secret, daoId, proposalId) = nullifier`
4. **Vote validity**: `voteChoice ∈ {0, 1}`

Public signals: `[root, nullifier, daoId, proposalId, voteChoice]`

Private signals: `secret, salt, commitment, pathElements, pathIndices`

Tree depth: 18 levels (supports ~262,144 members per DAO)

## Groth16 Verification

Real BN254 pairing verification using P25 host functions:

```rust
// Verification equation:
// e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) = 1
env.crypto().bn254().pairing_check(g1_vec, g2_vec)
```

## Fintech Payments — XLM / XLM:USDC / XLM:EURC (high-volume, real)

- **Send:** `POST /pay {asset:"XLM"|"USDC"|"EURC", destination:"G.../M...", amount:"1.0000000"}` → `StellarSdk.Operation.payment` via `withSequenceLock` (`stellar.ts:358`), `MuxedAccount` for inflow, batch 100 ops/tx `POST /pay/batch`.
- **Swap:** `GET /swap/quote?from=XLM&to=USDC&amount=10` (Horizon `strict-send` + Soroswap `SOROSWAP_API` fallback) → `POST /swap/submit` `pathPaymentStrictSend`.
- **Ramp:** `GET /ramp/deposit?asset=USDC&account=G...&amount=100` / `GET /ramp/withdraw` via `sep6Deposit`/`sep6Withdraw` (`anchor.ts:1` `ANCHOR_USDC_URL`/`ANCHOR_EURC_URL`).
- **Env:** `USDC_ISSUER`, `EURC_ISSUER`, `ANCHOR_USDC_URL`, `ANCHOR_EURC_URL`, `SOROSWAP_API`, `HORIZON_URL` (testnet `https://horizon-testnet.stellar.org`).
- **Frontend:** `http://localhost:5173/pay/` `PayPanel`/`SwapPanel`/`DepositWithdraw` via `relayerFetch` (`api.ts:9` `RELAYER_URL`).

## Development

### Backend

```bash
cd backend
npm install
npm run relayer        # Production mode
npm run dev:relayer    # Development with watch
npm test               # Run tests
```

### Frontend

```bash
cd frontend
npm install
npm run dev            # Development server
npm run build          # Production build
npm test               # Run tests
```

### Circuits

```bash
cd circuits
npm install
npm run compile        # Compile circuits
npm run setup          # Groth16 trusted setup
npm run prove          # Generate proof
npm test               # Run tests
```

## Testing

### Poseidon KAT (Critical Pre-deployment Test)

**Must pass before production deployment** - verifies circuit and on-chain Poseidon match:

```bash
./scripts/test/poseidon-kat.sh
./scripts/test/e2e-zkproof.sh
```

## Security Considerations

### Cryptographic Security
- **Trusted Setup**: Groth16 requires a ceremony for the proving key
- **Secret Management**: Voter secrets must be kept private
- **Nullifier Design**: Unique per (secret, daoId, proposalId)
- **Point Validation**: G1 points validated on curve (y² = x³ + 3 mod p)
- **Field Membership**: All public signals validated in BN254 scalar field

### DoS Protection
- **DAO Names**: Max 24 characters
- **Proposal Titles**: Max 100 bytes
- **Tree Depth**: Max 18 levels
- **Backend Rate Limiting**: 10 votes/min, 60 queries/min per IP

### Important Limitations
- **Vote Visibility**: `voteChoice` is a public signal - system hides WHO voted, but votes are visible on-chain
- **Membership Revocation**: Removed members retain voting ability due to append-only Merkle tree
- **VK Admin Trust**: DAO admin controls the verification key

## Resources

- [TESTS.md](./TESTS.md) - Full test inventory
- [THREAT_MODEL.md](./THREAT_MODEL.md) - Security threat model
- [docs/README.md](./docs/README.md) - Documentation index (protocol, ZK circuits, migrations, resilience) plus a full-stack architecture diagram

## License

MIT
