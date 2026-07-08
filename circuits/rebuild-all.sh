#!/bin/bash
# Complete rebuild of circuit, keys, and test data
set -e

echo "========================================="
echo "DaoVote Complete Circuit Rebuild"
echo "========================================="
echo ""

# Step 1: Clean old artifacts
echo "Step 1: Cleaning old build artifacts..."
rm -rf build/
mkdir -p build

# Step 2: Compile circuit and generate keys
echo ""
echo "Step 2: Compiling circuit and generating keys..."
./compile.sh

# Step 3: Convert verification key to Soroban format
echo ""
echo "Step 3: Converting verification key to Soroban format..."
node convert_vkey_to_soroban_le.js

# Step 4: Generate fresh test data
echo ""
echo "Step 4: Generating fresh test data..."
node gen-fresh-proof.js

# Read the test data
TEST_DATA=$(cat /tmp/fresh-test-data.json)
SECRET=$(echo "$TEST_DATA" | grep -o '"secret":"[^"]*"' | cut -d'"' -f4)
SALT=$(echo "$TEST_DATA" | grep -o '"salt":"[^"]*"' | cut -d'"' -f4)
COMMITMENT=$(echo "$TEST_DATA" | grep -o '"commitment":"[^"]*"' | cut -d'"' -f4)
NULLIFIER=$(echo "$TEST_DATA" | grep -o '"nullifier":"[^"]*"' | cut -d'"' -f4)
ROOT=$(echo "$TEST_DATA" | grep -o '"root":"[^"]*"' | cut -d'"' -f4)

echo ""
echo "Fresh test credentials:"
echo "  Secret: $SECRET"
echo "  Salt: $SALT"
echo "  Commitment: $COMMITMENT"
echo "  Nullifier: $NULLIFIER"
echo "  Expected Root: $ROOT"

# Step 5: Create circuit input for proof generation
echo ""
echo "Step 5: Creating circuit input..."
cat > build/test_input.json << INPUTEOF
{
  "root": "$ROOT",
  "nullifier": "$NULLIFIER",
  "daoId": "1",
  "proposalId": "1",
  "voteChoice": "1",
  "secret": "$SECRET",
  "salt": "$SALT",
  "pathElements": $(echo "$TEST_DATA" | grep -o '"pathElements":\[[^]]*\]'),
  "pathIndices": $(echo "$TEST_DATA" | grep -o '"pathIndices":\[[^]]*\]')
}
INPUTEOF

echo "Circuit input saved to build/test_input.json"

# Step 6: Generate proof
echo ""
echo "Step 6: Generating test proof (this may take 10-30 seconds)..."
node build/vote_js/generate_witness.js build/vote_js/vote.wasm build/test_input.json build/witness.wtns

snarkjs groth16 prove build/vote_final.zkey build/witness.wtns build/proof.json build/public.json

echo "Proof generated!"

# Step 7: Convert proof to Soroban format
echo ""
echo "Step 7: Converting proof to Soroban format..."
node convert_proof_to_soroban_le.js build/proof.json > build/proof_soroban.json

echo ""
echo "========================================="
echo "✅ Rebuild Complete!"
echo "========================================="
echo ""
echo "Generated files:"
echo "  - build/vote_final.zkey          (proving key)"
echo "  - build/verification_key.json    (verification key - snarkjs format)"
echo "  - build/verification_key_soroban.json  (VK for Soroban)"
echo "  - build/proof.json               (test proof - snarkjs format)"
echo "  - build/proof_soroban.json       (test proof - Soroban format)"
echo "  - build/test_input.json          (circuit input)"
echo ""
echo "Next steps:"
echo "  1. Copy build/vote_final.zkey to frontend/public/circuits/"
echo "  2. Copy build/vote_js/vote.wasm to frontend/public/circuits/"
echo "  3. Deploy VK to contract using scripts/set-vk.sh"
echo "  4. Test voting with fresh credentials"
echo ""
