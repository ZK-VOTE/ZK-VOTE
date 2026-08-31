# Circuit Test Harness CI Documentation

## Overview

The ZK-VOTE CI pipeline now includes automated circuit testing to ensure Poseidon hash compatibility and end-to-end ZK proof functionality before production deployment.

## CI Jobs

### 1. Circuit KAT Test (`circuit-kat`)

**Purpose**: Verify that circomlib Poseidon and Stellar Protocol 25 (P25) host function produce identical results.

**Requirements**:
- Must pass before production deployment
- Tests Poseidon hash compatibility between circomlib and P25
- Deploys contracts to local P25 testnet
- Compares Merkle roots from both implementations

**Script**: `scripts/test/poseidon-kat.sh`

**Test Flow**:
1. Start local P25 testnet (Stellar container)
2. Create and fund test account
3. Build WASM contracts (dao-registry, membership-sbt, membership-tree)
4. Deploy contracts with constructors
5. Create test DAO
6. Initialize Merkle tree (depth 20)
7. Mint SBT for test member
8. Register known commitment (Poseidon(12345, 67890))
9. Get current Merkle root from P25
10. Compare with expected root from circomlib
11. Fail if mismatch, succeed if match

**Expected Values**:
- Input: Poseidon(12345, 67890)
- Expected Root (circomlib): `0x2d8b784789ca06c6bb30d7593b0774a6124aff26581f04b9125d1be25e46545d`
- Expected Root (U256 JSON): `{"hi_hi":3286161620916250310,"hi_lo":13489905787044537510,"lo_hi":1319043788869878969,"lo_lo":1327085652556297309}`

**Failure Behavior**:
- Script exits with code 1 on KAT mismatch
- CI job fails immediately
- Blocks deployment until fixed

**Artifacts**:
- Uploaded as `kat-test-results`
- Contains built WASM contracts
- Retained for 7 days

### 2. Circuit E2E Test (`circuit-e2e`)

**Purpose**: Test end-to-end ZK proof generation and verification on Stellar futurenet.

**Requirements**:
- Tests real Groth16 verification with BN254 pairing
- Validates complete voting flow with ZK proofs
- Uses pre-deployed contracts on futurenet

**Script**: `scripts/test/e2e-zkproof.sh`

**Test Flow**:
1. Check/mint SBT for test member
2. Generate test key and identity (secret + salt)
3. Compute Poseidon commitment off-chain (circomlibjs)
4. Register commitment on-chain (self_register)
5. Get leaf index and current Merkle root
6. Create proposal
7. Get Merkle path for commitment
8. Compute nullifier (Poseidon(secret, daoId, proposalId))
9. Generate Groth16 proof (snarkjs)
10. Convert proof to Soroban format
11. Submit vote with ZK proof
12. Verify vote was recorded

**Contract IDs (Futurenet)**:
- Registry: `CB6CH7UNQSEZ2R5EZSHLFLZBX4X7OWF2FVVWX23MY2BG66V75TAFUE7O`
- SBT: `CDVDFULVS6MT3WIE7ITCIXPZ7FYBDF2RQBXBUBQMQJH6WA6KFPKF7TFN`
- Tree: `CC2GRLKCBCRNAUKKVHKJBJPVKTMZ5YY2DXN67HZGRC5D67MN6Y6VQ7ZX`
- Voting: `CALJTLBN6GMXT2XKBRWZG7STMQU5FUBRWGFHLXXDTZLG5MESLIXIIZ5O`

**Prerequisites**:
- Stellar CLI installed
- Node.js with circomlibjs
- Circuit artifacts compiled (`vote.wasm`, `vote_final.zkey`)
- Funded key on futurenet

**Artifacts**:
- Uploaded as `e2e-test-results`
- Contains circuit artifacts from `frontend/public/circuits/`
- Retained for 7 days

## CI Configuration

### Job Dependencies

```
contracts → circuit-kat
contracts + frontend → circuit-e2e
```

