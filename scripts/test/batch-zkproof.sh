#!/bin/bash
# Batch ZK Proof Submission Test
# Runs multiple ZK proofs to stress test the voting system
#
# This version creates multiple test keys, each with their own SBT and commitment.
# Each key submits one vote to the same proposal.
#
# Usage: ./scripts/test/batch-zkproof.sh [count] [admin_key] [dao_id]
# Example: ./scripts/test/batch-zkproof.sh 10 mykey 1
#
# Prerequisites:
# - stellar CLI installed
# - node installed with circomlibjs and snarkjs
# - Admin key with SBT already (run single e2e-zkproof.sh first)
# - Circuit artifacts in frontend/public/circuits/

set -e

# Parameters
COUNT="${1:-10}"
ADMIN_KEY="${2:-mykey}"
DAO_ID="${3:-1}"

echo "=== ZKVote Batch Proof Submission Test ==="
echo "Target: $COUNT proofs"
echo "Admin Key: $ADMIN_KEY"
echo "DAO ID: $DAO_ID"
echo ""

# Contract IDs
SBT_ID="CAZVWMBJCACO4K5L4JWK7GA7UHCQDSNN3PO6LVKYNFBLFVMYHLDUIF62"
TREE_ID="CC5E2WNM5GIY34JVW667Y7QHPN4B6SWD2ZMMWHQOFOFRHSHDMD6NMW6H"
VOTING_ID="CCLPDGSNSZDRVKLEJ5QM3U2AVQIROSXNJVYNWNL4PIKUX4TJYILQBVJB"

# Network params
RPC_URL="https://rpc-futurenet.stellar.org"
NETWORK_PASSPHRASE="Test SDF Future Network ; October 2022"

# Set NODE_PATH
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export NODE_PATH="$PROJECT_ROOT/frontend/node_modules"

CIRCUIT_DIR="$PROJECT_ROOT/frontend/public/circuits"

# Check prerequisites
command -v stellar >/dev/null 2>&1 || { echo "stellar CLI not found"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node not found"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq not found"; exit 1; }

if [ ! -f "$CIRCUIT_DIR/vote.wasm" ] || [ ! -f "$CIRCUIT_DIR/vote_final.zkey" ]; then
    echo "ERROR: Circuit artifacts not found in $CIRCUIT_DIR"
    exit 1
fi

# Get admin key address
ADMIN_ADDRESS=$(stellar keys address $ADMIN_KEY 2>/dev/null || echo "")
if [ -z "$ADMIN_ADDRESS" ]; then
    echo "ERROR: Admin key '$ADMIN_KEY' not found"
    exit 1
fi

# Helper function for contract invocation
invoke() {
    local key="${INVOKE_KEY:-$ADMIN_KEY}"
    stellar contract invoke \
        --rpc-url "$RPC_URL" \
        --network-passphrase "$NETWORK_PASSPHRASE" \
        --source $key \
        "$@"
}

# Check if admin has SBT (needed to mint to others)
HAS_SBT=$(invoke --id $SBT_ID -- has --dao_id $DAO_ID --of $ADMIN_ADDRESS 2>&1 | grep -E '^(true|false)$' | tail -1)
if [ "$HAS_SBT" != "true" ]; then
    echo "ERROR: Admin $ADMIN_KEY does not have SBT for DAO $DAO_ID"
    echo "Please run: ./scripts/test/e2e-zkproof.sh $ADMIN_KEY $DAO_ID"
    exit 1
fi
echo "Admin has SBT: ✓"

# Create a single proposal for all votes
echo "Creating proposal for batch test..."
END_TIME=$(($(date +%s) + 86400))
PROPOSAL_ID=$(invoke \
    --id $VOTING_ID \
    -- create_proposal \
    --dao_id $DAO_ID \
    --title '"Batch ZK Test Proposal"' \
    --content_cid '"batch-test-content"' \
    --end_time $END_TIME \
    --vote_mode '"Trailing"' \
    --creator $ADMIN_ADDRESS 2>&1 | grep -E '^[0-9]+$' | tail -1)

if [ -z "$PROPOSAL_ID" ]; then
    echo "ERROR: Failed to create proposal"
    exit 1
fi
echo "Created Proposal ID: $PROPOSAL_ID"
echo ""

# Phase 1: Pre-create all test accounts
echo "=== Phase 1: Creating $COUNT test accounts ==="
declare -a TEST_KEYS
declare -a TEST_ADDRESSES

