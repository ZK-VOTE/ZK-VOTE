#!/bin/bash
set -e

echo "=== Complete DaoVote Deployment Script ==="
echo "This script will:"
echo "1. Build all contracts"
echo "2. Deploy all contracts to hosted Futurenet"
echo "3. Generate and build TypeScript bindings"
echo "4. Update frontend and backend configuration"
echo ""

# Configuration
# NOTE: We deploy to HOSTED FUTURENET, not local futurenet
KEY_NAME="${KEY_NAME:-mykey}"
RPC_URL="${RPC_URL:-https://rpc-futurenet.stellar.org}"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Test SDF Future Network ; October 2022}"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

step() {
  echo -e "${BLUE}==>${NC} $1"
}

success() {
  echo -e "${GREEN}✓${NC} $1"
}

warn() {
  echo -e "${YELLOW}⚠${NC} $1"
}

# Step 0: Stop relayer and clear database (fresh deployment = fresh data)
step "Stopping relayer and clearing database..."
# Kill any running relayer processes
pkill -f "node.*src/relayer.js" 2>/dev/null || true
pkill -f "npm run relayer" 2>/dev/null || true
sleep 2

# Clear the SQLite database (old events/DAOs from previous deployment)
if [ -f "backend/data/zkvote.db" ]; then
  rm -f backend/data/zkvote.db backend/data/zkvote.db-shm backend/data/zkvote.db-wal
  success "Cleared relayer database"
else
  echo "No existing database to clear"
fi

# Generate a deployment version (timestamp-based)
DEPLOY_VERSION=$(date +%s)
success "Deployment version: $DEPLOY_VERSION"

# Step 1: Build contracts
step "Building all contracts..."
cargo build --target wasm32v1-none --release
success "Contracts built successfully"

# Step 2: Deploy contracts
step "Deploying contracts to hosted Futurenet..."

# Helper function to extract contract ID from stellar CLI output
extract_contract_id() {
  # Contract ID is the last line that starts with C and is 56 chars long
  grep -E '^C[A-Z0-9]{55}$' | tail -1
}

