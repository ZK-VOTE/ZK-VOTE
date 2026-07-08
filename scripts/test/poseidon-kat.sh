#!/bin/bash
# End-to-End Poseidon KAT Test
#
# Verifies circomlib and P25 Poseidon implementations are compatible
# by deploying contracts to local P25 testnet and comparing Merkle roots.
#
# CRITICAL: Run this BEFORE production deployment!
#
# Prerequisites:
# - Docker running
# - Stellar CLI with P25 support

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "============================================"
echo "Poseidon KAT End-to-End Verification"
echo "============================================"
echo ""
echo "This test verifies that circomlib Poseidon and P25 host function"
echo "produce identical results. If they don't match, the system is broken."
echo ""

# Check prerequisites
command -v stellar >/dev/null 2>&1 || { echo "ERROR: stellar CLI not found"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: node not found"; exit 1; }

# Step 1: Start local P25 testnet
echo "Step 1: Starting local P25 testnet..."
stellar container start -t future 2>/dev/null || {
    echo "  Container already running or starting..."
}

# Wait for network
echo "  Waiting for network to be ready..."
sleep 5

# Check network health
if ! curl -s --max-time 5 http://localhost:8000/health > /dev/null 2>&1; then
    echo "  ERROR: Network not responding. Please ensure Docker is running."
    exit 1
fi
echo "  Network is ready."
echo ""

# Network configuration - use explicit parameters
RPC_URL="http://localhost:8000/soroban/rpc"
NETWORK_PASSPHRASE="Standalone Network ; February 2017"

# Step 2: Create and fund test key
echo "Step 2: Creating test account..."
KEY_NAME="kat-test-$(date +%s)"
stellar keys generate "$KEY_NAME" --no-fund 2>/dev/null || true
PUBKEY=$(stellar keys address "$KEY_NAME")
echo "  Public key: $PUBKEY"

stellar keys fund "$KEY_NAME" --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE"
echo "  Account funded."
echo ""

# Step 3: Build contracts
echo "Step 3: Building contracts..."
cd "$PROJECT_ROOT"
cargo build --target wasm32v1-none --release -p dao-registry -p membership-sbt -p membership-tree 2>&1 | tail -5
echo "  Contracts built."
echo ""

# Step 4: Deploy contracts with constructors
echo "Step 4: Deploying contracts..."

REGISTRY_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/dao_registry.wasm \
  --source "$KEY_NAME" --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE" 2>&1 | tail -1)
echo "  DAORegistry: $REGISTRY_ID"

SBT_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/membership_sbt.wasm \
  --source "$KEY_NAME" --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE" \
  -- --registry "$REGISTRY_ID" 2>&1 | tail -1)
echo "  MembershipSBT: $SBT_ID"

TREE_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/membership_tree.wasm \
  --source "$KEY_NAME" --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE" \
  -- --sbt_contract "$SBT_ID" 2>&1 | tail -1)
echo "  MembershipTree: $TREE_ID"
echo ""

# Step 5: Contracts initialized via CAP-0058 constructors at deploy time

# Step 6: Create test DAO
echo "Step 5: Creating test DAO..."
DAO_ID=$(stellar contract invoke \
  --id "$REGISTRY_ID" \
  --source "$KEY_NAME" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- create_dao \
  --name "KAT Test DAO" \
  --creator "$PUBKEY" 2>&1 | tail -1 | tr -d '"')
echo "  DAO ID: $DAO_ID"
echo ""

# Step 7: Initialize tree for this DAO
echo "Step 6: Initializing Merkle tree..."
stellar contract invoke \
  --id "$TREE_ID" \
  --source "$KEY_NAME" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- init_tree \
  --dao_id "$DAO_ID" \
  --depth 20 \
  --admin "$PUBKEY" 2>&1 | tail -3
echo "  Tree initialized with depth 20."
echo ""

# Step 8: Mint SBT for test member
echo "Step 7: Minting SBT..."
stellar contract invoke \
  --id "$SBT_ID" \
  --source "$KEY_NAME" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- mint \
  --dao_id "$DAO_ID" \
  --to "$PUBKEY" \
  --admin "$PUBKEY" 2>&1 | tail -3
echo "  SBT minted."
echo ""

# Step 9: Register known commitment
echo "Step 8: Registering test commitment..."
# From circomlib: Poseidon(12345, 67890) = 0x1914879b2a4e7f9555f3eb55837243cefb1366a692794a7e5b5b3181fb14b49b
# As U256 JSON:
COMMITMENT_JSON='{"hi_hi":1806915879155105685,"hi_lo":6191291063665763278,"lo_hi":18095619929817262718,"lo_lo":6581073628349498523}'

stellar contract invoke \
  --id "$TREE_ID" \
  --source "$KEY_NAME" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- register_with_caller \
  --dao_id "$DAO_ID" \
  --commitment "$COMMITMENT_JSON" \
  --caller "$PUBKEY" 2>&1 | tail -3
echo "  Commitment registered."
echo ""

# Step 10: Get current root
echo "Step 9: Getting current Merkle root..."
ACTUAL_ROOT=$(stellar contract invoke \
  --id "$TREE_ID" \
  --source "$KEY_NAME" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- current_root \
  --dao_id "$DAO_ID" 2>&1 | tail -1)
echo "  Actual root (from P25): $ACTUAL_ROOT"
echo ""

# Step 11: Compare with expected
echo "Step 10: Comparing with circomlib expected value..."
# Expected from circomlib: 0x2d8b784789ca06c6bb30d7593b0774a6124aff26581f04b9125d1be25e46545d
# As U256 JSON:
EXPECTED_ROOT='{"hi_hi":3286161620916250310,"hi_lo":13489905787044537510,"lo_hi":1319043788869878969,"lo_lo":1327085652556297309}'
echo "  Expected root (from circomlib): $EXPECTED_ROOT"
echo ""

# Parse and compare
if [ "$ACTUAL_ROOT" = "$EXPECTED_ROOT" ]; then
    echo "============================================"
    echo "✅ SUCCESS: Poseidon KAT PASSED!"
    echo "============================================"
    echo ""
    echo "Circomlib and P25 Poseidon implementations produce IDENTICAL results."
    echo "Safe to proceed with deployment."
else
    echo "============================================"
    echo "❌ FAILURE: Poseidon KAT FAILED!"
    echo "============================================"
    echo ""
    echo "Circomlib and P25 Poseidon implementations DO NOT MATCH!"
    echo ""
    echo "Expected: $EXPECTED_ROOT"
    echo "Actual:   $ACTUAL_ROOT"
    echo ""
    echo "DO NOT DEPLOY - the system will not work correctly."
    echo "Check Poseidon parameters (rounds, constants, field) in both implementations."
    exit 1
fi

# Cleanup
echo "Cleaning up test key..."
stellar keys remove "$KEY_NAME" 2>/dev/null || true

echo ""
echo "KAT test complete."
