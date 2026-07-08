#!/bin/bash

# Set verification key for Public DAO (DAO #1)
#
# This script sets the Groth16 verification key for the Public DAO,
# which is required before proposals can be created.
#
# Usage: bash backend/src/set-public-dao-vk.sh

set -e

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Extract specific variables from .env file
ENV_FILE="$PROJECT_ROOT/backend/.env"
VOTING_CONTRACT_ID=$(grep "^VOTING_CONTRACT_ID=" "$ENV_FILE" | cut -d'=' -f2)
SOROBAN_RPC_URL=$(grep "^SOROBAN_RPC_URL=" "$ENV_FILE" | cut -d'=' -f2)
NETWORK_PASSPHRASE=$(grep "^NETWORK_PASSPHRASE=" "$ENV_FILE" | cut -d'=' -f2-)

# Configuration
KEY_NAME="${KEY_NAME:-mykey}"
VK_FILE="$PROJECT_ROOT/frontend/src/lib/verification_key_soroban.json"

echo "Setting verification key for Public DAO (DAO #1)..."
echo "Voting Contract: $VOTING_CONTRACT_ID"
echo "RPC URL: $SOROBAN_RPC_URL"
echo ""

# Check if verification key file exists
if [ ! -f "$VK_FILE" ]; then
  echo "Error: Verification key file not found at $VK_FILE"
  exit 1
fi

# Get admin address (from key)
ADMIN_ADDRESS=$(stellar keys address "$KEY_NAME")

echo "Admin address: $ADMIN_ADDRESS"
echo "Invoking set_vk contract method..."
echo ""

# Build VK struct from JSON - stellar CLI expects JSON input for structs
VK_JSON=$(cat "$VK_FILE")

# Call set_vk on voting contract
stellar contract invoke \
  --id "$VOTING_CONTRACT_ID" \
  --rpc-url "$SOROBAN_RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  --source "$KEY_NAME" \
  -- set_vk \
  --dao_id 1 \
  --vk "$VK_JSON" \
  --admin "$ADMIN_ADDRESS"

echo ""
echo "✅ Verification key set successfully for Public DAO!"
echo "You can now create proposals in the Public DAO."