- `circuit-kat` depends on `contracts` (needs WASM builds)
- `circuit-e2e` depends on `contracts` and `frontend` (needs circomlibjs and circuit artifacts)

### Caching Strategy

**Cargo Cache**:
- Path: `~/.cargo/registry`, `~/.cargo/git`, `target`
- Key: `${{ runner.os }}-cargo-${{ hashFiles('**/Cargo.lock') }}`
- Speeds up Rust compilation and WASM builds

**NPM Cache**:
- Path: `frontend/node_modules`
- Key: Based on `frontend/package-lock.json`
- Speeds up frontend dependency installation

### Artifact Retention

- KAT test results: 7 days
- E2E test results: 7 days
- Includes WASM contracts and circuit artifacts

## Running Tests Locally

### KAT Test

```bash
# Prerequisites
- Docker running
- Stellar CLI with P25 support

# Run test
./scripts/test/poseidon-kat.sh
```

### E2E Test

```bash
# Prerequisites
- Stellar CLI installed
- Node.js with circomlibjs
- Funded key on futurenet

# Create and fund key
stellar keys generate mykey
stellar keys fund mykey --network futurenet

# Run test
./scripts/test/e2e-zkproof.sh mykey
```

## Troubleshooting

### KAT Test Failures

**Symptom**: KAT test fails with mismatch error

**Causes**:
1. Poseidon parameters differ between circomlib and P25
2. Field arithmetic implementation mismatch
3. Round constants or initialization issues

**Resolution**:
1. Check Poseidon implementation in both codebases
2. Verify field size (should be BN254 scalar field)
3. Compare round constants and initialization vectors
4. Ensure same number of rounds and permutation

### E2E Test Failures

**Symptom**: E2E test fails during proof generation or verification

**Causes**:
1. Circuit artifacts not compiled or incompatible
2. Missing circomlibjs dependencies
3. Network connectivity issues with futurenet
4. Insufficient funds for test account

**Resolution**:
1. Compile circuits: `cd circuits && ./compile.sh`
2. Install dependencies: `cd frontend && npm install`
3. Fund test account: `stellar keys fund mykey --network futurenet`
4. Check network status: `stellar network info`

### CI Job Failures

**Symptom**: CI jobs fail intermittently

**Causes**:
1. Docker container startup timeout
2. Network connectivity issues
3. Resource exhaustion (memory/CPU)
4. Dependency installation failures

**Resolution**:
1. Increase timeout values in scripts
2. Check GitHub Actions runner status
3. Verify artifact cache is not corrupted
4. Re-run failed jobs with debug logging

## Security Considerations

### KAT Test

- Uses local P25 testnet (isolated environment)
- No real assets at risk
- Tests cryptographic compatibility only
- Must pass before production deployment

### E2E Test

- Uses public futurenet (test network)
- Requires funded test account
- Tests real ZK proof verification
- Validates complete voting flow

## Maintenance

### Updating Expected Values

If Poseidon implementation changes:

1. Run KAT test locally with new implementation
2. Extract new expected root from circomlib
3. Update `EXPECTED_ROOT` in `poseidon-kat.sh`
4. Update this documentation
5. Commit and deploy

### Updating Contract IDs

If futurenet contracts change:

1. Get new contract IDs from deployment
2. Update contract IDs in `e2e-zkproof.sh`
3. Update this documentation
4. Commit and deploy

### Circuit Artifact Updates

When circuits are recompiled:

1. Update `vote.wasm` and `vote_final.zkey` in `frontend/public/circuits/`
2. Run E2E test to verify compatibility
3. Update CI if needed
4. Deploy new artifacts

## References

- [Poseidon Hash Specification](https://eprint.iacr.org/2019/453.pdf)
- [Stellar Protocol 25](https://github.com/stellar/soroban-docs/blob/main/cap-0055.md)
- [Groth16 Proof System](https://eprint.iacr.org/2016/260.pdf)
- [circomlibjs](https://github.com/iden3/circomlibjs)
- [snarkjs](https://github.com/iden3/snarkjs)
