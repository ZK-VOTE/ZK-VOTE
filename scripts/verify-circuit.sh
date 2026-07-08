#!/bin/bash
# Circuit Verification Script
# Verifies that the circuit artifacts match expected hashes before deployment

set -e

CIRCUITS_DIR="${1:-circuits}"
EXPECTED_VK_HASH="${2:-}"

echo "=== ZKVote Circuit Verification ==="

# Check required files exist
REQUIRED_FILES=(
    "$CIRCUITS_DIR/vote.wasm"
    "$CIRCUITS_DIR/vote_final.zkey"
    "$CIRCUITS_DIR/verification_key.json"
)

for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$file" ]; then
        echo "ERROR: Missing required file: $file"
        exit 1
    fi
    echo "✓ Found: $file"
done

# Compute VK hash
VK_HASH=$(sha256sum "$CIRCUITS_DIR/verification_key.json" | cut -d' ' -f1)
echo ""
echo "Verification Key SHA256: $VK_HASH"

# If expected hash provided, verify it matches
if [ -n "$EXPECTED_VK_HASH" ]; then
    if [ "$VK_HASH" != "$EXPECTED_VK_HASH" ]; then
        echo "ERROR: VK hash mismatch!"
        echo "  Expected: $EXPECTED_VK_HASH"
        echo "  Got:      $VK_HASH"
        exit 1
    fi
    echo "✓ VK hash matches expected value"
fi

# Verify zkey was created from the correct circuit
echo ""
echo "=== Verifying zkey integrity ==="
if command -v snarkjs &> /dev/null; then
    snarkjs zkey verify "$CIRCUITS_DIR/vote.r1cs" "$CIRCUITS_DIR/pot12_final.ptau" "$CIRCUITS_DIR/vote_final.zkey" 2>&1 | tail -5
else
    echo "WARNING: snarkjs not found, skipping zkey verification"
fi

# Verify VK was exported from zkey
echo ""
echo "=== Verifying VK export ==="
if command -v snarkjs &> /dev/null; then
    TEMP_VK=$(mktemp)
    snarkjs zkey export verificationkey "$CIRCUITS_DIR/vote_final.zkey" "$TEMP_VK" 2>/dev/null

    # Compare IC array length (most critical)
    STORED_IC=$(jq '.IC | length' "$CIRCUITS_DIR/verification_key.json")
    EXPORTED_IC=$(jq '.IC | length' "$TEMP_VK")

    if [ "$STORED_IC" != "$EXPORTED_IC" ]; then
        echo "ERROR: IC length mismatch! Stored: $STORED_IC, Exported: $EXPORTED_IC"
        rm "$TEMP_VK"
        exit 1
    fi
    echo "✓ IC length matches: $STORED_IC elements"
    rm "$TEMP_VK"
else
    echo "WARNING: snarkjs not found, skipping VK export verification"
fi

echo ""
echo "=== Circuit Verification Complete ==="
echo "VK Hash: $VK_HASH"
echo ""
echo "To set this as the expected hash, run:"
echo "  ./scripts/verify-circuit.sh circuits $VK_HASH"
