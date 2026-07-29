#!/usr/bin/env bash
# ==============================================================================
# Circuit Artifact PGP Signing Script
# Signs circuits/checksums.sha256 with project PGP key.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CIRCUITS_DIR="$REPO_ROOT/circuits"

CHECKSUM_FILE="$CIRCUITS_DIR/checksums.sha256"
SIG_FILE="$CIRCUITS_DIR/checksums.sha256.sig"

echo "=== ZKVote Circuit Artifact PGP Signing ==="

if [ ! -f "$CHECKSUM_FILE" ]; then
    echo "ERROR: Checksum file not found at $CHECKSUM_FILE."
    echo "Please run compile-circuits.sh first."
    exit 1
fi

if ! command -v gpg &> /dev/null; then
    echo "ERROR: 'gpg' command is not installed."
    exit 1
fi

PGP_KEY_ID="${PGP_KEY_ID:-}"

echo "Signing $CHECKSUM_FILE..."

if [ -n "$PGP_KEY_ID" ]; then
    gpg --batch --yes --detach-sign --armor --local-user "$PGP_KEY_ID" --output "$SIG_FILE" "$CHECKSUM_FILE"
else
    gpg --batch --yes --detach-sign --armor --output "$SIG_FILE" "$CHECKSUM_FILE" 2>/dev/null || \
    gpg --detach-sign --armor --output "$SIG_FILE" "$CHECKSUM_FILE"
fi

echo "✓ PGP signature generated at: $SIG_FILE"
