#!/usr/bin/env bash
# Preflight check: verify that the installed Node, npm, and Rust toolchain
# versions match the pinned values in .nvmrc, backend/package.json, and
# rust-toolchain.toml before any install or build runs.
#
# Exit 0 → all checks pass.
# Exit 1 → at least one mismatch; the failing check is printed to stderr.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAIL=0

# ── Node ─────────────────────────────────────────────────────────────────────
REQUIRED_NODE="$(cat "${REPO_ROOT}/.nvmrc" | tr -d '[:space:]')"
ACTUAL_NODE="$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1 || echo 'missing')"

if [[ "${ACTUAL_NODE}" != "${REQUIRED_NODE}" ]]; then
  echo "❌  Node: required=${REQUIRED_NODE}, installed=${ACTUAL_NODE}" >&2
  echo "    Run: nvm use  (or install Node ${REQUIRED_NODE})" >&2
  FAIL=1
else
  echo "✓  Node ${ACTUAL_NODE}"
fi

# ── npm ──────────────────────────────────────────────────────────────────────
REQUIRED_NPM="$(node -pe "require('${REPO_ROOT}/backend/package.json').packageManager" 2>/dev/null | sed 's/npm@//' | cut -d. -f1 || echo 'missing')"
ACTUAL_NPM="$(npm --version 2>/dev/null | cut -d. -f1 || echo 'missing')"

if [[ -n "${REQUIRED_NPM}" && "${ACTUAL_NPM}" != "${REQUIRED_NPM}" ]]; then
  echo "❌  npm: required=${REQUIRED_NPM}.x, installed=${ACTUAL_NPM}.x" >&2
  echo "    Run: corepack enable && corepack prepare npm@${REQUIRED_NPM} --activate" >&2
  FAIL=1
else
  echo "✓  npm ${ACTUAL_NPM}"
fi

# ── Rust ─────────────────────────────────────────────────────────────────────
REQUIRED_RUST="$(grep '^channel' "${REPO_ROOT}/rust-toolchain.toml" | sed 's/.*= *"\(.*\)"/\1/' || echo 'missing')"
ACTUAL_RUST="$(rustc --version 2>/dev/null | awk '{print $2}' || echo 'missing')"

if [[ "${ACTUAL_RUST}" != "${REQUIRED_RUST}" ]]; then
  echo "❌  Rust: required=${REQUIRED_RUST}, installed=${ACTUAL_RUST}" >&2
  echo "    Run: rustup override set ${REQUIRED_RUST}" >&2
  FAIL=1
else
  echo "✓  Rust ${ACTUAL_RUST}"
fi

# ── WASM target ──────────────────────────────────────────────────────────────
REQUIRED_TARGET="$(grep 'targets' "${REPO_ROOT}/rust-toolchain.toml" | sed 's/.*= *\["\(.*\)"\]/\1/' || echo '')"
if [[ -n "${REQUIRED_TARGET}" ]]; then
  if ! rustup target list --installed 2>/dev/null | grep -q "^${REQUIRED_TARGET}"; then
    echo "❌  Rust target '${REQUIRED_TARGET}' not installed" >&2
    echo "    Run: rustup target add ${REQUIRED_TARGET}" >&2
    FAIL=1
  else
    echo "✓  Rust target ${REQUIRED_TARGET}"
  fi
fi

if (( FAIL > 0 )); then
  echo "" >&2
  echo "Preflight failed. Fix the version mismatches above before continuing." >&2
  exit 1
fi

echo ""
echo "All preflight checks passed."
