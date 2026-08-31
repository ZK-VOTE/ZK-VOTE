#!/usr/bin/env bash
# ============================================
# Backup Encryption Key Rotation Script
#
# Manages the relay DB backup encryption key (Issue #359):
#   - generate:  create a fresh backup encryption key
#   - rotate:    archive the current key and issue a new one
#   - status:    show encryption status
#   - restore-test: run an encrypted restore drill against a snapshot
#
# Usage:
#   ./scripts/rotate-backup-key.sh generate [--output <file>]
#   ./scripts/rotate-backup-key.sh rotate   [--output <file>]
#   ./scripts/rotate-backup-key.sh status
#   ./scripts/rotate-backup-key.sh restore-test --input <enc.db>
#   ./scripts/rotate-backup-key.sh help
#
# Environment:
#   BACKEND_DIR   Path to backend directory (default: ./backend)
#
# See docs/ENCRYPTED_BACKUPS.md for the full runbook.
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="${BACKEND_DIR:-$PROJECT_ROOT/backend}"

if [ ! -d "$BACKEND_DIR" ]; then
    echo "Error: Backend directory not found: $BACKEND_DIR"
    echo "Set BACKEND_DIR environment variable or run from project root."
    exit 1
fi

if [ -f "$BACKEND_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$BACKEND_DIR/.env"
    set +a
fi

usage() {
    cat <<EOF
Backup Encryption Key Management Script for ZKVote

Usage: $(basename "$0") <command> [options]

Commands:
  generate [--output <file>]   Create a new backup encryption key
  rotate   [--output <file>]   Archive current key and issue a new one
  status                       Show backup encryption status
  restore-test --input <enc.db> Run an encrypted restore drill
  help                         Show this help message

Examples:
  $(basename "$0") generate --output data/backup-keys/current.key
  $(basename "$0") rotate
EOF
}

COMMAND="${1:-help}"
shift 2>/dev/null || true

cd "$BACKEND_DIR"
npx tsx "$BACKEND_DIR/src/backup-key-manager.ts" "$COMMAND" "$@"