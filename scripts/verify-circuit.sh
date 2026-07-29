#!/usr/bin/env bash
# ==============================================================================
# Circuit Verification Script (Compatibility Wrapper)
# Delegates to verify-circuits.sh for complete artifact verification.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/verify-circuits.sh" "$@"
