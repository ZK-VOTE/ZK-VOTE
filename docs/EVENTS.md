# Smart Contract Events

This document describes all Soroban events emitted by ZK-VOTE smart contracts. Events are published on-chain and can be indexed and consumed by off-chain consumers (relayers, indexers, frontends).

## Event Structure

Each event is defined with the `#[soroban_sdk::contractevent]` macro. Fields marked with `#[topic]` are indexed and can be efficiently queried. All types use Soroban's standard serialization.

## DAO Registry Contract Events

### `DaoCreateEvent`
Emitted when a new DAO is created.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | Unique identifier for the DAO |
| `admin` | Address | | Initial admin/creator address |
| `name` | String | | DAO name |

**Example Use Case**: Indexers track all DAOs created on the platform; frontends display creation events.

### `AdminXferEvent`
Emitted when DAO admin privileges are transferred.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | DAO identifier |
| `from` | Address | ✓ | Previous admin |
| `to` | Address | | New admin address |

---

### `CircuitUpgradeProposedEvent`
Emitted when a circuit upgrade is proposed for a DAO.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | DAO identifier |
| `from_circuit_id` | String | | Current circuit ID |
| `to_circuit_id` | String | | New circuit ID |
| `deadline` | u64 | | Upgrade deadline (ledger timestamp) |

### `CircuitUpgradeApprovedEvent`
Emitted when a circuit upgrade is approved by DAO vote.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | DAO identifier |
| `proposal_id` | u64 | ✓ | Upgrade proposal ID |

---

## Membership SBT Contract Events

### `SbtMintEvent`
Emitted when an SBT membership token is minted (user joins DAO).

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | DAO identifier |
| `to` | Address | | New member address |

### `SbtRevokeEvent`
Emitted when an SBT membership is revoked (user expelled by admin).

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | DAO identifier |
| `member` | Address | | Member address with revoked SBT |

### `SbtLeaveEvent`
Emitted when a user voluntarily leaves a DAO.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | DAO identifier |
| `member` | Address | | Member address leaving |

### `ContractUpgraded`
Emitted when the membership SBT contract code is upgraded.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `from` | u32 | | Previous contract version |
| `to` | u32 | | New contract version |

---

## Membership Tree Contract Events

### `TreeInitEvent`
Emitted when a Poseidon Merkle tree is initialized for a DAO.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | DAO identifier |
| `depth` | u32 | | Tree depth (max 32) |
| `empty_root` | U256 | | Empty root hash |
| `root_index` | u32 | | Current root index in history |

### `CommitEvent`
Emitted when a new leaf commitment is added to the tree.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | DAO identifier |
| `commitment` | U256 | | Leaf commitment hash |
| `index` | u32 | | Position in tree |
| `new_root` | U256 | | Updated tree root |
| `root_index` | u32 | | Root history index |

### `RemovalEvent`
Emitted when a leaf is removed (user evicted or left DAO).

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | DAO identifier |
| `member` | Address | ✓ | Member being removed |
| `index` | u32 | | Leaf index |
| `new_root` | U256 | | Updated tree root |
| `root_index` | u32 | | Root history index |

### `RootRolledOverEvent`
Emitted when tree root changes (periodic rollover).

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | DAO identifier |
| `new_root` | U256 | | New root hash |
| `root_index` | u32 | | Root history index |
| `height` | u32 | | Tree height after change |

---

## Voting Contract Events

### `ProposalEvent`
Emitted when a new proposal is created.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | DAO identifier |
| `proposal_id` | u64 | | Unique proposal ID |
| `creator` | Address | | Proposal creator |
| `start_time` | u64 | | Voting start (ledger timestamp) |
| `end_time` | u64 | | Voting end (ledger timestamp) |
| `vk_version` | u32 | | Verification key version used |

### `VoteEvent`
Emitted when a vote is cast.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | DAO identifier |
| `proposal_id` | u64 | ✓ | Proposal being voted on |
| `choice` | bool | | Vote choice (true/false) |
| `nullifier` | U256 | | Voter nullifier (prevents double voting) |

