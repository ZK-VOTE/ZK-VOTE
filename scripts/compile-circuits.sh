#!/usr/bin/env bash
# ==============================================================================
# Deterministic Circuit Compilation Script
# Pins Circom version and compiles ZK-VOTE circom circuits (vote.circom).
# Supports local compilation or Docker-based reproducible builds.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CIRCUITS_DIR="$REPO_ROOT/circuits"
BUILD_DIR="$CIRCUITS_DIR/build"

# Read pinned version
VERSION_FILE="$REPO_ROOT/.circomversion"
if [ ! -f "$VERSION_FILE" ]; then
    VERSION_FILE="$CIRCUITS_DIR/.circomversion"
fi

PINNED_VERSION="2.1.8"
if [ -f "$VERSION_FILE" ]; then
    PINNED_VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
fi

USE_DOCKER=false
SIGN_ARTIFACTS=false

for arg in "$@"; do
    case $arg in
        --docker)
            USE_DOCKER=true
            shift
            ;;
        --sign)
            SIGN_ARTIFACTS=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--docker] [--sign]"
            echo ""
            echo "Options:"
            echo "  --docker  Use Docker container for reproducible build"
            echo "  --sign    Sign generated checksums with PGP key"
            exit 0
            ;;
    esac
done

echo "=== ZKVote Deterministic Circuit Compilation ==="
echo "Target Circom Version: $PINNED_VERSION"
echo ""

mkdir -p "$BUILD_DIR"

if [ "$USE_DOCKER" = true ]; then
    echo "Running Docker-based compilation..."
    if ! command -v docker &> /dev/null; then
        echo "ERROR: docker command not found. Please install Docker or run without --docker."
        exit 1
    fi

    echo "Building Docker compiler image..."
    docker build \
        --build-arg CIRCOM_VERSION="$PINNED_VERSION" \
        -t zkvote-circuit-builder:v"$PINNED_VERSION" \
        -f "$CIRCUITS_DIR/Dockerfile" \
        "$CIRCUITS_DIR"

    echo "Executing compilation in container..."
    docker run --rm \
        -v "$BUILD_DIR:/app/circuits/build" \
        zkvote-circuit-builder:v"$PINNED_VERSION"
else
    echo "Running local compilation..."
    if ! command -v circom &> /dev/null; then
        echo "ERROR: 'circom' is not installed."
        echo "Required version: $PINNED_VERSION"
        echo "To run via Docker instead: $0 --docker"
        exit 1
    fi

    INSTALLED_VERSION="$(circom --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo 'unknown')"
    echo "Detected local Circom version: $INSTALLED_VERSION"

    if [ "$INSTALLED_VERSION" != "$PINNED_VERSION" ]; then
        echo "WARNING: Local Circom version ($INSTALLED_VERSION) does not match pinned version ($PINNED_VERSION)."
        echo "For reproducible builds, please install Circom $PINNED_VERSION or run: $0 --docker"
    fi

    cd "$CIRCUITS_DIR"
    if [ ! -d "node_modules" ]; then
        echo "Installing node dependencies in circuits..."
        npm ci
    fi

    echo "Compiling vote.circom..."
    circom vote.circom --r1cs --wasm --sym -o build -l node_modules
fi

# Ensure verification key derivation if zkey exists
ZKEY_FILE="$CIRCUITS_DIR/vote_final.zkey"
if [ ! -f "$ZKEY_FILE" ]; then
    ZKEY_FILE="$REPO_ROOT/frontend/public/circuits/vote_final.zkey"
fi

if [ -f "$ZKEY_FILE" ] && command -v snarkjs &> /dev/null; then
    echo "Exporting verification key from zkey..."
    snarkjs zkey export verificationkey "$ZKEY_FILE" "$BUILD_DIR/verification_key.json"
    if [ -f "$CIRCUITS_DIR/convert_vkey_to_soroban_be.js" ]; then
        node "$CIRCUITS_DIR/convert_vkey_to_soroban_be.js" "$BUILD_DIR/verification_key.json" > "$BUILD_DIR/verification_key_soroban.json" || true
    fi
fi

# Generate SHA-256 checksums
echo ""
echo "=== Generating Artifact SHA-256 Checksums ==="
CHECKSUM_FILE="$CIRCUITS_DIR/checksums.sha256"
BUILD_CHECKSUM_FILE="$BUILD_DIR/checksums.sha256"

cd "$CIRCUITS_DIR"

TRACKED_ARTIFACTS=()
if [ -f "build/vote.r1cs" ]; then TRACKED_ARTIFACTS+=("build/vote.r1cs"); fi
if [ -f "build/vote_js/vote.wasm" ]; then TRACKED_ARTIFACTS+=("build/vote_js/vote.wasm"); fi
if [ -f "build/verification_key.json" ]; then TRACKED_ARTIFACTS+=("build/verification_key.json"); fi
if [ -f "build/verification_key_soroban.json" ]; then TRACKED_ARTIFACTS+=("build/verification_key_soroban.json"); fi

if [ ${#TRACKED_ARTIFACTS[@]} -gt 0 ]; then
    sha256sum "${TRACKED_ARTIFACTS[@]}" > "$CHECKSUM_FILE"
    cp "$CHECKSUM_FILE" "$BUILD_CHECKSUM_FILE"
    echo "Checksums published to: $CHECKSUM_FILE"
    cat "$CHECKSUM_FILE"
else
    echo "WARNING: No compiled artifacts found in build/ to compute checksums."
fi

if [ "$SIGN_ARTIFACTS" = true ]; then
    if [ -f "$SCRIPT_DIR/sign-circuits.sh" ]; then
        echo "Signing checksums with PGP key..."
        "$SCRIPT_DIR/sign-circuits.sh"
    else
        echo "WARNING: sign-circuits.sh script not found."
    fi
fi

echo ""
echo "=== Compilation Complete ==="