TIMESTAMP=$(date +%s)
for i in $(seq 1 $COUNT); do
    KEY_NAME="batchtest_${TIMESTAMP}_${i}"

    # Generate new key (local only, fund separately)
    stellar keys generate $KEY_NAME 2>/dev/null || true

    # Get address
    ADDRESS=$(stellar keys address $KEY_NAME 2>/dev/null)
    if [ -z "$ADDRESS" ]; then
        echo "  [$i] Failed to create key"
        continue
    fi

    TEST_KEYS+=("$KEY_NAME")
    TEST_ADDRESSES+=("$ADDRESS")
    echo "  [$i] Created: $KEY_NAME -> ${ADDRESS:0:20}..."
done

echo ""
echo "Created ${#TEST_KEYS[@]} test accounts"
echo ""

# Phase 2: Fund accounts (with rate limiting)
echo "=== Phase 2: Funding accounts ==="
FUNDED=0
for i in "${!TEST_KEYS[@]}"; do
    KEY_NAME="${TEST_KEYS[$i]}"

    # Fund via friendbot (must use explicit params)
    stellar keys fund $KEY_NAME \
        --rpc-url "$RPC_URL" \
        --network-passphrase "$NETWORK_PASSPHRASE" 2>/dev/null

    if [ $? -eq 0 ]; then
        FUNDED=$((FUNDED + 1))
        echo "  [$((i+1))] Funded: $KEY_NAME"
    else
        echo "  [$((i+1))] Failed to fund (rate limited?)"
    fi

    # Rate limit: 1 request per 2 seconds to avoid friendbot throttling
    sleep 2
done

echo ""
echo "Funded $FUNDED accounts"
echo ""

# Phase 3: Mint SBTs and register commitments
echo "=== Phase 3: Minting SBTs and registering commitments ==="
declare -a READY_KEYS
declare -a SECRETS
declare -a SALTS
declare -a COMMITMENTS
declare -a LEAF_INDICES