**Note**: Nullifier ensures anonymity while preventing duplicate votes. The voter's identity is not revealed on-chain.

### `ProposalClosedEvent`
Emitted when voting closes (end time reached or early close).

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | DAO identifier |
| `proposal_id` | u64 | | Proposal closed |
| `votes_for` | u64 | | Final "yes" vote count |
| `votes_against` | u64 | | Final "no" vote count |

### `ProposalArchivedEvent`
Emitted when a closed proposal is archived.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | DAO identifier |
| `proposal_id` | u64 | | Proposal archived |

### `VKSetEvent`
Emitted when a new verification key is registered.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `vk_version` | u32 | ✓ | VK version number |
| `circuit_type` | CircuitType | | Circuit type (e.g., Groth16) |

---

## Comments Contract Events

### `CommentCreatedEvent`
Emitted when a new comment is posted.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | DAO identifier |
| `proposal_id` | u64 | ✓ | Associated proposal |
| `comment_id` | u64 | | Unique comment ID |
| `is_anonymous` | bool | | Anonymous flag |

### `CommentEditedEvent`
Emitted when a comment is edited.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | DAO identifier |
| `proposal_id` | u64 | ✓ | Associated proposal |
| `comment_id` | u64 | | Comment edited |

### `CommentDeletedEvent`
Emitted when a comment is deleted.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | DAO identifier |
| `proposal_id` | u64 | ✓ | Associated proposal |
| `comment_id` | u64 | | Comment deleted |
| `deleted_by` | u32 | | Reason (admin/author/auto) |

---

## Circuit Registry Contract Events

### `CircuitRegisteredEvent`
Emitted when a new ZK circuit is registered.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `circuit_id` | String | ✓ | Unique circuit identifier |
| `circuit_type` | CircuitType | | Circuit type (Groth16/etc) |
| `registered_at` | u64 | | Registration timestamp |

### `DaoMigrationEvent`
Emitted when a DAO migrates to a new circuit.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | DAO migrating |
| `from_circuit_id` | String | | Old circuit |
| `to_circuit_id` | String | | New circuit |
| `deadline` | u64 | | Migration deadline |

### `CircuitUpgradedEvent`
Emitted when a DAO successfully upgrades its circuit.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `dao_id` | u64 | ✓ | DAO upgraded |
| `circuit_type` | CircuitType | | Circuit type after upgrade |
| `to_circuit_id` | String | | New circuit ID |

### `VkProposalApprovedEvent`
Emitted when an approver votes to approve a pending VK upgrade proposal.
Previously undocumented — added by SPIKE-053 / issue #733 audit.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `proposal_id` | u32 | ✓ | VK upgrade proposal identifier |
| `approver` | Address | | Address that approved |
| `current_approvals` | u32 | | Number of approvals so far |
| `required_approvals` | u32 | | Threshold required to execute |

### `VkProposalExecutedEvent`
Emitted when a VK upgrade proposal reaches threshold and is executed.
Previously undocumented — added by SPIKE-053 / issue #733 audit.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `proposal_id` | u32 | ✓ | VK upgrade proposal identifier |
| `circuit_id` | String | | Circuit identifier of the new VK |
| `circuit_type` | CircuitType | | Circuit type of the new VK |

### `VkProposalCancelledEvent`
Emitted when a VK upgrade proposal is cancelled by an authorized address.
Previously undocumented — added by SPIKE-053 / issue #733 audit.

| Field | Type | Topic | Description |
|-------|------|-------|-------------|
| `proposal_id` | u32 | ✓ | VK upgrade proposal identifier |
| `cancelled_by` | Address | | Address that cancelled the proposal |

---

## Event Schema Versioning Policy (SPIKE-053 / issue #733)

Contract events are consumed by the backend indexer (`backend/src/services/indexer.ts`)
and reflected in TypeScript types (`backend/src/generated/contract-events.ts`).
Without versioned envelopes, an additive field silently shifts positional parsing
and can corrupt tallies.

### Rules (v1 — effective from this document revision)

1. **Additive-only**: new fields may be appended to existing event structs; no
   field may be removed or reordered without bumping the event schema version.
