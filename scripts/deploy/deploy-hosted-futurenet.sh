#!/bin/bash
set -e

# SECURITY WARNING:
# - This script uses the same Stellar key for relayer, admin, and guardian roles
# - In production, generate SEPARATE keys for each role using 'stellar keys generate'
# - Never commit secret keys to version control
# - Verify network passphrase matches your target network before deploying
# - This script does NOT validate key format - check RELAYER_SECRET_KEY manually

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
GUARDIAN_ADDRESS="${GUARDIAN_ADDRESS:-$(stellar keys address "$KEY_NAME")}"

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
# NOTE: build each contract crate separately (not `cargo build` for all at once).
# Building everything together triggers Cargo feature unification that turns on
# num-traits' float impls, which fail to compile on newer rustc (>=1.80) for
# wasm32v1-none. Per-crate builds keep num-traits feature-minimal and succeed.
#
# TOOLCHAIN PARITY (#595): Soroban P25 hosts require the wasm32v1-none target.
# A binary built for testnet with wasm32-unknown-unknown (or a stale
# rust-toolchain.toml) deploys fine but fails at invoke time with a missing
# bn254/poseidon host-function error. Fail fast here instead.
step "Checking toolchain parity..."
EXPECTED_TARGET="wasm32v1-none"
if ! grep -q 'wasm32v1-none' rust-toolchain.toml 2>/dev/null; then
  echo "ERROR: rust-toolchain.toml must pin targets = [\"wasm32v1-none\"] (Soroban P25). Refusing to deploy." >&2
  exit 1
fi
if ! rustc --print target-list 2>/dev/null | grep -qx "$EXPECTED_TARGET"; then
  echo "ERROR: target $EXPECTED_TARGET is not installed (rustup target add $EXPECTED_TARGET). Refusing to deploy." >&2
  exit 1
fi
if grep -rn "wasm32-unknown-unknown" contracts/ Cargo.toml 2>/dev/null | grep -v "^Binary" | head -1; then
  echo "ERROR: stale wasm32-unknown-unknown reference found in contracts/Cargo config. Use $EXPECTED_TARGET." >&2
  exit 1
fi
# NETWORK PARITY: the RPC URL and passphrase must belong to the same network.
# Deploying a testnet-passphrase build against the futurenet RPC (or vice
# versa) produces signatures the network rejects at ingest.
case "$RPC_URL" in
  *futurenet*) EXPECTED_PASSPHRASE="Test SDF Future Network ; October 2022" ;;
  *testnet*) EXPECTED_PASSPHRASE="Test SDF Network ; September 2015" ;;
  *) EXPECTED_PASSPHRASE="" ;;
esac
if [ -n "$EXPECTED_PASSPHRASE" ] && [ "$NETWORK_PASSPHRASE" != "$EXPECTED_PASSPHRASE" ]; then
  echo "ERROR: RPC/network mismatch: RPC_URL=$RPC_URL expects passphrase '$EXPECTED_PASSPHRASE' but NETWORK_PASSPHRASE='$NETWORK_PASSPHRASE'." >&2
  exit 1
fi
success "Toolchain ($EXPECTED_TARGET) and network parity OK"
step "Building all contracts..."
for c in dao-registry membership-sbt membership-tree voting comments; do
  cargo build -p "$c" --target wasm32v1-none --release
done
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

  # Sigstore/Cosign verification: verify WASM integrity and signature before deploying (fail-closed)
  if [ ! -f "$SCRIPT_DIR/verify-wasm-signature.sh" ]; then
    echo "ERROR: Verifier script $SCRIPT_DIR/verify-wasm-signature.sh not found. Deployment rejected." >&2
    return 1
  fi
  bash "$SCRIPT_DIR/verify-wasm-signature.sh" "$wasm" || {
    echo "ERROR: Cosign signature verification failed for $wasm ($name). Deployment rejected." >&2
    return 1
  }

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
VOTING_ID=$(deploy_contract "Voting" "target/wasm32v1-none/release/voting.wasm" --tree_contract "$TREE_ID" --registry "$REGISTRY_ID" --guardian "$GUARDIAN_ADDRESS")
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
# NUM_PUBLIC_SIGNALS in contracts/voting/src/lib.rs; a Groth16 key has one more
# IC point than the circuit has public signals.
EXPECTED_VK_IC_LEN=7

if [ ! -f "$VK_FILE" ]; then
  # Previously this was a `warn` and the deploy continued, leaving a live DAO
  # with no voting key: every `vote` call fails VkNotSet, so the DAO exists but
  # nobody can vote. A missing key is a hard stop.
  echo "ERROR: verification key not found at $VK_FILE"
  echo ""
  echo "  The key is produced by the trusted setup and must match the circuit's"
  echo "  public-signal count. See frontend/public/circuits/README.md."
  echo ""
  echo "  Refusing to deploy a DAO that cannot accept votes."
  exit 1
fi

VK_IC_LEN="$(node -e '
    const fs = require("fs");
    try {
        const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        process.stdout.write(String((v.ic || v.IC || []).length));
    } catch (e) { process.stdout.write(""); }
' "$VK_FILE")"

if [ "$VK_IC_LEN" != "$EXPECTED_VK_IC_LEN" ]; then
  echo "ERROR: $VK_FILE has ${VK_IC_LEN:-0} IC points, expected $EXPECTED_VK_IC_LEN."
  echo ""
  echo "  set_vk rejects any key whose IC length is not NUM_PUBLIC_SIGNALS + 1, and"
  echo "  verify_groth16 returns false when the counts disagree — so this key could"
  echo "  not be registered, and even if it were, no proof would verify. Refusing to"
  echo "  deploy. See frontend/public/circuits/README.md."
  exit 1
fi

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
  # `set_vk` also requires an MPC transcript attestation. A DAO without a
  # registered key cannot vote, so this is fatal rather than advisory.
  echo "ERROR: failed to register the verification key."
  echo "  The DAO is deployed but CANNOT accept votes until set_vk succeeds."
  echo "  Check the output above; a common cause is a missing transcript-registry"
  echo "  attestation for this vk_hash (VkNotAttested, error #93)."
  exit 1
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
# WARNING: Generate separate keys for relayer and admin in production
# Using the same key for multiple roles violates principle of least privilege
KEY_SECRET=$(stellar keys show "$KEY_NAME" 2>/dev/null || echo "")

# Use existing values or generate new ones
# In production: NEVER reuse the same key for relayer, admin, and guardian
if [ -n "$EXISTING_RELAYER_SECRET" ]; then
  RELAYER_SECRET="$EXISTING_RELAYER_SECRET"
elif [ -n "$KEY_SECRET" ]; then
  warn "SECURITY: Using $KEY_NAME for relayer. Generate dedicated keys in production!"
  RELAYER_SECRET="$KEY_SECRET"
else
  warn "SECURITY: No relayer key configured. Set RELAYER_SECRET_KEY manually!"
  RELAYER_SECRET="REPLACE_ME_RELAYER_SECRET"
fi

if [ -n "$EXISTING_ADMIN_SECRET" ]; then
  ADMIN_SECRET="$EXISTING_ADMIN_SECRET"
else
  warn "SECURITY: No dedicated admin key configured. Using relayer key as fallback."
  warn "In production: Generate separate keys with 'stellar keys generate admin'"
  ADMIN_SECRET="${KEY_SECRET:-REPLACE_ME_ADMIN_SECRET}"
fi

AUTH_TOKEN="${EXISTING_AUTH_TOKEN:-$(openssl rand -hex 32)}"
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
