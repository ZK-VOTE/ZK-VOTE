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

Raw Poseidon(2) zero chain (parameter parity only — not the tree's actual
empty-leaf value, see below):
raw[0] = 0
raw[1] = 14744269619966411208579211824598458697587494354926760081771325075741142829156
raw[2] = 7423237065226347324353380772367382631490014989348495481811164164159255474657
raw[3] = 11286972368698509976183087595462810875513684078608517520839298933882497716792
```

### Domain-Separated Leaf Hashing (#167)

The tree does **not** insert a raw commitment (or `0` for an empty leaf)
directly as a tree value. Every leaf is first hashed with a fixed tag:
`leafHash = Poseidon(LEAF_DOMAIN, leaf)` with `LEAF_DOMAIN = 1`. This closes a
second-preimage hole: without it, an attacker who finds `C1, C2` such that
`Poseidon(C1, C2) == C_target` could register `C1`/`C2` as two members, then
present `C_target` as a forged leaf at a shallower depth — since leaves and
internal-node hashes lived in the same, indistinguishable value space. Every
implementation (`circuits/merkle_tree.circom`, `frontend/src/lib/merkletree.ts`,
`contracts/membership-tree/src/lib.rs`) must use the same `LEAF_DOMAIN` and
apply it identically, or Merkle proofs will silently fail to verify.

Run `node utils/poseidon_kat.js` to regenerate; current values:

```
Merkle Tree Zero Values (domain-separated):
zeros[0] = 18423194802802147121294641945063302532319431080857859605204660473644265519999
zeros[1] = 10095840990547086393948069857778488018173381758268035334446636573002499075634
zeros[2] = 10452537397502567075357414940778164908025902346793051826780339195520977423558
zeros[3] = 6113290778132335551082908708188728940765971492572731501321771724956141922341
```

### Step 2: Verify On-Chain (Stellar P25)

**Prerequisites**: 
- P25-compatible test network running (`stellar container start -t future`)
- Membership-tree contract deployed with `testutils` feature enabled

```bash
# Build with testutils feature
cd contracts/membership-tree
cargo build --release --target wasm32v1-none --features testutils

# Deploy to local test network
stellar contract deploy \
  --wasm target/wasm32v1-none/release/membership_tree.wasm \
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
