#!/bin/bash
# Stress test: 100 members voting on a single proposal
# This script creates 100 members, registers their commitments, and votes
#
# Usage: ./stress-test-100.sh [phase]
# Phases:
#   1 - Create and fund accounts (already done if stress-accounts/ exists)
#   2 - Join DAO (self_join for open membership)
#   3 - Register commitments
#   4 - Create proposal and vote

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Contract IDs
REGISTRY_ID="CB6CH7UNQSEZ2R5EZSHLFLZBX4X7OWF2FVVWX23MY2BG66V75TAFUE7O"
SBT_ID="CDVDFULVS6MT3WIE7ITCIXPZ7FYBDF2RQBXBUBQMQJH6WA6KFPKF7TFN"
TREE_ID="CC2GRLKCBCRNAUKKVHKJBJPVKTMZ5YY2DXN67HZGRC5D67MN6Y6VQ7ZX"
VOTING_ID="CALJTLBN6GMXT2XKBRWZG7STMQU5FUBRWGFHLXXDTZLG5MESLIXIIZ5O"

# Network
RPC_URL="https://rpc-futurenet.stellar.org"
NETWORK_PASSPHRASE="Test SDF Future Network ; October 2022"

# Relayer
RELAYER_URL="http://localhost:3001"
AUTH_TOKEN="f12868935d8ca4f4e275b8dbb842d6c4b4fb88d7e4527e43758e35db4f5f5ea4"

# State files
STATE_DIR="$SCRIPT_DIR/stress-accounts"
ACCOUNTS_FILE="$STATE_DIR/accounts.csv"
COMMITMENTS_FILE="$STATE_DIR/commitments.csv"
JOINED_FILE="$STATE_DIR/joined.txt"
REGISTERED_FILE="$STATE_DIR/registered.txt"
VOTED_FILE="$STATE_DIR/voted.txt"

# Config
NUM_ACCOUNTS=100
DAO_ID=1
PARALLEL_BATCH=5  # Number of parallel operations
RETRY_DELAY=3     # Seconds between retries

export NODE_PATH="$PROJECT_ROOT/frontend/node_modules"

# Helper: invoke contract
invoke() {
    stellar contract invoke \
        --rpc-url "$RPC_URL" \
        --network-passphrase "$NETWORK_PASSPHRASE" \
        "$@"
}

# Helper: invoke with retries
invoke_retry() {
    local max_retries=3
    local retry=0
    while [ $retry -lt $max_retries ]; do
        if invoke "$@" 2>&1; then
            return 0
        fi
        retry=$((retry + 1))
        echo "  Retry $retry/$max_retries..." >&2
        sleep $RETRY_DELAY
    done
    return 1
}

# Phase 1: Create and fund accounts
phase1_accounts() {
    echo "=== Phase 1: Create and fund accounts ==="

    if [ -f "$ACCOUNTS_FILE" ] && [ $(wc -l < "$ACCOUNTS_FILE") -ge $NUM_ACCOUNTS ]; then
        echo "Accounts already created ($(wc -l < "$ACCOUNTS_FILE") accounts)"
        return 0
    fi

    mkdir -p "$STATE_DIR"
    > "$ACCOUNTS_FILE"  # Clear file

    echo "Creating $NUM_ACCOUNTS accounts..."
    for i in $(seq 1 $NUM_ACCOUNTS); do
        KEY="stresstest-$i"
        stellar keys generate "$KEY" 2>/dev/null || true
        ADDR=$(stellar keys address "$KEY" 2>/dev/null)
        SECRET=$(stellar keys show "$KEY" 2>/dev/null)
        echo "$KEY,$ADDR,$SECRET" >> "$ACCOUNTS_FILE"
        echo -ne "Created $i/$NUM_ACCOUNTS\r"
    done
    echo ""

    echo "Funding accounts in batches of 10..."
    for batch in $(seq 0 9); do
        START_IDX=$((batch * 10 + 1))
        END_IDX=$((batch * 10 + 10))
        echo "  Batch $((batch + 1))/10 (accounts $START_IDX-$END_IDX)..."

        for i in $(seq $START_IDX $END_IDX); do
            KEY="stresstest-$i"
            stellar keys fund "$KEY" --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE" 2>/dev/null &
        done
        wait
        sleep 1  # Small delay between batches
    done

    echo "Phase 1 complete: $NUM_ACCOUNTS accounts created and funded"
}

# Phase 2: Join DAO (self_join - each account signs their own tx)
phase2_join() {
    echo "=== Phase 2: Join DAO ==="

    touch "$JOINED_FILE"
    JOINED=$(wc -l < "$JOINED_FILE" | tr -d ' ')

    if [ "$JOINED" -ge "$NUM_ACCOUNTS" ]; then
        echo "All accounts already joined DAO"
        return 0
    fi

    echo "Joining DAO for accounts (starting from $((JOINED + 1)))..."

    for i in $(seq $((JOINED + 1)) $NUM_ACCOUNTS); do
        KEY="stresstest-$i"
        ADDR=$(stellar keys address "$KEY" 2>/dev/null)
        echo -n "  $i: "

        RESULT=$(invoke --source "$KEY" --id "$SBT_ID" \
            -- self_join --dao_id $DAO_ID --member "$ADDR" 2>&1)

        if echo "$RESULT" | grep -q "Success\|already"; then
            echo "$i" >> "$JOINED_FILE"
            echo "OK"
        else
            echo "FAIL ($(echo "$RESULT" | tail -1 | cut -c1-50))"
            # Don't exit, continue with next
        fi

        # Small delay to avoid sequence number issues (different accounts so minimal)
        sleep 0.5
    done

    JOINED=$(wc -l < "$JOINED_FILE" | tr -d ' ')
    echo "Phase 2 complete: $JOINED accounts joined DAO"
}

