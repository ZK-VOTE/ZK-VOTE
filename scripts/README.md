# ZKVote Scripts

Scripts for deploying and testing ZKVote on Stellar Soroban (Testnet).

## Directory Structure

```
scripts/
├── deploy/                         # Deployment scripts
│   ├── deploy-hosted-testnet.sh  # Deploy all contracts to testnet
├── test/                           # Test scripts
│   ├── e2e-zkproof.sh              # Real ZK proof e2e test
│   └── poseidon-kat.sh             # Poseidon KAT verification
└── utils/                          # Utility scripts
    ├── convert-vk-to-hex.js        # VK format conversion
    ├── poseidon-kat-verify.js      # Generate KAT vectors
    ├── create-public-dao.sh        # Create test DAO
    └── run_budget_sim.sh           # Budget simulation
```

## Prerequisites

1. **Stellar CLI** installed:
   ```bash
   cargo install stellar-cli
   ```

2. **Funded Testnet account**:
   ```bash
   stellar keys generate mykey
   stellar keys fund mykey --network testnet
   ```

3. **Contracts built**:
   ```bash
   cargo build --target wasm32v1-none --release
   ```

## Quick Start

### Deploy to Testnet

```bash
# Deploy all contracts
./scripts/deploy/testnet.sh

# Set verification key
./scripts/deploy/set-vk.sh
```

### Run Tests

```bash
# Run ZK proof e2e test
./scripts/test/e2e-zkproof.sh

# Run Poseidon KAT verification
./scripts/test/poseidon-kat.sh

# Run Rust unit/integration tests
cargo test --workspace
```

## Deploy Scripts

### `deploy/testnet.sh`

Deploys all contracts in dependency order with constructor arguments.

**Environment variables:**
- `SOURCE` - Deployer account key name (default: `mykey`)
- `WASM_DIR` - WASM files directory (default: `target/wasm32v1-none/release`)

**Output:**
- Creates `.contract-ids.testnet` with deployed contract addresses

**Deployment order:**
1. DAORegistry (no constructor)
2. MembershipSBT (constructor: `registry`)
3. MembershipTree (constructor: `sbt_contract`)
4. Voting (constructor: `tree_contract`)
5. Comments (constructor: `registry`)

### `deploy/set-vk.sh`

Sets the Groth16 verification key on the voting contract.

**Usage:**
```bash
./scripts/deploy/set-vk.sh
```

## Test Scripts

### `test/e2e-zkproof.sh`

End-to-end test with real ZK proof generation and verification on testnet.

**What it tests:**
1. Create DAO
2. Add member with SBT
3. Register commitment
4. Create proposal
5. Generate real Groth16 proof
6. Submit vote through relayer
7. Verify vote recorded

### `test/poseidon-kat.sh`

Known Answer Test for Poseidon hash function. Verifies circuit and on-chain Poseidon match.

**MUST pass before production deployment.**

## Utility Scripts

### `utils/convert-vk-to-hex.js`

Converts snarkjs verification key to hex format for on-chain storage.

```bash
node scripts/utils/convert-vk-to-hex.js circuits/build/verification_key.json
```

### `utils/poseidon-kat-verify.js`

Generates Poseidon Known Answer Test vectors using circomlibjs.

### `utils/create-public-dao.sh`

Helper script to create a public DAO for testing.

### `utils/run_budget_sim.sh`

Simulates contract calls to capture CPU/memory budgets.

```bash
./scripts/utils/run_budget_sim.sh
```

## Contract Dependencies

```
DAORegistry (no deps)
    ↓
MembershipSBT (needs: registry)
    ↓
MembershipTree (needs: sbt_contract)
    ↓
Voting (needs: tree_contract)
```

## Generated Files

### `.contract-ids.testnet`
```bash
NETWORK=testnet
REGISTRY_ID=CXXX...
SBT_ID=CXXX...
TREE_ID=CXXX...
VOTING_ID=CXXX...
COMMENTS_ID=CXXX...
```

## Security

- Never commit `.env` files or secret keys
- Use separate keys for testnet and mainnet
- Verify network passphrases before deployment
- Monitor relayer account balance

## See Also

- `tests/e2e/` - JavaScript e2e test suite
- `tests/integration/` - Rust integration tests
- Main `README.md` for project overview
