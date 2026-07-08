#!/bin/bash
set -e

echo "=== DaoVote Circuit Compilation ==="

# Create build directory
mkdir -p build

# Step 1: Compile circuit
echo "1. Compiling circuit..."
circom vote.circom --r1cs --wasm --sym -o build -l node_modules

# Step 2: Download Powers of Tau (if not exists)
if [ ! -f "pot14_final.ptau" ]; then
    echo "2. Downloading Powers of Tau ceremony file..."
    # Circuit uses ~3.5K constraints (Poseidon hashes for Merkle proof + nullifier)
    # pot14 (2^14 = 16,384 constraints) is sufficient
    wget https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_14.ptau -O pot14_final.ptau
else
    echo "2. Powers of Tau file already exists"
fi

# Step 3: Generate zkey
echo "3. Generating zkey (trusted setup)..."
snarkjs groth16 setup build/vote.r1cs pot14_final.ptau build/vote_0000.zkey

# Step 4: Contribute to ceremony (in production, multiple parties would do this)
echo "4. Contributing to ceremony..."
echo "DaoVote Phase 1 Contribution" | snarkjs zkey contribute build/vote_0000.zkey build/vote_final.zkey --name="DaoVote Phase 1" -v

# Step 5: Export verification key
echo "5. Exporting verification key..."
snarkjs zkey export verificationkey build/vote_final.zkey build/verification_key.json

# Step 6: Generate Solidity verifier (for reference)
echo "6. Generating Solidity verifier..."
snarkjs zkey export solidityverifier build/vote_final.zkey build/verifier.sol

echo ""
echo "=== Compilation Complete ==="
echo "Files generated:"
echo "  - build/vote.r1cs          (constraint system)"
echo "  - build/vote.sym           (symbol file)"
echo "  - build/vote_js/           (WASM prover)"
echo "  - build/vote_final.zkey    (proving key)"
echo "  - build/verification_key.json  (verification key for on-chain)"
echo ""
echo "Verification key needs to be converted to Soroban format for on-chain verification"