# Phase 3: Register commitments (each account signs their own tx)
phase3_commitments() {
    echo "=== Phase 3: Register commitments ==="

    touch "$COMMITMENTS_FILE"
    touch "$REGISTERED_FILE"

    REGISTERED=$(wc -l < "$REGISTERED_FILE" | tr -d ' ')

    if [ "$REGISTERED" -ge "$NUM_ACCOUNTS" ]; then
        echo "All commitments already registered"
        return 0
    fi

    echo "Registering commitments (starting from $((REGISTERED + 1)))..."

    for i in $(seq $((REGISTERED + 1)) $NUM_ACCOUNTS); do
        KEY="stresstest-$i"
        ADDR=$(stellar keys address "$KEY" 2>/dev/null)
        echo -n "  $i: "

        # Generate commitment
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

        SECRET=$(echo "$COMMITMENT_DATA" | jq -r '.secret')
        SALT=$(echo "$COMMITMENT_DATA" | jq -r '.salt')
        COMMITMENT=$(echo "$COMMITMENT_DATA" | jq -r '.commitment')

        # Register
        RESULT=$(invoke --source "$KEY" --id "$TREE_ID" \
            -- self_register --dao_id $DAO_ID --commitment "$COMMITMENT" --member "$ADDR" 2>&1)

        if echo "$RESULT" | grep -q "Success"; then
            echo "$KEY,$SECRET,$SALT,$COMMITMENT" >> "$COMMITMENTS_FILE"
            echo "$i" >> "$REGISTERED_FILE"
            echo "OK"
        else
            echo "FAIL"
        fi

        sleep 0.5
    done

    REGISTERED=$(wc -l < "$REGISTERED_FILE" | tr -d ' ')
    echo "Phase 3 complete: $REGISTERED commitments registered"
}

# Phase 4: Create proposal and vote
phase4_vote() {
    echo "=== Phase 4: Create proposal and vote ==="

    # Get current root
    ROOT=$(invoke --source mykey --id "$TREE_ID" -- get_root --dao_id $DAO_ID 2>&1 | grep -E '^"[0-9]+"$' | tr -d '"')
    echo "Current Merkle root: ${ROOT:0:30}..."

    # Create proposal
    END_TIME=$(($(date +%s) + 86400))
    PROPOSAL_ID=$(invoke --source mykey --id "$VOTING_ID" \
        -- create_proposal \
        --dao_id $DAO_ID \
        --title '"100 Member Stress Test"' \
        --content_cid '"stress-test-100"' \
        --end_time $END_TIME \
        --vote_mode '"Trailing"' \
        --creator "$(stellar keys address mykey)" 2>&1 | grep -E '^[0-9]+$' | tail -1)

    echo "Created proposal ID: $PROPOSAL_ID"

    touch "$VOTED_FILE"
    VOTED=$(wc -l < "$VOTED_FILE" | tr -d ' ')

    echo "Voting (starting from $((VOTED + 1)))..."

    START_TIME=$(date +%s.%N)
    SUCCESS=0
    FAIL=0

    while IFS=, read -r KEY SECRET SALT COMMITMENT; do
        IDX=$(echo "$KEY" | sed 's/stresstest-//')

        if [ "$IDX" -le "$VOTED" ]; then
            continue
        fi

        echo -n "  $IDX: "

        # Get leaf index and merkle path
        LEAF_INDEX=$(invoke --source mykey --id "$TREE_ID" \
            -- get_leaf_index --dao_id $DAO_ID --commitment "$COMMITMENT" 2>&1 | grep -E '^[0-9]+$' | tail -1)

        if [ -z "$LEAF_INDEX" ]; then
            echo "FAIL (no leaf index)"
            FAIL=$((FAIL + 1))
            continue
        fi

        MERKLE_PATH=$(invoke --source mykey --id "$TREE_ID" \
            -- get_merkle_path --dao_id $DAO_ID --leaf_index "$LEAF_INDEX" 2>&1 | grep -E '^\[\[' | head -1)

        # Get current root for this vote
        CURRENT_ROOT=$(invoke --source mykey --id "$TREE_ID" -- get_root --dao_id $DAO_ID 2>&1 | grep -E '^"[0-9]+"$' | tr -d '"')

        # Generate proof (using node script)
        # ... (simplified - in practice, generate full proof here)

        echo "SKIP (proof generation needed)"

    done < "$COMMITMENTS_FILE"

    END_TIME=$(date +%s.%N)
    DURATION=$(echo "$END_TIME - $START_TIME" | bc)

    echo ""
    echo "Phase 4 complete: $SUCCESS votes, $FAIL failures in ${DURATION}s"
}

# Main
PHASE="${1:-all}"

case "$PHASE" in
    1) phase1_accounts ;;
    2) phase2_join ;;
    3) phase3_commitments ;;
    4) phase4_vote ;;
    all)
        phase1_accounts
        phase2_join
        phase3_commitments
        phase4_vote
        ;;
    *)
        echo "Usage: $0 [1|2|3|4|all]"
        exit 1
        ;;
esac
