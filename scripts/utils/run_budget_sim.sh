#!/bin/bash
set -euo pipefail

# Simulate budget usage for core entrypoints against built WASM.
# Requires: soroban CLI configured to hit desired network/rpc (e.g., standalone/futurenet local)
#
# Usage:
#   scripts/run_budget_sim.sh <voting_wasm> <registry_wasm> <sbt_wasm> <tree_wasm>
# Defaults to target/wasm32v1-none/release/*.wasm if not provided.

VOTING_WASM=${1:-target/wasm32v1-none/release/voting.wasm}
REGISTRY_WASM=${2:-target/wasm32v1-none/release/dao_registry.wasm}
SBT_WASM=${3:-target/wasm32v1-none/release/membership_sbt.wasm}
TREE_WASM=${4:-target/wasm32v1-none/release/membership_tree.wasm}

if [[ -z "${STELLAR_NETWORK_PASSPHRASE:-}" || -z "${STELLAR_RPC_URL:-}" ]]; then
  echo "❌ Set STELLAR_NETWORK_PASSPHRASE and STELLAR_RPC_URL before running (e.g., futurenet passphrase + rpc)"
  exit 1
fi

SOURCE=${SOURCE:-}
if [[ -z "$SOURCE" ]]; then
  echo "❌ Set SOURCE to a funded key name (stellar keys list) for contract deploys"
  exit 1
fi

echo "Simulating budget for set_vk/create_proposal/vote"
echo "Voting WASM:   $VOTING_WASM"
echo "Registry WASM: $REGISTRY_WASM"
echo "SBT WASM:      $SBT_WASM"
echo "Tree WASM:     $TREE_WASM"
echo

echo "Deploying temporary contracts (simulation mode)..."
REG_ID=$(soroban contract deploy --source-account "$SOURCE" --wasm "$REGISTRY_WASM" --rpc-url "$STELLAR_RPC_URL" --network-passphrase "$STELLAR_NETWORK_PASSPHRASE")
SBT_ID=$(soroban contract deploy --source-account "$SOURCE" --wasm "$SBT_WASM" --rpc-url "$STELLAR_RPC_URL" --network-passphrase "$STELLAR_NETWORK_PASSPHRASE" -- --registry "$REG_ID")
TREE_ID=$(soroban contract deploy --source-account "$SOURCE" --wasm "$TREE_WASM" --rpc-url "$STELLAR_RPC_URL" --network-passphrase "$STELLAR_NETWORK_PASSPHRASE" -- --sbt "$SBT_ID")
VOTING_ID=$(soroban contract deploy --source-account "$SOURCE" --wasm "$VOTING_WASM" --rpc-url "$STELLAR_RPC_URL" --network-passphrase "$STELLAR_NETWORK_PASSPHRASE" -- --tree "$TREE_ID")

echo "Registry: $REG_ID"
echo "SBT:      $SBT_ID"
echo "Tree:     $TREE_ID"
echo "Voting:   $VOTING_ID"

# Admin address (random)
ADMIN=$(soroban keys generate --no-fund --json | jq -r .public)

# Create DAO
DAO_ID=$(soroban contract invoke --id "$REG_ID" -- simulate -- create_dao --name "Budget DAO" --admin "$ADMIN" --membership_open false --members_can_propose true | jq -r .return)
echo "DAO_ID: $DAO_ID"

# Init tree
soroban contract invoke --id "$TREE_ID" -- simulate -- init_tree --dao_id "$DAO_ID" --depth 18 --admin "$ADMIN" > /dev/null

# Mint SBT to admin
soroban contract invoke --id "$SBT_ID" -- simulate -- mint --dao_id "$DAO_ID" --to "$ADMIN" --admin "$ADMIN" --commitment null > /dev/null

# Set VK (use dummy G1/G2 generators encoded in hex; adjust to real VK if needed)
DUMMY_G1=00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002
DUMMY_G2=1800506a061286eb6a84a5730b8f10293e29816cd1913d5338f715de3e98f9ad1983904211a53f6e0b0853a90a00efbff1700c7b1dc006324d859d75e3caa5a212c85ea5db8c6deb4aab718e806a51a56608214c3f628b962cf191eacdc80e7a090d97c09ce1486063b359f3dd89b7c43c5f18958fb3e6b96db55e19a3b7c0fb
IC_JSON=$(cat <<EOF
[
  "$DUMMY_G1","$DUMMY_G1","$DUMMY_G1","$DUMMY_G1",
  "$DUMMY_G1","$DUMMY_G1","$DUMMY_G1","$DUMMY_G1"
]
EOF
)
VK_JSON=$(cat <<EOF
{"alpha":"$DUMMY_G1","beta":"$DUMMY_G2","gamma":"$DUMMY_G2","delta":"$DUMMY_G2","ic":$IC_JSON}
EOF
)

echo "Simulating set_vk..."
soroban contract invoke --id "$VOTING_ID" -- simulate -- set_vk --dao_id "$DAO_ID" --vk "$VK_JSON" --admin "$ADMIN" | jq .

echo "Simulating create_proposal..."
PROP_ID=$(soroban contract invoke --id "$VOTING_ID" -- simulate -- create_proposal --dao_id "$DAO_ID" --description "Budget Test" --end_time 0 --creator "$ADMIN" --vote_mode Fixed | jq -r .return)
echo "PROP_ID: $PROP_ID"

# Vote simulation with dummy proof/public signals
ROOT=12345
NULLIFIER=99999
COMMITMENT=77777
PROOF_JSON=$(cat <<EOF
{"a":"$DUMMY_G1","b":"$DUMMY_G2","c":"$DUMMY_G1"}
EOF
)
echo "Simulating vote..."
soroban contract invoke --id "$VOTING_ID" -- simulate -- vote --dao_id "$DAO_ID" --proposal_id "$PROP_ID" --vote_choice true --nullifier "$NULLIFIER" --root "$ROOT" --commitment "$COMMITMENT" --proof "$PROOF_JSON" | jq .

echo "Done. Extract CPU/mem from the simulation outputs above and update tests/integration/tests/budget_smoke.rs thresholds."