for i in "${!TEST_KEYS[@]}"; do
    KEY_NAME="${TEST_KEYS[$i]}"
    ADDRESS="${TEST_ADDRESSES[$i]}"

    echo "  [$((i+1))/${#TEST_KEYS[@]}] Processing $KEY_NAME..."

    # Mint SBT (admin mints to test account)
    MINT_RESULT=$(invoke \
        --id $SBT_ID \
        -- mint \
        --dao_id $DAO_ID \
        --to $ADDRESS \
        --admin $ADMIN_ADDRESS 2>&1)

    if echo "$MINT_RESULT" | grep -qi "error"; then
        echo "    ❌ Failed to mint SBT: $(echo "$MINT_RESULT" | head -c 100)"
        continue
    fi

    # Wait for transaction to settle (futurenet RPC needs time)
    sleep 5
    echo "    ✓ SBT minted"

    # Generate identity
    COMMITMENT_DATA=$(node -e "
const { buildPoseidon } = require('circomlibjs');
const crypto = require('crypto');
(async () => {
    const poseidon = await buildPoseidon();
    const FIELD_SIZE = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
    const secret = BigInt('0x' + crypto.randomBytes(32).toString('hex')) % FIELD_SIZE;
    const salt = BigInt('0x' + crypto.randomBytes(32).toString('hex')) % FIELD_SIZE;
    const hash = poseidon([poseidon.F.e(secret), poseidon.F.e(salt)]);
    const commitment = poseidon.F.toObject(hash);
    console.log(JSON.stringify({
        secret: secret.toString(),
        salt: salt.toString(),
        commitment: commitment.toString()
    }));
})();
" 2>/dev/null)

    SECRET=$(echo $COMMITMENT_DATA | jq -r '.secret')
    SALT=$(echo $COMMITMENT_DATA | jq -r '.salt')
    COMMITMENT=$(echo $COMMITMENT_DATA | jq -r '.commitment')

    # Register commitment using self_register (member registers their own)
    REG_RESULT=$(stellar contract invoke \
        --rpc-url "$RPC_URL" \
        --network-passphrase "$NETWORK_PASSPHRASE" \
        --source "$KEY_NAME" \
        --id $TREE_ID \
        -- self_register \
        --dao_id $DAO_ID \
        --commitment $COMMITMENT \
        --member $ADDRESS 2>&1)

    if echo "$REG_RESULT" | grep -qi "error"; then
        echo "    ❌ Failed to register commitment: $(echo "$REG_RESULT" | grep -i error | head -1 | head -c 80)"
        continue
    fi

    # Wait for commitment registration to settle
    sleep 3

    # Get leaf index
    LEAF_INDEX=$(invoke \
        --id $TREE_ID \
        -- get_leaf_index \
        --dao_id $DAO_ID \
        --commitment $COMMITMENT 2>&1 | grep -E '^[0-9]+$' | tail -1)

    READY_KEYS+=("$KEY_NAME")
    SECRETS+=("$SECRET")
    SALTS+=("$SALT")
    COMMITMENTS+=("$COMMITMENT")
    LEAF_INDICES+=("$LEAF_INDEX")

    echo "    ✓ SBT minted, commitment registered (leaf $LEAF_INDEX)"

    sleep 1
done

echo ""
echo "Ready accounts: ${#READY_KEYS[@]}"
echo ""

if [ ${#READY_KEYS[@]} -eq 0 ]; then
    echo "ERROR: No accounts ready for voting"
    exit 1
fi

# Results tracking
PASSED=0
FAILED=0
START_BATCH=$(date +%s)

# Create results file
RESULTS_FILE="$PROJECT_ROOT/batch-zkproof-results-$(date +%Y%m%d-%H%M%S).json"
echo '{"results": [' > "$RESULTS_FILE"

# Phase 4: Generate proofs and vote
echo "=== Phase 4: Generating proofs and submitting votes ==="
echo ""

for i in "${!READY_KEYS[@]}"; do
    KEY_NAME="${READY_KEYS[$i]}"
    SECRET="${SECRETS[$i]}"
    SALT="${SALTS[$i]}"
    COMMITMENT="${COMMITMENTS[$i]}"
    LEAF_INDEX="${LEAF_INDICES[$i]}"

    echo "--- Vote $((i+1))/${#READY_KEYS[@]} ---"
    START_TIME=$(date +%s.%N)

    # Get current root
    ROOT=$(invoke \
        --id $TREE_ID \
        -- current_root \
        --dao_id $DAO_ID 2>&1 | grep -E '^"[0-9]+\"$' | tr -d '"')

    # Get Merkle path
    MERKLE_PATH=$(invoke \
        --id $TREE_ID \
        -- get_merkle_path \
        --dao_id $DAO_ID \
        --leaf_index $LEAF_INDEX 2>&1 | grep -E '^\[\[' | head -1)

    # Compute nullifier
    NULLIFIER=$(node -e "
const { buildPoseidon } = require('circomlibjs');
(async () => {
    const poseidon = await buildPoseidon();
    const hash = poseidon([
        poseidon.F.e(BigInt('$SECRET')),
        poseidon.F.e(BigInt($DAO_ID)),
        poseidon.F.e(BigInt($PROPOSAL_ID))
    ]);
    console.log(poseidon.F.toObject(hash).toString());
})();
" 2>/dev/null)

    # Generate proof
    TEMP_DIR=$(mktemp -d)
    VOTE_CHOICE=$((i % 2))

    node -e "
const pathData = $MERKLE_PATH;
const input = {
    root: '$ROOT',
    nullifier: '$NULLIFIER',
    daoId: '$DAO_ID',
    proposalId: '$PROPOSAL_ID',
    voteChoice: '$VOTE_CHOICE',
    commitment: '$COMMITMENT',
    secret: '$SECRET',
    salt: '$SALT',
    pathElements: pathData[0],
    pathIndices: pathData[1]
};
console.log(JSON.stringify(input));
" 2>/dev/null > "$TEMP_DIR/input.json"

    # Generate witness and proof
    PROOF_START=$(date +%s.%N)
    node "$PROJECT_ROOT/frontend/node_modules/snarkjs/build/cli.cjs" wtns calculate \
        "$CIRCUIT_DIR/vote.wasm" \
        "$TEMP_DIR/input.json" \
        "$TEMP_DIR/witness.wtns" 2>/dev/null

    node "$PROJECT_ROOT/frontend/node_modules/snarkjs/build/cli.cjs" groth16 prove \
        "$CIRCUIT_DIR/vote_final.zkey" \
        "$TEMP_DIR/witness.wtns" \
        "$TEMP_DIR/proof.json" \
        "$TEMP_DIR/public.json" 2>/dev/null
    PROOF_END=$(date +%s.%N)
    PROOF_TIME=$(echo "$PROOF_END - $PROOF_START" | bc)

    # Convert proof to Soroban format
    PROOF_SOROBAN=$(node -e "
const fs = require('fs');
const proof = JSON.parse(fs.readFileSync('$TEMP_DIR/proof.json'));
const toHexBE = (val) => BigInt(val).toString(16).padStart(64, '0');
const encodeG1 = (p) => toHexBE(p[0]) + toHexBE(p[1]);
const encodeG2 = (p) => toHexBE(p[0][1]) + toHexBE(p[0][0]) + toHexBE(p[1][1]) + toHexBE(p[1][0]);
console.log(JSON.stringify({
    a: encodeG1(proof.pi_a),
    b: encodeG2(proof.pi_b),
    c: encodeG1(proof.pi_c)
}));
" 2>/dev/null)

    # Submit vote
    VOTE_FLAG=""
    if [ $VOTE_CHOICE -eq 1 ]; then
        VOTE_FLAG="--vote_choice"
    else
        VOTE_FLAG="--vote_choice=false"
    fi

    VOTE_RESULT=$(invoke \
        --id $VOTING_ID \
        -- vote \
        --dao_id $DAO_ID \
        --proposal_id $PROPOSAL_ID \
        --nullifier $NULLIFIER \
        --root $ROOT \
        --commitment $COMMITMENT \
        $VOTE_FLAG \
        --proof "$PROOF_SOROBAN" 2>&1)

    END_TIME=$(date +%s.%N)
    ELAPSED=$(echo "$END_TIME - $START_TIME" | bc)

    # Cleanup
    rm -rf "$TEMP_DIR"

    # Check result
    if echo "$VOTE_RESULT" | grep -qi "error"; then
        echo "  ❌ FAILED (${ELAPSED}s) - $(echo "$VOTE_RESULT" | grep -i error | head -1 | head -c 80)"
        FAILED=$((FAILED+1))
        STATUS="failed"
    else
        echo "  ✅ PASSED (proof: ${PROOF_TIME}s, total: ${ELAPSED}s)"
        PASSED=$((PASSED+1))
        STATUS="passed"
    fi

    # Record result
    if [ $i -gt 0 ]; then echo "," >> "$RESULTS_FILE"; fi
    echo "{\"id\": $((i+1)), \"status\": \"$STATUS\"}" >> "$RESULTS_FILE"

    # Small delay to avoid rate limiting
    sleep 1
done

# Close results array
echo '],' >> "$RESULTS_FILE"

END_BATCH=$(date +%s)
BATCH_TIME=$((END_BATCH - START_BATCH))

# Get final vote counts
echo ""
echo "Fetching final results..."
RESULTS=$(invoke \
    --id $VOTING_ID \
    -- get_results \
    --dao_id $DAO_ID \
    --proposal_id $PROPOSAL_ID 2>&1 | grep -E '^\[' | head -1)

# Add summary to results file
echo "\"summary\": {" >> "$RESULTS_FILE"
echo "  \"total\": ${#READY_KEYS[@]}," >> "$RESULTS_FILE"
echo "  \"passed\": $PASSED," >> "$RESULTS_FILE"
echo "  \"failed\": $FAILED," >> "$RESULTS_FILE"
echo "  \"batch_time_seconds\": $BATCH_TIME," >> "$RESULTS_FILE"
echo "  \"proposal_id\": $PROPOSAL_ID," >> "$RESULTS_FILE"
echo "  \"vote_results\": \"$RESULTS\"" >> "$RESULTS_FILE"
echo "}}" >> "$RESULTS_FILE"

echo ""
echo "=== Batch Test Complete ==="
echo ""
echo "Results:"
echo "  Total: ${#READY_KEYS[@]}"
echo "  Passed: $PASSED"
echo "  Failed: $FAILED"
if [ ${#READY_KEYS[@]} -gt 0 ]; then
    echo "  Success Rate: $(echo "scale=1; $PASSED * 100 / ${#READY_KEYS[@]}" | bc)%"
fi
echo "  Total Time: ${BATCH_TIME}s"
if [ ${#READY_KEYS[@]} -gt 0 ]; then
    echo "  Avg Time/Proof: $(echo "scale=2; $BATCH_TIME / ${#READY_KEYS[@]}" | bc)s"
fi
echo ""
echo "  Proposal ID: $PROPOSAL_ID"
echo "  Vote Results: $RESULTS"
echo ""
echo "Results saved to: $RESULTS_FILE"
echo ""

# Cleanup test keys (optional - uncomment to remove after test)
# echo "Cleaning up test keys..."
# for KEY_NAME in "${TEST_KEYS[@]}"; do
#     stellar keys rm $KEY_NAME 2>/dev/null || true
# done
