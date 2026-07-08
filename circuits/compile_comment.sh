#!/bin/bash
set -e

echo "=== DaoVote Comment Circuit Compilation ==="

# Create build directory for comment circuit
mkdir -p build/comment

# Step 1: Compile circuit
echo "1. Compiling comment circuit..."
circom comment.circom --r1cs --wasm --sym -o build/comment -l node_modules

# Step 2: Check Powers of Tau
if [ ! -f "pot14_final.ptau" ]; then
    echo "2. Downloading Powers of Tau ceremony file..."
    wget https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_14.ptau -O pot14_final.ptau
else
    echo "2. Powers of Tau file already exists"
fi

# Step 3: Generate zkey
echo "3. Generating zkey (trusted setup)..."
snarkjs groth16 setup build/comment/comment.r1cs pot14_final.ptau build/comment/comment_0000.zkey

# Step 4: Contribute to ceremony
echo "4. Contributing to ceremony..."
echo "DaoVote Comment Circuit Phase 1" | snarkjs zkey contribute build/comment/comment_0000.zkey build/comment/comment_final.zkey --name="DaoVote Comment Phase 1" -v

# Step 5: Export verification key
echo "5. Exporting verification key..."
snarkjs zkey export verificationkey build/comment/comment_final.zkey build/comment/verification_key.json

echo ""
echo "=== Comment Circuit Compilation Complete ==="
echo "Files generated:"
echo "  - build/comment/comment.r1cs              (constraint system)"
echo "  - build/comment/comment.sym               (symbol file)"
echo "  - build/comment/comment_js/               (WASM prover)"
echo "  - build/comment/comment_final.zkey        (proving key)"
echo "  - build/comment/verification_key.json     (verification key for on-chain)"
echo ""
echo "Next: Convert verification key to Soroban format"
