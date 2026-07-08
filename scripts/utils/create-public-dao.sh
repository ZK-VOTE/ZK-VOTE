#!/bin/bash
# Create a Public DAO with open membership
#
# This script creates a DAO where:
# - Anyone can self-join (mint SBT)
# - Anyone can self-register (add commitment to tree)
# - Anyone can create proposals
# - Anyone who registered can vote

set -e

# Load deployed contract addresses
if [ ! -f .deployed-contracts ]; then
  echo "Error: .deployed-contracts file not found"
  echo "Please run scripts/deploy/deploy-hosted-futurenet.sh first"
  exit 1
fi

source .deployed-contracts

# Configuration
DAO_NAME="${1:-Public DAO}"
TREE_DEPTH="${2:-18}"

# Get admin address
ADMIN_ADDRESS=$(stellar keys address "$KEY_NAME")

echo "==========================================="
echo "Creating Public DAO"
echo "==========================================="
echo ""
echo "Name: $DAO_NAME"
echo "Tree Depth: $TREE_DEPTH (max members: $((2**TREE_DEPTH)))"
echo "Membership: OPEN (anyone can join)"
echo ""

# Load verification key from frontend
VK_FILE="frontend/public/circuits/verification_key.json"
if [ ! -f "$VK_FILE" ]; then
  echo "Error: Verification key not found at $VK_FILE"
  echo "Please run: cd circuits && npm run compile"
  exit 1
fi

# Convert VK to format suitable for Soroban
VK_CONTENT=$(cat "$VK_FILE" | jq -c .)

echo "Step 1: Creating public DAO..."
DAO_ID=$(stellar contract invoke \
  --id "$REGISTRY_ID" \
  --network "$NETWORK" \
  --source "$KEY_NAME" \
  -- create_dao \
  --name "$DAO_NAME" \
  --creator "$ADMIN_ADDRESS" \
  --membership_open true \
  --members_can_propose true 2>&1 | tr -d '"')

echo "✅ DAO created with ID: $DAO_ID"
echo ""

echo "Step 2: Minting admin SBT..."
stellar contract invoke \
  --id "$SBT_ID" \
  --network "$NETWORK" \
  --source "$KEY_NAME" \
  -- mint_from_registry \
  --dao_id "$DAO_ID" \
  --to "$ADMIN_ADDRESS" > /dev/null 2>&1

echo "✅ Admin SBT minted"
echo ""

echo "Step 3: Initializing membership tree (depth $TREE_DEPTH)..."
stellar contract invoke \
  --id "$TREE_ID" \
  --network "$NETWORK" \
  --source "$KEY_NAME" \
  -- init_tree_from_registry \
  --dao_id "$DAO_ID" \
  --depth "$TREE_DEPTH" > /dev/null 2>&1

echo "✅ Tree initialized"
echo ""

echo "Step 4: Setting verification key..."
stellar contract invoke \
  --id "$VOTING_ID" \
  --network "$NETWORK" \
  --source "$KEY_NAME" \
  -- set_vk_from_registry \
  --dao_id "$DAO_ID" \
  --vk "$VK_CONTENT" > /dev/null 2>&1

echo "✅ Verification key set"
echo ""

echo "==========================================="
echo "Public DAO Created Successfully!"
echo "==========================================="
echo ""
echo "DAO ID: $DAO_ID"
echo "Membership: OPEN"
echo ""
echo "Public features enabled:"
echo "  ✅ Anyone can join (self_join on SBT contract)"
echo "  ✅ Anyone can register (self_register on tree contract)"
echo "  ✅ Anyone can create proposals"
echo "  ✅ Anyone who registered can vote"
echo ""
echo "To join this DAO:"
echo "  1. Call self_join() on SBT contract ($SBT_ID)"
echo "  2. Call self_register() on tree contract ($TREE_ID)"
echo "  3. Generate ZK proof and vote!"
echo ""