# Helper function to deploy a contract with retry logic
# Returns contract ID on stdout, all messages go to stderr
deploy_contract() {
  local name="$1"
  local wasm="$2"
  shift 2
  local args=("$@")

  local max_attempts=5
  local attempt=1
  local contract_id=""

  while [ $attempt -le $max_attempts ]; do
    echo "Deploying $name (attempt $attempt/$max_attempts)..." >&2

    local output
    if [ ${#args[@]} -eq 0 ]; then
      output=$(stellar contract deploy \
        --wasm "$wasm" \
        --source "$KEY_NAME" \
        --rpc-url "$RPC_URL" \
        --network-passphrase "$NETWORK_PASSPHRASE" 2>&1) || true
    else
      output=$(stellar contract deploy \
        --wasm "$wasm" \
        --source "$KEY_NAME" \
        --rpc-url "$RPC_URL" \
        --network-passphrase "$NETWORK_PASSPHRASE" \
        -- "${args[@]}" 2>&1) || true
    fi

    # Try to extract contract ID
    contract_id=$(echo "$output" | extract_contract_id)
    if [ -z "$contract_id" ]; then
      contract_id=$(echo "$output" | tail -1 | tr -d '[:space:]')
    fi

    # Validate contract ID format (starts with C, 56 chars)
    if [[ "$contract_id" =~ ^C[A-Z0-9]{55}$ ]]; then
      echo "$contract_id"
      return 0
    fi

    # Check for TxBadSeq specifically - need longer wait
    if echo "$output" | grep -q "TxBadSeq"; then
      warn "TxBadSeq error - sequence number mismatch. Waiting 15s for network sync..." >&2
      sleep 15
    else
      warn "Attempt $attempt failed. Output: $output" >&2
      sleep 8
    fi

    attempt=$((attempt + 1))
  done

  echo ""
  return 1
}

# Deploy DAO Registry
REGISTRY_ID=$(deploy_contract "DAO Registry" "target/wasm32v1-none/release/dao_registry.wasm")
if [ -z "$REGISTRY_ID" ]; then
  echo "ERROR: Failed to deploy DAO Registry after multiple attempts"
  exit 1
fi
success "DAO Registry deployed: $REGISTRY_ID"
sleep 5  # Wait for sequence number to sync

# Deploy Membership SBT
SBT_ID=$(deploy_contract "Membership SBT" "target/wasm32v1-none/release/membership_sbt.wasm" --registry "$REGISTRY_ID")
if [ -z "$SBT_ID" ]; then
  echo "ERROR: Failed to deploy Membership SBT after multiple attempts"
  exit 1
fi
success "Membership SBT deployed: $SBT_ID"
sleep 5  # Wait for sequence number to sync

# Deploy Membership Tree
TREE_ID=$(deploy_contract "Membership Tree" "target/wasm32v1-none/release/membership_tree.wasm" --sbt_contract "$SBT_ID" --registry "$REGISTRY_ID")
if [ -z "$TREE_ID" ]; then
  echo "ERROR: Failed to deploy Membership Tree after multiple attempts"
  exit 1
fi
success "Membership Tree deployed: $TREE_ID"
sleep 5  # Wait for sequence number to sync

# Deploy Voting
VOTING_ID=$(deploy_contract "Voting" "target/wasm32v1-none/release/voting.wasm" --tree_contract "$TREE_ID" --registry "$REGISTRY_ID")
if [ -z "$VOTING_ID" ]; then
  echo "ERROR: Failed to deploy Voting contract after multiple attempts"
  exit 1
fi
success "Voting deployed: $VOTING_ID"
sleep 5  # Wait for sequence number to sync

# Deploy Comments
COMMENTS_ID=$(deploy_contract "Comments" "target/wasm32v1-none/release/comments.wasm" --tree_contract "$TREE_ID" --voting_contract "$VOTING_ID" --registry "$REGISTRY_ID")
if [ -z "$COMMENTS_ID" ]; then
  echo "ERROR: Failed to deploy Comments contract after multiple attempts"
  exit 1
fi
success "Comments deployed: $COMMENTS_ID"

# Step 3: Generate TypeScript bindings
step "Generating TypeScript bindings..."
rm -rf frontend/src/contracts
mkdir -p frontend/src/contracts

echo "Generating DAO Registry bindings..."
stellar contract bindings typescript \
  --contract-id "$REGISTRY_ID" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  --output-dir frontend/src/contracts/dao-registry \
  --overwrite
success "DAO Registry bindings generated"

echo "Generating Membership SBT bindings..."
stellar contract bindings typescript \
  --contract-id "$SBT_ID" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  --output-dir frontend/src/contracts/membership-sbt \
  --overwrite
success "Membership SBT bindings generated"

echo "Generating Membership Tree bindings..."
stellar contract bindings typescript \
  --contract-id "$TREE_ID" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  --output-dir frontend/src/contracts/membership-tree \
  --overwrite
success "Membership Tree bindings generated"

echo "Generating Voting bindings..."
stellar contract bindings typescript \
  --contract-id "$VOTING_ID" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  --output-dir frontend/src/contracts/voting \
  --overwrite
success "Voting bindings generated"

echo "Generating Comments bindings..."
stellar contract bindings typescript \
  --contract-id "$COMMENTS_ID" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  --output-dir frontend/src/contracts/comments \
  --overwrite
success "Comments bindings generated"

# Step 3.5: Build bindings
step "Building TypeScript bindings..."

build_binding() {
  local name="$1"
  local dir="$2"
  echo "Building $name bindings..."
  if ! (cd "$dir" && npm install --silent 2>&1 && npm run build 2>&1) > /tmp/binding-build.log 2>&1; then
    warn "Failed to build $name bindings:"
    cat /tmp/binding-build.log
    warn "Continuing anyway (bindings may work without build)..."
  else
    success "$name bindings built"
  fi
}

build_binding "DAO Registry" "frontend/src/contracts/dao-registry"
build_binding "Membership SBT" "frontend/src/contracts/membership-sbt"
build_binding "Membership Tree" "frontend/src/contracts/membership-tree"
build_binding "Voting" "frontend/src/contracts/voting"
build_binding "Comments" "frontend/src/contracts/comments"

# Step 3.6: Create Public DAO (always DAO #1)
step "Creating Public DAO..."
ADMIN_ADDRESS=$(stellar keys address "$KEY_NAME")

# Create DAO with open membership and member proposals enabled
echo "Creating Public Votes DAO..."
CREATE_OUTPUT=$(stellar contract invoke \
  --id "$REGISTRY_ID" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  --source "$KEY_NAME" \
  -- create_dao \
  --name "Public Votes" \
  --creator "$ADMIN_ADDRESS" \
  --membership_open true \
  --members_can_propose true 2>&1)
echo "$CREATE_OUTPUT"
# Extract DAO ID - look for the number in the output
DAO_ID=$(echo "$CREATE_OUTPUT" | grep -oE '^[0-9]+$' | head -1)
if [ -z "$DAO_ID" ]; then
  # Try parsing JSON-style output
  DAO_ID=$(echo "$CREATE_OUTPUT" | grep -oE '"[0-9]+"' | tr -d '"' | head -1)
fi
if [ -z "$DAO_ID" ]; then
  DAO_ID="1"  # Assume 1 for fresh deployment
fi

if [ "$DAO_ID" != "1" ]; then
  warn "Expected DAO ID 1, got $DAO_ID. This may cause issues."
fi
success "Public DAO created (ID: $DAO_ID)"

# Initialize tree for public DAO
echo "Initializing merkle tree..."
sleep 5  # Wait for sequence number to sync
TREE_INIT_ATTEMPTS=3
TREE_INIT_ATTEMPT=1
while [ $TREE_INIT_ATTEMPT -le $TREE_INIT_ATTEMPTS ]; do
  echo "Tree init attempt $TREE_INIT_ATTEMPT/$TREE_INIT_ATTEMPTS..."
  if TREE_OUTPUT=$(stellar contract invoke \
    --id "$TREE_ID" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE" \
    --source "$KEY_NAME" \
    -- init_tree \
    --dao_id "$DAO_ID" \
    --depth 18 \
    --admin "$ADMIN_ADDRESS" 2>&1); then
    success "Merkle tree initialized (depth 18, capacity 262,144)"
    break
  else
    if echo "$TREE_OUTPUT" | grep -q "timeout"; then
      warn "Timeout on attempt $TREE_INIT_ATTEMPT, retrying..."
      sleep 10
    else
      echo "$TREE_OUTPUT"
      warn "Merkle tree initialization may have failed - check output above"
      break
    fi
  fi
  TREE_INIT_ATTEMPT=$((TREE_INIT_ATTEMPT + 1))
done

# Set verification key for Public DAO
echo "Setting verification key..."
VK_FILE="frontend/src/lib/verification_key_soroban.json"
if [ -f "$VK_FILE" ]; then
  VK_JSON=$(cat "$VK_FILE")
  sleep 5  # Wait for sequence number to sync
  if VK_OUTPUT=$(stellar contract invoke \
    --id "$VOTING_ID" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE" \
    --source "$KEY_NAME" \
    -- set_vk \
    --dao_id "$DAO_ID" \
    --vk "$VK_JSON" \
    --admin "$ADMIN_ADDRESS" 2>&1); then
    success "Verification key set for Public DAO"
  else
    echo "$VK_OUTPUT"
    warn "Verification key setting may have failed - check output above"
  fi
else
  warn "Verification key file not found at $VK_FILE"
  warn "You'll need to set it manually through the frontend UI"
fi

# Step 4: Update frontend configuration
step "Updating frontend configuration..."
cat > frontend/src/config/contracts.ts << EOF
// Deployed contract addresses and network configuration
// Auto-generated on $(date)

export const CONTRACTS = {
  REGISTRY_ID: "$REGISTRY_ID",
  SBT_ID: "$SBT_ID",
  TREE_ID: "$TREE_ID",
  VOTING_ID: "$VOTING_ID",
  COMMENTS_ID: "$COMMENTS_ID",
} as const;

export const NETWORK_CONFIG = {
  rpcUrl: "$RPC_URL",
  networkPassphrase: "$NETWORK_PASSPHRASE",
  networkName: "futurenet",
} as const;

// Deployment version - changes on each deployment
// Used for cache invalidation in frontend
export const DEPLOY_VERSION = "$DEPLOY_VERSION";

// Contract method names for type safety
export const CONTRACT_METHODS = {
  REGISTRY: {
    CREATE_DAO: "create_dao",
    GET_DAO: "get_dao",
    CREATE_AND_INIT_DAO: "create_and_init_dao",
    CREATE_AND_INIT_DAO_NO_REG: "create_and_init_dao_no_reg",
  },
  SBT: {
    MINT: "mint",
    MINT_FROM_REGISTRY: "mint_from_registry",
    HAS: "has",
  },
  TREE: {
    INIT_TREE: "init_tree",
    REGISTER_WITH_CALLER: "register_with_caller",
    GET_ROOT: "get_root",
  },
  VOTING: {
    SET_VK: "set_vk",
    CREATE_PROPOSAL: "create_proposal",
    VOTE: "vote",
    GET_PROPOSAL: "get_proposal",
    GET_RESULTS: "get_results",
  },
} as const;
EOF
success "Frontend configuration updated"

# Step 5: Update backend .env file
step "Updating backend configuration..."

# Preserve existing values from backend/.env if they exist
if [ -f "backend/.env" ]; then
  EXISTING_RELAYER_SECRET=$(grep '^RELAYER_SECRET_KEY=' backend/.env | cut -d'=' -f2-)
  EXISTING_AUTH_TOKEN=$(grep '^RELAYER_AUTH_TOKEN=' backend/.env | cut -d'=' -f2-)
  EXISTING_PINATA_JWT=$(grep '^PINATA_JWT=' backend/.env | cut -d'=' -f2-)
  EXISTING_PINATA_GATEWAY=$(grep '^PINATA_GATEWAY=' backend/.env | cut -d'=' -f2-)
  EXISTING_CORS=$(grep '^CORS_ORIGIN=' backend/.env | cut -d'=' -f2-)
  EXISTING_ADMIN_SECRET=$(grep '^ADMIN_SECRET_KEY=' backend/.env | cut -d'=' -f2-)
fi

# Get secret key from stellar CLI if not already set
KEY_SECRET=$(stellar keys show "$KEY_NAME" 2>/dev/null || echo "")

# Use existing values or defaults
RELAYER_SECRET="${EXISTING_RELAYER_SECRET:-${KEY_SECRET:-REPLACE_ME_RELAYER_SECRET}}"
AUTH_TOKEN="${EXISTING_AUTH_TOKEN:-$(openssl rand -hex 32)}"
ADMIN_SECRET="${EXISTING_ADMIN_SECRET:-${KEY_SECRET:-REPLACE_ME_ADMIN_SECRET}}"
CORS_ORIGINS="${EXISTING_CORS:-http://localhost:5173,http://localhost:5174}"

cat > backend/.env << EOF
# DaoVote Relayer Configuration
# Auto-generated by scripts/deploy/deploy-hosted-futurenet.sh on $(date)

# Network Configuration
SOROBAN_RPC_URL=$RPC_URL
NETWORK_PASSPHRASE=$NETWORK_PASSPHRASE

# Relayer Account
RELAYER_SECRET_KEY=$RELAYER_SECRET
ADMIN_SECRET_KEY=$ADMIN_SECRET

# Authentication (required for write endpoints)
RELAYER_AUTH_TOKEN=$AUTH_TOKEN

# Contract Addresses
DAO_REGISTRY_CONTRACT_ID=$REGISTRY_ID
MEMBERSHIP_SBT_CONTRACT_ID=$SBT_ID
VOTING_CONTRACT_ID=$VOTING_ID
TREE_CONTRACT_ID=$TREE_ID
COMMENTS_CONTRACT_ID=$COMMENTS_ID

# Event Indexer
INDEXER_ENABLED=true
INDEXER_POLL_INTERVAL_MS=5000

# Server Configuration
PORT=3001

# CORS Configuration
CORS_ORIGIN=$CORS_ORIGINS
EOF

# Append Pinata config if it existed
if [ -n "$EXISTING_PINATA_JWT" ]; then
  cat >> backend/.env << EOF

# Pinata IPFS Configuration
PINATA_JWT=$EXISTING_PINATA_JWT
EOF
fi

if [ -n "$EXISTING_PINATA_GATEWAY" ]; then
  cat >> backend/.env << EOF
PINATA_GATEWAY=$EXISTING_PINATA_GATEWAY
EOF
fi

success "Backend configuration updated"

# Step 6: Restart relayer if running
step "Restarting relayer (if running)..."
# Find and kill any running relayer processes
RELAYER_PIDS=$(pgrep -f "node src/relayer.js" || true)
if [ -n "$RELAYER_PIDS" ]; then
  echo "Stopping existing relayer processes: $RELAYER_PIDS"
  kill $RELAYER_PIDS 2>/dev/null || true
  sleep 1
  success "Relayer stopped"
else
  echo "No running relayer found"
fi

# Summary
echo ""
echo -e "${GREEN}=== Deployment Complete! ===${NC}"
echo ""
echo "Contract Addresses:"
echo "  DAO Registry:    $REGISTRY_ID"
echo "  Membership SBT:  $SBT_ID"
echo "  Membership Tree: $TREE_ID"
echo "  Voting:          $VOTING_ID"
echo "  Comments:        $COMMENTS_ID"
echo ""
echo "Next steps:"
echo "  1. Start the relayer: cd backend && npm run relayer"
echo "  2. Start the frontend: cd frontend && npm run dev"
echo ""
