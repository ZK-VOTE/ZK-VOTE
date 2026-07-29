#!/usr/bin/env bash
#
# Token Rotation Deployment Script
#
# Rotates authentication tokens as part of deployment process.
# Can be run manually or integrated into CI/CD pipelines.
#
# Usage:
#   ./rotate-tokens.sh [--all|--token-id <id>] [--output <file>]
#
# Environment (backend/.env) must already be loaded or variables set:
#   - DATABASE_PATH (optional: path to SQLite DB)
#
# Outputs new tokens to stdout and optionally to a file.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"
cd "$BACKEND_DIR"

ROTATE_ALL=true
TOKEN_ID=""
OUTPUT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token-id)
      TOKEN_ID="$2"
      ROTATE_ALL=false
      shift 2
      ;;
    --output)
      OUTPUT_FILE="$2"
      shift 2
      ;;
    --all)
      ROTATE_ALL=true
      shift
      ;;
    -h|--help)
      cat <<EOF
Token Rotation Script for ZKVote Relayer

Usage: $0 [OPTIONS]

Options:
  --all               Rotate all eligible tokens (default)
  --token-id <id>     Rotate a specific token by ID only
  --output <file>     Write new tokens to <file> in addition to stdout
  -h, --help          Show this help message

Examples:
  $0 --all --output /tmp/new-tokens.txt
  $0 --token-id tok_abc123

This script should be run from the backend/ directory or with proper paths.
It requires the backend environment to be configured (backend/.env).
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

echo "========================================"
echo "ZKVote - Auth Token Rotation"
echo "========================================"
echo ""

if [ ! -f ".env" ] && [ -z "${AUTH_MASTER_KEY:-}" ]; then
  echo "WARNING: No .env file found and AUTH_MASTER_KEY not set."
  echo "Tokens may not work without proper configuration."
  echo ""
fi

if [ -z "${TOKEN_ID}" ]; then
  echo "Running scheduled token rotation (all eligible tokens)..."
  ROTATE_OUTPUT="$(npx tsx src/token-manager.ts rotate)"
else
  echo "Rotating specific token: ${TOKEN_ID}..."
  ROTATE_OUTPUT="$(npx tsx src/token-manager.ts rotate --tokenId "${TOKEN_ID}")"
fi

ROTATE_EXIT=$?

echo ""
echo "${ROTATE_OUTPUT}"
echo ""

if [ ${ROTATE_EXIT} -ne 0 ]; then
  echo "ERROR: Token rotation command failed with exit code ${ROTATE_EXIT}" >&2
  exit ${ROTATE_EXIT}
fi

if [ -n "${OUTPUT_FILE}" ]; then
  echo "Writing rotation output to: ${OUTPUT_FILE}"
  cat > "${OUTPUT_FILE}" <<EOF
# ZKVote Auth Token Rotation Output
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Script: rotate-tokens.sh

${ROTATE_OUTPUT}
EOF
  echo "Done."
  echo ""
fi

echo "========================================"
echo "NEXT STEPS:"
echo "1. Distribute new tokens to affected clients"
echo "2. Confirm clients are using new tokens"
echo "3. After transition period ($(( (TOKEN_ROTATION_TRANSITION_MS:-172800000) / 86400000 )) days), old tokens will be automatically invalidated"
echo "4. Run 'tsx src/token-manager.ts list' to verify token statuses"
echo "========================================"
echo ""
echo "Rotation completed successfully."
