#!/bin/bash
set -euo pipefail

# Compile bridge circuit for EVM-compatible Groth16 verification
# Outputs: r1cs, wasm, sym, zkey, vkey, Solidity verifier

CIRCUIT_NAME="bridge"
BUILD_DIR="build"

mkdir -p ${BUILD_DIR}

echo "=== Compiling ${CIRCUIT_NAME}.circom ==="
circom ${CIRCUIT_NAME}.circom \
    --r1cs \
    --wasm \
    --sym \
    -o ${BUILD_DIR}

SNARKJS="npx snarkjs"

echo "=== Circuit constraints ==="
${SNARKJS} r1cs info ${BUILD_DIR}/${CIRCUIT_NAME}.r1cs

echo "=== Trusted setup (Groth16) ==="
# Phase 1: Powers of Tau (use existing pot or generate new one)
PTAU_FILE="pot15_final.ptau"
if [ ! -f "${PTAU_FILE}" ]; then
    echo "Generating powers of tau..."
    ${SNARKJS} powersoftau new bn128 15 ${BUILD_DIR}/pot15_0000.ptau -v
    ${SNARKJS} powersoftau contribute ${BUILD_DIR}/pot15_0000.ptau \
        ${BUILD_DIR}/pot15_0001.ptau \
        --name="Phase 1 contribution" -v -e="random entropy"
    ${SNARKJS} powersoftau prepare phase2 \
        ${BUILD_DIR}/pot15_0001.ptau ${BUILD_DIR}/${PTAU_FILE} -v
else
    echo "Using existing ${PTAU_FILE}"
    cp ${PTAU_FILE} ${BUILD_DIR}/${PTAU_FILE}
fi

# Phase 2: Circuit-specific setup
echo "=== Phase 2 setup ==="
${SNARKJS} groth16 setup \
    ${BUILD_DIR}/${CIRCUIT_NAME}.r1cs \
    ${BUILD_DIR}/${PTAU_FILE} \
    ${BUILD_DIR}/${CIRCUIT_NAME}_0000.zkey

${SNARKJS} zkey contribute \
    ${BUILD_DIR}/${CIRCUIT_NAME}_0000.zkey \
    ${BUILD_DIR}/${CIRCUIT_NAME}_final.zkey \
    --name="ZKVote Bridge Phase 2" -v -e="random entropy"

${SNARKJS} zkey beacon \
    ${BUILD_DIR}/${CIRCUIT_NAME}_final.zkey \
    ${BUILD_DIR}/${CIRCUIT_NAME}_final.zkey \
    0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20 10

# Export verification key
echo "=== Exporting verification key ==="
${SNARKJS} zkey export verificationkey \
    ${BUILD_DIR}/${CIRCUIT_NAME}_final.zkey \
    ${BUILD_DIR}/verification_key.json

# Export Solidity verifier for EVM
echo "=== Exporting Solidity verifier ==="
${SNARKJS} zkey export solidityverifier \
    ${BUILD_DIR}/${CIRCUIT_NAME}_final.zkey \
    ${BUILD_DIR}/Verifier.sol

# Install into Hardhat contracts so production deploy can find it (#650)
EVM_CONTRACTS_DIR="../contracts/bridge/evm/contracts"
if [ -d "${EVM_CONTRACTS_DIR}" ]; then
    cp "${BUILD_DIR}/Verifier.sol" "${EVM_CONTRACTS_DIR}/Verifier.sol"
    echo "Installed Verifier.sol -> ${EVM_CONTRACTS_DIR}/Verifier.sol"
fi

# Generate proof instance for testing
echo "=== Done ==="
echo "Build artifacts in ${BUILD_DIR}/:"
echo "  ${CIRCUIT_NAME}.r1cs         - R1CS constraint system"
echo "  ${CIRCUIT_NAME}_js/          - WASM witness generator"
echo "  ${CIRCUIT_NAME}_final.zkey   - Proving key"
echo "  verification_key.json        - Verification key"
echo "  Verifier.sol                 - Solidity verifier contract (9 public signals)"
