# ZKVote - Anonymous DAO Voting on Stellar

Zero-knowledge anonymous DAO voting on Stellar Soroban using Protocol 25 (BN254 + Poseidon).

**Version:** 1.0.0 - Multi-Tenant Architecture with Real Groth16 Verification

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
├── frontend/               # React frontend (Vite + TailwindCSS)
├── backend/                # Relayer service for anonymous voting
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
# Start backend relayer
cd backend && npm run relayer

# Start frontend (separate terminal)
cd frontend && npm run dev
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

## License

MIT
