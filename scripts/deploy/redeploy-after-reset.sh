#!/bin/bash
set -e

echo "=== ZKVote Post-Network-Reset Redeployment ==="
echo ""
echo "This script handles a full redeployment after a testnet reset."
echo "It will:"
echo "  1. Fund the deployer account via friendbot"
echo "  2. Build and deploy all contracts"
echo "  3. Create the Public DAO with tree + VK"
echo "  4. Update frontend and backend configs"
echo "  5. Rebuild and redeploy Docker containers on the server"
echo ""

# Configuration
KEY_NAME="${KEY_NAME:-mykey}"
RPC_URL="${RPC_URL:-https://soroban-testnet.stellar.org}"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
SERVER="${DEPLOY_SERVER:-root@178.156.244.26}"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

step() { echo -e "${BLUE}==>${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }

# Step 0: Fund the deployer account
step "Funding deployer account via friendbot..."
ADMIN_ADDRESS=$(stellar keys address "$KEY_NAME" 2>/dev/null)
if [ -z "$ADMIN_ADDRESS" ]; then
  fail "Key '$KEY_NAME' not found. Run: stellar keys generate $KEY_NAME"
fi

stellar keys fund "$KEY_NAME" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" 2>&1 || {
  # Try friendbot directly
  curl -s "https://friendbot.stellar.org/?addr=$ADMIN_ADDRESS" > /dev/null 2>&1
}
success "Account funded: $ADMIN_ADDRESS"

# Step 1: Run the main deploy script
step "Running contract deployment..."
RPC_URL="$RPC_URL" NETWORK_PASSPHRASE="$NETWORK_PASSPHRASE" \
  bash scripts/deploy/deploy-hosted-futurenet.sh

# Step 2: Fix networkName (deploy script always writes "futurenet")
step "Fixing network name in frontend config..."
sed -i '' 's/networkName: "futurenet"/networkName: "testnet"/' frontend/src/config/contracts.ts 2>/dev/null || \
sed -i 's/networkName: "futurenet"/networkName: "testnet"/' frontend/src/config/contracts.ts
success "Network name set to testnet"

# Step 3: Update production backend env
step "Updating production backend configuration..."
# Read the new contract IDs from the local .env (written by deploy script)
source <(grep -E "^(DAO_REGISTRY|MEMBERSHIP_SBT|VOTING|TREE|COMMENTS)_CONTRACT_ID=" backend/.env)

# Update .env.production with new IDs
sed -i '' "s/DAO_REGISTRY_CONTRACT_ID=.*/DAO_REGISTRY_CONTRACT_ID=$DAO_REGISTRY_CONTRACT_ID/" backend/.env.production 2>/dev/null || \
sed -i "s/DAO_REGISTRY_CONTRACT_ID=.*/DAO_REGISTRY_CONTRACT_ID=$DAO_REGISTRY_CONTRACT_ID/" backend/.env.production
sed -i '' "s/MEMBERSHIP_SBT_CONTRACT_ID=.*/MEMBERSHIP_SBT_CONTRACT_ID=$MEMBERSHIP_SBT_CONTRACT_ID/" backend/.env.production 2>/dev/null || \
sed -i "s/MEMBERSHIP_SBT_CONTRACT_ID=.*/MEMBERSHIP_SBT_CONTRACT_ID=$MEMBERSHIP_SBT_CONTRACT_ID/" backend/.env.production
sed -i '' "s/VOTING_CONTRACT_ID=.*/VOTING_CONTRACT_ID=$VOTING_CONTRACT_ID/" backend/.env.production 2>/dev/null || \
sed -i "s/VOTING_CONTRACT_ID=.*/VOTING_CONTRACT_ID=$VOTING_CONTRACT_ID/" backend/.env.production
sed -i '' "s/TREE_CONTRACT_ID=.*/TREE_CONTRACT_ID=$TREE_CONTRACT_ID/" backend/.env.production 2>/dev/null || \
sed -i "s/TREE_CONTRACT_ID=.*/TREE_CONTRACT_ID=$TREE_CONTRACT_ID/" backend/.env.production
sed -i '' "s/COMMENTS_CONTRACT_ID=.*/COMMENTS_CONTRACT_ID=$COMMENTS_CONTRACT_ID/" backend/.env.production 2>/dev/null || \
sed -i "s/COMMENTS_CONTRACT_ID=.*/COMMENTS_CONTRACT_ID=$COMMENTS_CONTRACT_ID/" backend/.env.production
success "Production config updated"

# Step 4: Deploy to server
step "Syncing to server and rebuilding..."
rsync -avz --delete \
  --exclude 'target/' \
  --exclude 'node_modules/' \
  --exclude '.git/' \
  --exclude 'tests/' \
  --exclude 'backend/data/' \
  --exclude 'backend/dist/' \
  --exclude 'frontend/dist/' \
  --exclude 'backend/.env' \
  --exclude '.env' \
  --exclude '*.log' \
  --exclude 'test-results/' \
  ./ "$SERVER:/opt/zkvote/" 2>&1 | tail -3

ssh "$SERVER" "cd /opt/zkvote && docker compose down && docker compose build --no-cache 2>&1 | tail -5 && docker compose up -d 2>&1"
success "Server rebuilt and restarted"

# Step 5: Verify
step "Verifying deployment..."
sleep 10
HEALTH=$(curl -s https://server.zkvote.net/health)
if echo "$HEALTH" | grep -q '"ok"'; then
  success "Backend healthy: $HEALTH"
else
  warn "Backend may not be healthy: $HEALTH"
fi

HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' https://zkvote.net)
if [ "$HTTP_CODE" = "200" ]; then
  success "Frontend serving (HTTP $HTTP_CODE)"
else
  warn "Frontend returned HTTP $HTTP_CODE"
fi

echo ""
echo -e "${GREEN}=== Post-Reset Redeployment Complete ===${NC}"
echo ""
echo "New Contract Addresses:"
echo "  DAO Registry:    $DAO_REGISTRY_CONTRACT_ID"
echo "  Membership SBT:  $MEMBERSHIP_SBT_CONTRACT_ID"
echo "  Membership Tree: $TREE_CONTRACT_ID"
echo "  Voting:          $VOTING_CONTRACT_ID"
echo "  Comments:        $COMMENTS_CONTRACT_ID"
echo ""
echo "Verify at: https://zkvote.net"