2. **Version documentation**: when a field is added to an existing event, a
   `_schema_version` note must be added to its table in this document and the
   corresponding TypeScript consumer type must be updated in the same PR.
3. **Indexer tolerance**: the backend indexer MUST use lenient positional
   parsing (ignore unknown trailing fields) so a new-version event ingests
   cleanly through an old indexer without crashing.
4. **Breaking changes** (field removal / reorder): require a dual-version
   ingestion window — emit both old and new shapes for at least one release
   cycle before removing the old shape.
5. **CI gate**: `EVENTS.md` is the source of truth. A CI check (`.github/workflows/`)
   must fail if a contract emits an event not listed in this document.

### Events added after initial release

| Event | Added in | Fields added |
|-------|----------|--------------|
| `VkProposalApprovedEvent` | SPIKE-053 | initial documentation |
| `VkProposalExecutedEvent` | SPIKE-053 | initial documentation |
| `VkProposalCancelledEvent` | SPIKE-053 | initial documentation |

---

## Bridge relayer: EVM → Soroban (ZV-038 / #887)

### `VoteForwarded` (Bridge.sol, EVM)

Emitted by `Bridge.castVote` once a Groth16 proof verifies. It is the only event the relayer reads.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `daoId` | uint256 | ✓ | DAO identifier |
| `proposalId` | uint256 | ✓ | Proposal identifier |
| `nullifier` | uint256 | | Vote nullifier (relayed as `U256`) |
| `voteChoice` | uint256 | | 0 = against, 1 = for |
| `voteRoot` | uint256 | | Anchored vote root the proof was checked against |
| `memberAddr` | uint256 | | Field-encoded Stellar member address (not relayed) |
| `chainId` | uint256 | | EVM chain id bound into the proof (#649) |

The relayer filters on topic `0xfdfc70c1…16ef` and reads the views `getSbtRoot`, `getVoteRoot` and `sbtRootBlock`. `contracts/bridge/evm/test/RelayerAbi.test.js` pins these constants to the compiled ABI.

### Finality and reorgs

1. **Confirmations.** The relayer reads only blocks at least `BRIDGE_EVM_CONFIRMATIONS` deep (default 12). Choose it for the chain's finality: 12 suits Ethereum mainnet probabilistic finality; use 64 or more for "finalized" semantics, and 0 only on a local dev chain.
2. **Checkpoint.** After each scan the last block's number and hash are stored (`bridge_relay_checkpoints`). Scanning resumes there after a restart.
3. **Reorg detection.** If the chain's hash at the checkpoint height no longer matches, a reorg deeper than the confirmation depth happened. The relayer rewinds by twice the confirmation depth and rescans:
   - votes from the orphaned blocks that were not yet relayed become `rolled_back`; if the vote reappears on the canonical chain it returns to `pending` and is relayed once;
   - a vote already relayed becomes `orphaned` and is logged at error level (`bridge_evm_reorg`). It is never relayed again; an operator decides whether the Soroban side needs action. If it reappears on the canonical chain it returns to `relayed`.
4. **Exactly once.** Votes are keyed by (DAO, proposal, nullifier), the same key the Soroban bridge uses, so no vote is relayed twice.

### Status

Each vote has a status: `pending`, `relayed` (with the Stellar transaction hash), `failed` (after `BRIDGE_RELAY_MAX_ATTEMPTS`), `rolled_back` or `orphaned`.

| Route | Purpose |
|---|---|
| `GET /bridge/relay/status` | Checkpoint and per-status counts |
| `GET /bridge/relay/:daoId/:proposalId/:nullifier` | One vote's status and hashes |
| `POST /bridge/relay` (auth) | Run one relay pass now |
| `GET /bridge/roots/:daoId/:proposalId` | Roots anchored on Bridge.sol; the bridge panel shows and submits these |

Configuration: `BRIDGE_EVM_RPC_URL`, `BRIDGE_EVM_CONTRACT_ADDRESS`, `BRIDGE_EVM_CONFIRMATIONS`, `BRIDGE_EVM_START_BLOCK`, `BRIDGE_EVM_MAX_BLOCK_RANGE` and `BRIDGE_RELAY_MAX_ATTEMPTS`. The relay loop runs only when the RPC URL and contract address are set.

## Notification delivery (ZV-037 / #886)

Some events are also delivered to people who asked for them, by email or browser push. This is opt-in and anonymous.

### Events

| Notification | Source |
|---|---|
| `election_started` | `ProposalEvent` (indexed as `proposal_created`) |
| `election_ended` | `ProposalClosedEvent` (indexed as `proposal_closed`) |
| `dispute_outcome` | A dispute case resolved by the second reviewer of a payment hold |

Only named, non-identifying fields reach a notification: the DAO id, the proposal id and its closing time, and a dispute's resolution text. Creator addresses, nullifiers and vote choices are never copied.

### Preferences and privacy

- `POST /api/v1/notifications/subscriptions` with `{ channel, destination, eventTypes?, daoIds? }` returns a random contact token. The token is the only handle on the subscription: it is not linked to a wallet, a membership or a vote.
- `GET`/`PATCH`/`DELETE /api/v1/notifications/subscriptions/:token` reads, changes (and renews) or removes it. `GET /api/v1/notifications/channels` lists the configured channels and the VAPID public key.
- Every email carries a one-click unsubscribe link (`/api/v1/notifications/unsubscribe?token=…`) and `List-Unsubscribe` / `List-Unsubscribe-Post` headers.
- Subscriptions expire after `NOTIFY_SUBSCRIPTION_TTL_DAYS` (default 180) unless renewed; expired rows are skipped and purged hourly. A push subscription the push service reports gone (404/410) is removed.
- Templates HTML-escape user content and redact every Stellar account, muxed or contract address, so no wallet address appears in a message.

### Delivery

Publishing an event writes one job per matching destination into the durable `jobs` outbox (ZV-069) and returns. A worker drains it in batches of `NOTIFY_BATCH_SIZE`. Delivery does not depend on the SSE stream or any open connection, and survives restarts. The business key (event id, channel, destination hash) means a re-indexed event or a duplicate subscription is delivered once.

Provider failures are retried with exponential back-off. After `NOTIFY_MAX_ATTEMPTS` the job moves to the dead-letter state (`status = 'dead'`).

| Metric | Labels |
|---|---|
| `zkvote_notification_deliveries_total` | `channel`, `result` (`sent`, `retry`, `gone`, `skipped`) |
| `zkvote_notification_dead_letter_total` | `channel` |

### Providers

| Channel | Provider | Configuration |
|---|---|---|
| `email` | HTTP relay: the message is POSTed as JSON (`from`, `to`, `subject`, `text`, `html`, `headers`) | `NOTIFY_EMAIL_RELAY_URL`, `NOTIFY_EMAIL_RELAY_TOKEN`, `NOTIFY_EMAIL_FROM` |
| `webpush` | RFC 8291 payload encryption (`aes128gcm`) and RFC 8292 VAPID | `NOTIFY_VAPID_PUBLIC_KEY`, `NOTIFY_VAPID_PRIVATE_KEY`, `NOTIFY_VAPID_SUBJECT` |

An unconfigured channel is not offered. Other providers plug in with `registerProvider()` from `backend/src/services/notifications`. `generateVapidKeys()` there creates a VAPID key pair. `NOTIFY_PUBLIC_URL` sets the base of the links in messages.

## Indexing Guide

To efficiently consume these events:

1. **Use topic indices**: Filter by `dao_id` and other `#[topic]` fields for efficient queries
2. **Monitor proposal lifecycle**: Track `ProposalEvent` → votes → `ProposalClosedEvent` → `ProposalArchivedEvent`
3. **Verify membership**: Cross-reference `CommitEvent` (tree updates) with `SbtMintEvent` (membership)
4. **Nullifier validation**: Ensure votes have unique nullifiers (stored in events)

## TypeScript Consumer Types

Auto-generated TypeScript types for these events are available in `backend/src/generated/contract-events.ts`.
