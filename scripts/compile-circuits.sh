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
# Merkle depths to compile alongside the default depth-18 vote.circom (#93).
# Each depth is a separate circuit because circom fixes `component main` at
# compile time; see circuits/utils/gen_depth_circuits.js.
DEPTHS="10 15 20 25"

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
        --depths=*)
            DEPTHS="$(echo "${arg#*=}" | tr ',' ' ')"
            shift
            ;;
        --no-depths)
            DEPTHS=""
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--docker] [--sign] [--depths=10,15,20,25 | --no-depths]"
            echo ""
            echo "Options:"
            echo "  --docker         Use Docker container for reproducible build"
            echo "  --sign           Sign generated checksums with PGP key"
            echo "  --depths=LIST    Merkle depths to compile (default: 10,15,20,25)"
            echo "  --no-depths      Compile only the default depth-18 vote.circom"
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

    # Regenerate the per-depth wrappers so a stale committed file can never be
    # what gets compiled, then build each depth into its own directory.
    if [ -n "$DEPTHS" ]; then
        node utils/gen_depth_circuits.js $DEPTHS
        for depth in $DEPTHS; do
            echo "Compiling vote_d${depth}.circom (Merkle depth $depth)..."
            mkdir -p "build/depth_${depth}"
            circom "vote_d${depth}.circom" --r1cs --wasm --sym \
                -o "build/depth_${depth}" -l node_modules
        done
    fi
fi

# Verification key derivation.
#
# The proving key is an MPC ceremony artifact, so it is not rebuilt here. What
# this script MUST do is prove that the key on disk belongs to the r1cs that was
# just compiled.
#
# It previously exported the vkey from whatever `vote_final.zkey` it happened to
# find in circuits/ or frontend/public/circuits/, with no check at all. A zkey
# left over from an older circuit therefore produced a "fresh" verification key
# whose public-signal count had nothing to do with the current source. That is
# how a 5-signal vkey survived a 6-signal circuit and shipped: `validate_vk`
# rejects any key whose IC length is not NUM_PUBLIC_SIGNALS + 1, so the key
# could never be registered and every anonymous vote was unverifiable — while
# the Rust tests stayed green, because they build synthetic keys from the
# contract's own constant instead of using this artifact.
ZKEY_FILE="$CIRCUITS_DIR/vote_final.zkey"
if [ ! -f "$ZKEY_FILE" ]; then
    ZKEY_FILE="$REPO_ROOT/frontend/public/circuits/vote_final.zkey"
fi

R1CS_FILE="$BUILD_DIR/vote.r1cs"

if [ -f "$ZKEY_FILE" ] && command -v snarkjs &> /dev/null; then
    if [ ! -f "$R1CS_FILE" ]; then
        echo "ERROR: $R1CS_FILE is missing; refusing to export a verification key."
        echo "       Re-run without Docker, or build the r1cs first."
        exit 1
    fi

    echo "Verifying that $ZKEY_FILE was produced from $R1CS_FILE..."
    if ! snarkjs zkey verify "$R1CS_FILE" "$ZKEY_FILE" > /dev/null 2>&1; then
        echo "ERROR: the proving key does not match the freshly compiled circuit."
        echo ""
        echo "  zkey: $ZKEY_FILE"
        echo "  r1cs: $R1CS_FILE"
        echo ""
        echo "The circuit source changed in a way that requires a new trusted setup"
        echo "(or the zkey on disk is stale). Exporting a verification key here would"
        echo "produce a key with the wrong number of public signals, which no"
        echo "contract can register. Refusing."
        echo ""
        echo "To rebuild, run the ceremony:"
        echo "  npm run setup --prefix circuits   # groth16 setup"
        echo "  npm run contribute --prefix circuits"
        exit 1
    fi

    echo "Exporting verification key from zkey..."
    snarkjs zkey export verificationkey "$ZKEY_FILE" "$BUILD_DIR/verification_key.json"

    # Independent cross-check: the IC vector of a Groth16 vkey has exactly
    # (public inputs + 1) elements. Assert it against the r1cs we compiled, so
    # even a zkey that passes `zkey verify` against a wrong-looking r1cs cannot
    # slip a mismatched key into frontend/public/circuits/.
    R1CS_NPUB="$(snarkjs r1cs info "$R1CS_FILE" 2>/dev/null \
        | sed -n 's/.*# of Public Inputs: *\([0-9]\+\).*/\1/p')"
    VK_NPUB="$(node -e '
        const fs = require("fs");
        try {
            const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
            process.stdout.write(String(v.nPublic));
        } catch (e) { process.stdout.write(""); }
    ' "$BUILD_DIR/verification_key.json")"

    if [ -n "$R1CS_NPUB" ] && [ -n "$VK_NPUB" ] && [ "$R1CS_NPUB" != "$VK_NPUB" ]; then
        echo "ERROR: exported verification key has nPublic=$VK_NPUB but the compiled"
        echo "       r1cs has $R1CS_NPUB public inputs. Refusing to publish it."
        exit 1
    fi
    echo "  public inputs: $VK_NPUB (matches the compiled r1cs)"

    if [ -f "$CIRCUITS_DIR/convert_vkey_to_soroban_be.js" ]; then
        node "$CIRCUITS_DIR/convert_vkey_to_soroban_be.js" "$BUILD_DIR/verification_key.json" > "$BUILD_DIR/verification_key_soroban.json" || true
    fi
elif [ -f "$ZKEY_FILE" ]; then
    echo "WARNING: snarkjs not found; skipping verification key export."
    echo "         $ZKEY_FILE was NOT checked against the compiled r1cs."
else
    echo "NOTE: no vote_final.zkey found; compiled r1cs/wasm only."
    echo "      Run the trusted setup before a verification key is needed."
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
for depth in $DEPTHS; do
    if [ -f "build/depth_${depth}/vote_d${depth}.r1cs" ]; then
        TRACKED_ARTIFACTS+=("build/depth_${depth}/vote_d${depth}.r1cs")
    fi
    if [ -f "build/depth_${depth}/vote_d${depth}_js/vote_d${depth}.wasm" ]; then
        TRACKED_ARTIFACTS+=("build/depth_${depth}/vote_d${depth}_js/vote_d${depth}.wasm")
    fi
done

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
