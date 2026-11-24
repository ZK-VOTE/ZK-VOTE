#!/usr/bin/env bash
set -euo pipefail

RPC_URL="${RPC_URL:-https://soroban-testnet.stellar.org}"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
SOURCE_ACCOUNT="${SOURCE_ACCOUNT:-mykey}"
MIN_DELAY_SECONDS="${MIN_DELAY_SECONDS:-86400}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/deploy/upgrade-contract.sh propose \
    --registry CONTRACT_ID --dao-id ID --target CONTRACT_ID \
    --wasm-hash HEX --rollback-wasm-hash HEX \
    --from-version N --to-version N --storage-version N \
    [--migration-payload HEX] [--eta UNIX] [--expires-at UNIX]

  scripts/deploy/upgrade-contract.sh execute \
    --registry CONTRACT_ID --dao-id ID --proposal-id ID --executor ADDRESS

  scripts/deploy/upgrade-contract.sh rollback \
    --registry CONTRACT_ID --dao-id ID --proposal-id ID --executor ADDRESS
USAGE
}

mode="${1:-}"
if [ -z "$mode" ]; then
  usage
  exit 1
fi
shift

REGISTRY_ID=""
DAO_ID=""
TARGET_CONTRACT=""
WASM_HASH=""
ROLLBACK_WASM_HASH=""
FROM_VERSION=""
TO_VERSION=""
STORAGE_VERSION=""
MIGRATION_PAYLOAD=""
ETA=""
EXPIRES_AT=""
PROPOSAL_ID=""
EXECUTOR=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --registry) REGISTRY_ID="$2"; shift 2 ;;
    --dao-id) DAO_ID="$2"; shift 2 ;;
    --target) TARGET_CONTRACT="$2"; shift 2 ;;
    --wasm-hash) WASM_HASH="$2"; shift 2 ;;
    --rollback-wasm-hash) ROLLBACK_WASM_HASH="$2"; shift 2 ;;
    --from-version) FROM_VERSION="$2"; shift 2 ;;
    --to-version) TO_VERSION="$2"; shift 2 ;;
    --storage-version) STORAGE_VERSION="$2"; shift 2 ;;
    --migration-payload) MIGRATION_PAYLOAD="$2"; shift 2 ;;
    --eta) ETA="$2"; shift 2 ;;
    --expires-at) EXPIRES_AT="$2"; shift 2 ;;
    --proposal-id) PROPOSAL_ID="$2"; shift 2 ;;
    --executor) EXECUTOR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

invoke_registry() {
  stellar contract invoke \
    --id "$REGISTRY_ID" \
    --source "$SOURCE_ACCOUNT" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE" \
    --
}

# ── Election blackout preflight (ZV-059) ─────────────────────────────────────
# Query the backend for active elections and refuse to proceed if the current
# time falls within any closing-window blackout.  Set BLACKOUT_OVERRIDE_TOKEN
# to a valid override token to bypass the check with an audit trail.
check_blackout() {
  local api_base="${BACKEND_API_BASE:-http://localhost:3000}"
  local override_token="${BLACKOUT_OVERRIDE_TOKEN:-}"
  local response http_code

  # Attempt to reach the backend blackout endpoint.  If the backend is
  # unreachable we warn but do NOT block — a cold-start deploy without a
  # running backend should still be possible.
  if ! response=$(curl -sf --max-time 10 \
      -H "X-Blackout-Override: ${override_token}" \
      "${api_base}/admin/blackout-status" 2>/dev/null); then
    echo "[blackout-check] WARNING: could not reach ${api_base}/admin/blackout-status — skipping check" >&2
    return 0
  fi

  local in_blackout
  in_blackout=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('inBlackout', False))" 2>/dev/null || echo "false")

  if [ "$in_blackout" = "True" ] || [ "$in_blackout" = "true" ]; then
    if [ -n "$override_token" ]; then
      echo "[blackout-check] WARNING: proceeding with override token during blackout" >&2
    else
      echo "[blackout-check] ERROR: deploy blocked — active election blackout in effect." >&2
      echo "  Set BLACKOUT_OVERRIDE_TOKEN to a valid override token to bypass." >&2
      echo "  Response: $response" >&2
      exit 1
    fi
  else
    echo "[blackout-check] OK: no active blackout" >&2
  fi
}
# ─────────────────────────────────────────────────────────────────────────────

case "$mode" in
  propose)
    if [ -z "$REGISTRY_ID" ] || [ -z "$DAO_ID" ] || [ -z "$TARGET_CONTRACT" ] || \
      [ -z "$WASM_HASH" ] || [ -z "$ROLLBACK_WASM_HASH" ] || [ -z "$FROM_VERSION" ] || \
      [ -z "$TO_VERSION" ] || [ -z "$STORAGE_VERSION" ]; then
      usage
      exit 1
    fi
    check_blackout
    now="$(date +%s)"
    ETA="${ETA:-$((now + MIN_DELAY_SECONDS))}"
    EXPIRES_AT="${EXPIRES_AT:-$((ETA + MIN_DELAY_SECONDS))}"
    invoke_registry propose_contract_upgrade \
      --dao_id "$DAO_ID" \
      --target_contract "$TARGET_CONTRACT" \
      --wasm_hash "$WASM_HASH" \
      --rollback_wasm_hash "$ROLLBACK_WASM_HASH" \
      --from_version "$FROM_VERSION" \
      --to_version "$TO_VERSION" \
      --storage_version "$STORAGE_VERSION" \
      --migration_payload "$MIGRATION_PAYLOAD" \
      --eta "$ETA" \
      --expires_at "$EXPIRES_AT" \
      --proposer "$(stellar keys address "$SOURCE_ACCOUNT")"
    ;;
  execute)
    if [ -z "$REGISTRY_ID" ] || [ -z "$DAO_ID" ] || [ -z "$PROPOSAL_ID" ] || [ -z "$EXECUTOR" ]; then
      usage
      exit 1
    fi
    check_blackout
    invoke_registry execute_contract_upgrade \
      --dao_id "$DAO_ID" \
      --proposal_id "$PROPOSAL_ID" \
      --executor "$EXECUTOR"
    ;;
  rollback)
    if [ -z "$REGISTRY_ID" ] || [ -z "$DAO_ID" ] || [ -z "$PROPOSAL_ID" ] || [ -z "$EXECUTOR" ]; then
      usage
      exit 1
    fi
    check_blackout
    invoke_registry rollback_contract_upgrade \
      --dao_id "$DAO_ID" \
      --proposal_id "$PROPOSAL_ID" \
      --executor "$EXECUTOR"
    ;;
  *)
    usage
    exit 1
    ;;
esac
