# DaoVote Circom Circuits

Zero-knowledge circuits for anonymous DAO voting on Stellar Soroban.

## Overview

These circuits enable anonymous voting by proving:
1. **Membership** - Voter belongs to the DAO (Merkle tree inclusion proof)
2. **Uniqueness** - One vote per member per proposal (nullifier)
3. **Validity** - Vote is binary (0 or 1)

Without revealing:
- Which member cast the vote
- How they voted (to other members)

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Frontend      │     │   Circuits   │     │    On-chain     │
│   (Browser)     │     │   (WASM)     │     │   (Soroban)     │
├─────────────────┤     ├──────────────┤     ├─────────────────┤
│ - User secret   │────▶│ - Poseidon   │────▶│ - Verify root   │
│ - Merkle proof  │     │ - Groth16    │     │ - Check nullif. │
│ - Vote choice   │     │ - Generate   │     │ - Verify proof  │
└─────────────────┘     │   proof      │     │ - Tally vote    │
                        └──────────────┘     └─────────────────┘
```

## Circuit Structure

### `vote.circom` (Main Circuit)
- Tree depth: 18 levels (supports ~262K members)
- Public signals: `[root, nullifier, daoId, proposalId, voteChoice]`
- Private inputs: `[secret, salt, pathElements, pathIndices]`
- Constraints: ~3,500 (well under pot14 limit of 16,384)
- Nullifier: `Poseidon(secret, daoId, proposalId)` (domain-separated)

### `merkle_tree.circom` (Helper)
- Poseidon hash-based Merkle tree inclusion proof
- Compatible with Stellar's on-chain Poseidon (BN254)

## Prerequisites

Install Node.js dependencies:
```bash
npm install
```

Install Circom compiler (v2.0+):
```bash
# Using npm
npm install -g circom

# Or from source
git clone https://github.com/iden3/circom.git
cd circom
cargo build --release
cargo install --path circom
```

Install snarkjs:
```bash
npm install -g snarkjs
```

## Compilation

Compile the circuit and perform trusted setup:

```bash
./compile.sh
```

This will:
1. Compile `vote.circom` to R1CS
2. Download Powers of Tau file (pot14_final.ptau, ~50MB)
3. Generate proving key (zkey)
4. Export verification key

**Note:** Uses pot14 (2^14 = 16,384 constraints), sufficient for our ~3.5K constraint circuit.

## Generate Proof

1. Create test members and input:
```bash
node utils/generate_input.js
```

2. Generate proof:
```bash
./generate_proof.sh
```

3. Convert to Soroban format:
```bash
node utils/proof_to_soroban.js
```

### Generate Custom Test Proofs

For integration tests you can generate Soroban-formatted proofs with custom inputs (secret/salt/index):

```bash
# Example: member at index 0, dao 1, proposal 1, yes vote
node generate_proof_instance.js --label member2_index0 --secret 222222222 --salt 333333333 --dao 1 --proposal 1 --vote 1 --index 0 --depth 18

# Convert to Soroban BE (handles G2 ordering)
node convert_proof_to_soroban_be.js circuits/generated/proof_member2_index0_proof.json circuits/generated/public_member2_index0.json
```

This writes Soroban-ready proof hex in `circuits/generated/proof_<label>_proof_soroban_be.json` along with public signals. Integrate those constants directly in tests to avoid runtime parsing.

### Converter Regression Test

`utils/test/proof_converter.test.js` locks endianness and G2 limb ordering. Run:
```bash
cd utils && node --test
```

## Input Format

```json
{
  "root": "12345...",           // Merkle root (public)
  "nullifier": "67890...",      // Vote nullifier (public)
  "daoId": "1",                 // DAO ID (public, for domain separation)
  "proposalId": "42",           // Proposal ID (public)
  "voteChoice": "1",            // 0=against, 1=for (public)

  "secret": "11111...",         // Voter's secret (private)
  "salt": "22222...",           // Random salt (private)
  "pathElements": ["...", ...], // Merkle siblings (private)
  "pathIndices": ["0", "1", ...]// Path directions (private)
}
```

## Output Files

After compilation:
- `build/vote.r1cs` - Constraint system
- `build/vote_js/` - WASM prover
- `build/vote_final.zkey` - Proving key
- `build/verification_key.json` - Verification key

After proof generation:
- `proof.json` - Groth16 proof (a, b, c)
- `public.json` - Public signals
- `proof_soroban.json` - Soroban-formatted proof

## On-Chain Integration

The verification key must be uploaded to the Voting contract:

```bash
node utils/vkey_to_soroban.js build/verification_key.json
```

This generates the hex-encoded verification key for Soroban.

## Security Considerations

1. **Trusted Setup**: The `.zkey` file requires a trusted setup ceremony. In production, multiple parties should contribute.

2. **Secret Management**: The voter's `secret` must be kept private. If leaked, votes can be traced.

3. **Nullifier Uniqueness**: Nullifier = Poseidon(secret, daoId, proposalId) ensures one vote per proposal per DAO, with domain separation preventing cross-DAO voter linkability.

4. **Root Validation**: On-chain contract validates the Merkle root is recent (within history window).

5. **Domain Separation**: The nullifier includes `daoId` to prevent voters from being correlated across different DAOs when reusing the same identity secret.

## Testing

Run a simple test with 3 members:

```bash
# Generate test members and input
node utils/generate_input.js

# This creates:
# - input.json (circuit input for member 1 voting on proposal 42)
# - test_members.json (secret/salt/commitment for all members)

# Generate and verify proof
./generate_proof.sh input.json
```

## Compatibility

- **Poseidon Hash**: Uses circomlib's Poseidon (BN254 scalar field)
- **On-chain**: Matches Stellar P25 `env.crypto().poseidon_hash()`
- **Curve**: BN254 (same as Stellar's Groth16 verifier)
- **Proof System**: Groth16

## File Structure

```
circuits/
├── vote.circom              # Main vote circuit
├── merkle_tree.circom       # Merkle proof helper
├── package.json             # Dependencies
├── compile.sh               # Compilation script
├── generate_proof.sh        # Proof generation script
├── utils/
│   ├── generate_input.js    # Create test inputs
│   ├── vkey_to_soroban.js   # Convert VK to Soroban format
│   └── proof_to_soroban.js  # Convert proof to Soroban format
└── build/                   # Compiled outputs (gitignored)
```

## Next Steps

1. Compile circuits: `./compile.sh`
2. Test proof generation: `node utils/generate_input.js && ./generate_proof.sh`
3. Upload verification key to Voting contract
4. Integrate with relayer backend for anonymous submission
