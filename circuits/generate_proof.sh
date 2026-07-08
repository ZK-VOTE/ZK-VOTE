#!/bin/bash
set -e

# Generate proof from input.json
# Usage: ./generate_proof.sh [input_file]

INPUT_FILE="${1:-input.json}"

if [ ! -f "$INPUT_FILE" ]; then
    echo "Error: Input file '$INPUT_FILE' not found"
    echo "Usage: ./generate_proof.sh [input_file]"
    exit 1
fi

if [ ! -f "build/vote_final.zkey" ]; then
    echo "Error: Circuit not compiled. Run ./compile.sh first"
    exit 1
fi

echo "=== Generating Vote Proof ==="
echo "Input file: $INPUT_FILE"

# Step 1: Generate witness
echo "1. Generating witness..."
node build/vote_js/generate_witness.js build/vote_js/vote.wasm "$INPUT_FILE" witness.wtns

# Step 2: Generate proof
echo "2. Generating Groth16 proof..."
snarkjs groth16 prove build/vote_final.zkey witness.wtns proof.json public.json

# Step 3: Verify locally
echo "3. Verifying proof locally..."
snarkjs groth16 verify build/verification_key.json public.json proof.json

echo ""
echo "=== Proof Generated Successfully ==="
echo "Files:"
echo "  - proof.json   (Groth16 proof: a, b, c)"
echo "  - public.json  (Public signals: root, nullifier, proposalId, voteChoice)"
echo ""
echo "Public signals:"
cat public.json | jq .
