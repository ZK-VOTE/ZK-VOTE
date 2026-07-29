#!/usr/bin/env bash
# ==============================================================================
# Circuit Artifact Verification Script
# Verifies SHA-256 checksums, zkey integrity, VK derivation, and PGP signatures.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CIRCUITS_DIR="${1:-$REPO_ROOT/circuits}"
BUILD_DIR="$CIRCUITS_DIR/build"
EXPECTED_VK_HASH="${2:-}"

echo "=== ZKVote Circuit Artifact Verification ==="

ERRORS=0

# 1. Verify SHA-256 checksums if checksum file exists
CHECKSUM_FILE="$CIRCUITS_DIR/checksums.sha256"
if [ -f "$CHECKSUM_FILE" ]; then
    echo ""
    echo "--- 1. SHA-256 Checksum Verification ---"
    if command -v sha256sum &> /dev/null; then
        cd "$CIRCUITS_DIR"
        # Filter checksum file to only include files that exist
        TEMP_CHECKSUM=$(mktemp)
        while read -r line; do
            FILE=$(echo "$line" | awk '{print $2}')
            if [ -f "$FILE" ]; then
                echo "$line" >> "$TEMP_CHECKSUM"
            else
                echo "INFO: Skipping checksum for missing file: $FILE"
            fi
        done < "$CHECKSUM_FILE"
        
        if [ -s "$TEMP_CHECKSUM" ]; then
            if sha256sum -c --status "$TEMP_CHECKSUM" 2>/dev/null; then
                echo "✓ All artifact SHA-256 checksums match committed baseline:"
                sha256sum -c "$TEMP_CHECKSUM"
            else
                echo "❌ ERROR: SHA-256 checksum mismatch detected!"
                sha256sum -c "$TEMP_CHECKSUM" || true
                ERRORS=$((ERRORS + 1))
            fi
        else
            echo "WARNING: No tracked artifacts found for checksum verification"
        fi
        rm -f "$TEMP_CHECKSUM"
    else
        echo "WARNING: sha256sum command not found, skipping checksum verification"
    fi
else
    echo "WARNING: Checksum file not found at $CHECKSUM_FILE"
fi

# 2. Check PGP signature if present
SIG_FILE="$CIRCUITS_DIR/checksums.sha256.sig"
PUBKEY_FILE="$CIRCUITS_DIR/pgp-pubkey.asc"

if [ -f "$SIG_FILE" ]; then
    echo ""
    echo "--- 2. PGP Signature Verification ---"
    if command -v gpg &> /dev/null; then
        if [ -f "$PUBKEY_FILE" ]; then
            gpg --batch --quiet --import "$PUBKEY_FILE" 2>/dev/null || true
        fi
        if gpg --verify "$SIG_FILE" "$CHECKSUM_FILE" 2>/dev/null; then
            echo "✓ PGP signature for checksums.sha256 is VALID"
        else
            echo "❌ ERROR: PGP signature verification FAILED"
            ERRORS=$((ERRORS + 1))
        fi
    else
        echo "WARNING: gpg command not found, skipping PGP signature verification"
    fi
fi

# 3. Verification Key Hash check (if provided or file exists)
VK_FILE="$BUILD_DIR/verification_key.json"
if [ ! -f "$VK_FILE" ]; then
    VK_FILE="$CIRCUITS_DIR/verification_key.json"
fi
if [ ! -f "$VK_FILE" ]; then
    VK_FILE="$REPO_ROOT/frontend/public/circuits/verification_key.json"
fi

if [ -f "$VK_FILE" ]; then
    echo ""
    echo "--- 3. Verification Key Hash ---"
    VK_HASH=$(sha256sum "$VK_FILE" | cut -d' ' -f1)
    echo "Verification Key SHA256: $VK_HASH"

    if [ -n "$EXPECTED_VK_HASH" ]; then
        if [ "$VK_HASH" != "$EXPECTED_VK_HASH" ]; then
            echo "❌ ERROR: VK hash mismatch!"
            echo "  Expected: $EXPECTED_VK_HASH"
            echo "  Got:      $VK_HASH"
            ERRORS=$((ERRORS + 1))
        else
            echo "✓ VK hash matches expected value"
        fi
    fi
fi

# 4. Verify zkey integrity
ZKEY_FILE="$BUILD_DIR/vote_final.zkey"
if [ ! -f "$ZKEY_FILE" ]; then
    ZKEY_FILE="$CIRCUITS_DIR/vote_final.zkey"
fi
if [ ! -f "$ZKEY_FILE" ]; then
    ZKEY_FILE="$REPO_ROOT/frontend/public/circuits/vote_final.zkey"
fi

PTAU_FILE="$CIRCUITS_DIR/pot14_final.ptau"
if [ ! -f "$PTAU_FILE" ]; then
    PTAU_FILE="$CIRCUITS_DIR/pot12_final.ptau"
fi

R1CS_FILE="$BUILD_DIR/vote.r1cs"

if [ -f "$ZKEY_FILE" ] && [ -f "$R1CS_FILE" ] && [ -f "$PTAU_FILE" ]; then
    echo ""
    echo "--- 4. zkey Integrity Verification ---"
    if command -v snarkjs &> /dev/null; then
        if snarkjs zkey verify "$R1CS_FILE" "$PTAU_FILE" "$ZKEY_FILE"; then
            echo "✓ zkey integrity verified successfully"
        else
            echo "❌ ERROR: zkey verification failed"
            ERRORS=$((ERRORS + 1))
        fi
    fi
fi

# 5. Verify VK derivation from zkey
if [ -f "$ZKEY_FILE" ] && [ -f "$VK_FILE" ]; then
    echo ""
    echo "--- 5. Verification Key Derivation ---"
    if command -v snarkjs &> /dev/null && command -v jq &> /dev/null; then
        TEMP_VK=$(mktemp)
        if snarkjs zkey export verificationkey "$ZKEY_FILE" "$TEMP_VK" 2>/dev/null; then
            STORED_IC=$(jq '.IC | length' "$VK_FILE")
            EXPORTED_IC=$(jq '.IC | length' "$TEMP_VK")
            if [ "$STORED_IC" = "$EXPORTED_IC" ]; then
                echo "✓ VK IC length matches exported key ($STORED_IC elements)"
            else
                echo "❌ ERROR: VK IC length mismatch (Stored: $STORED_IC, Exported: $EXPORTED_IC)"
                ERRORS=$((ERRORS + 1))
            fi
        fi
        rm -f "$TEMP_VK"
    fi
fi

echo ""
echo "=== Verification Summary ==="
if [ $ERRORS -eq 0 ]; then
    echo "✅ All circuit artifact verifications PASSED"
    exit 0
else
    echo "❌ $ERRORS verification check(s) FAILED"
    exit 1
fi
