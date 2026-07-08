# Poseidon Hash Known Answer Test (KAT)

This document explains how to verify that Stellar P25's Poseidon implementation matches circomlib's parameters.

## Why This Matters

The DaoVote system uses Poseidon hash in three places:
1. **Circomlib circuits** (vote.circom, merkle_tree.circom) - compute proofs off-chain
2. **Circomlibjs** (generate_input.js) - compute commitments and nullifiers
3. **Stellar P25 host** (membership-tree contract) - verify Merkle roots on-chain

If these implementations use different parameters, the system will fail:
- Merkle proofs won't verify
- Commitments won't match
- Proofs will be rejected

## Parameters We're Verifying

### Circomlib Poseidon (Official Implementation)
- **Field**: BN254 scalar field (Fr) ≈ 2^254
- **S-box**: x^5
- **Full rounds**: 8
- **Partial rounds**: 
  - t=2 (1 input): 56
  - t=3 (2 inputs): 57
  - t=4 (3 inputs): 56
- **Source**: https://eprint.iacr.org/2019/458.pdf (Table 2, Table 8)

### Stellar P25 Poseidon (Host Implementation)
- **Field**: BN254 scalar field (Fr)
- **Host function**: `env.crypto().poseidon_hash(inputs, "BN254")`
- **Expected**: Should match circomlib parameters exactly

## Running the KAT

### Step 1: Generate Reference Values (Circomlib)

```bash
cd circuits
node utils/poseidon_kat.js
```

Expected output (reference values):
```
Zero leaf:
  Inputs:  [0]
  Hash:    19014214495641488759237505126948346942972912379615652741039992445865937985820

Two inputs (secret=1, salt=2):
  Inputs:  [1, 2]
  Hash:    7853200120776062878684798364095072458815029376092732009249414926327459813530

Two inputs (left=0, right=0) - empty node:
  Inputs:  [0, 0]
  Hash:    14744269619966411208579211824598458697587494354926760081771325075741142829156

Merkle Tree Zero Values:
zeros[0] = 0
zeros[1] = 14744269619966411208579211824598458697587494354926760081771325075741142829156
zeros[2] = 7423237065226347324353380772367382631490014989348495481811164164159255474657
zeros[3] = 11286972368698509976183087595462810875513684078608517520839298933882497716792
```

### Step 2: Verify On-Chain (Stellar P25)

**Prerequisites**: 
- P25-compatible test network running (`stellar container start -t future`)
- Membership-tree contract deployed with `testutils` feature enabled

```bash
# Build with testutils feature
cd contracts/membership-tree
cargo build --release --target wasm32-unknown-unknown --features testutils

# Deploy to local test network
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/membership_tree.wasm \
  --source mykey \
  --network testnet

# Save contract ID
TREE_ID="<contract_id_from_deploy>"

# Test: Poseidon(1, 2) should equal 7853200120776062878684798364095072458815029376092732009249414926327459813530
stellar contract invoke \
  --id $TREE_ID \
  --source mykey \
  --network testnet \
  -- test_poseidon_hash \
  --a 1 \
  --b 2

# Test: Poseidon(0, 0) should equal 14744269619966411208579211824598458697587494354926760081771325075741142829156
stellar contract invoke \
  --id $TREE_ID \
  --source mykey \
  --network testnet \
  -- test_poseidon_hash \
  --a 0 \
  --b 0

# Test: zeros[1] should equal 14744269619966411208579211824598458697587494354926760081771325075741142829156
stellar contract invoke \
  --id $TREE_ID \
  --source mykey \
  --network testnet \
  -- test_zero_at_level \
  --level 1

# Test: zeros[2] should equal 7423237065226347324353380772367382631490014989348495481811164164159255474657
stellar contract invoke \
  --id $TREE_ID \
  --source mykey \
  --network testnet \
  -- test_zero_at_level \
  --level 2
```

### Step 3: Compare Results

If the on-chain values **exactly match** the circomlibjs values:
✅ **Poseidon parameters are compatible!**

If they **don't match**:
❌ **CRITICAL ISSUE - Investigate:**
1. Are we using Poseidon vs Poseidon2? (different round constants)
2. Are the round constants identical?
3. Is the MDS matrix the same?
4. Is input ordering consistent? (some implementations reverse inputs)
5. Is the domain separation tag different?

## Zero Leaf Handling

Both implementations must use `0` as the zero leaf:
- **Circomlib**: `zeros[0] = 0`
- **On-chain**: `zero_value() = U256::from_u32(0)`

This is verified by checking that `Poseidon(0, 0)` produces the same result.

## Integration Test

After verifying KAT, run the full integration test:

```bash
cd circuits
# Generate test input (uses circomlibjs)
node utils/generate_input.js

# Inspect the generated commitment
cat test_members.json

# The commitment should match if you compute Poseidon(secret, salt) on-chain
```

## References

- Poseidon Paper: https://eprint.iacr.org/2019/458.pdf
- Circomlib Implementation: https://github.com/iden3/circomlib/blob/master/circuits/poseidon.circom
- Stellar P25 Examples: https://github.com/jayz22/soroban-examples/tree/p25-preview
- BN254 Curve: https://eips.ethereum.org/EIPS/eip-196

## Troubleshooting

### "testutils feature not enabled"
Build the contract with: `--features testutils`

### "Unknown host function"
Your Stellar node doesn't support P25. Use: `stellar container start -t future`

### "Values don't match"
1. Check that both use BN254 field (not BLS12-381 or other curve)
2. Verify circomlib version matches: `npm list circomlib`
3. Check for endianness issues in U256 conversion
4. Verify no domain separation prefix is being added

### "Contract deployment failed"
P25 is not yet mainnet. Use local test network with future protocol.
