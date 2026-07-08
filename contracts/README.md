# ZKVote Contract Interfaces

This document describes the public API for all ZKVote smart contracts deployed on Stellar Soroban.

## Table of Contents
1. [DAO Registry Contract](#dao-registry-contract)
2. [Membership SBT Contract](#membership-sbt-contract)
3. [Membership Tree Contract](#membership-tree-contract)
4. [Voting Contract](#voting-contract)
5. [Comments Contract](#comments-contract)
6. [Type Definitions](#type-definitions)

---

## DAO Registry Contract

**Path:** `dao-registry/src/lib.rs`

Permissionless DAO creation and admin management.

### Functions

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `create_dao` | `name: String`, `creator: Address`, `membership_open: bool`, `members_can_propose: bool`, `metadata_cid: Option<String>` | `u64` | Creates a new DAO. Creator becomes admin. |
| `get_dao` | `dao_id: u64` | `DaoInfo` | Retrieves complete DAO information. |
| `dao_exists` | `dao_id: u64` | `bool` | Checks if a DAO exists. |
| `get_admin` | `dao_id: u64` | `Address` | Gets the current admin of a DAO. |
| `transfer_admin` | `dao_id: u64`, `new_admin: Address` | - | Transfers admin rights. Admin only. |
| `dao_count` | - | `u64` | Returns total number of DAOs. |
| `is_membership_open` | `dao_id: u64` | `bool` | Checks if DAO has open membership. |
| `members_can_propose` | `dao_id: u64` | `bool` | Checks if members can create proposals. |
| `set_proposal_mode` | `dao_id: u64`, `members_can_propose: bool`, `admin: Address` | - | Sets proposal permissions. Admin only. |
| `set_membership_open` | `dao_id: u64`, `membership_open: bool`, `admin: Address` | - | Opens/closes membership. Admin only. |
| `set_name` | `dao_id: u64`, `name: String`, `admin: Address` | - | Updates DAO name (max 24 chars). Admin only. |
| `set_metadata_cid` | `dao_id: u64`, `metadata_cid: Option<String>`, `admin: Address` | - | Sets/clears metadata CID. Admin only. |
| `get_metadata_cid` | `dao_id: u64` | `Option<String>` | Retrieves DAO metadata CID. |
| `create_and_init_dao` | `name`, `creator`, `membership_open`, `members_can_propose`, `sbt_contract`, `tree_contract`, `voting_contract`, `tree_depth`, `creator_commitment`, `vk` | `u64` | Atomically creates DAO and initializes all contracts. |
| `version` | - | `u32` | Returns contract version. |

---

## Membership SBT Contract

**Path:** `membership-sbt/src/lib.rs`

Soulbound NFT membership tokens (non-transferable).

### Constructor

```rust
__constructor(env: Env, registry: Address)
```

Initializes with DAO Registry address. Called during deployment.

### Functions

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `mint` | `dao_id: u64`, `to: Address`, `admin: Address`, `encrypted_alias: Option<String>` | - | Mints SBT to member. Admin only. |
| `has` | `dao_id: u64`, `of: Address` | `bool` | Checks if address has active SBT for a DAO. |
| `registry` | - | `Address` | Returns DAO Registry address. |
| `get_alias` | `dao_id: u64`, `member: Address` | `Option<String>` | Retrieves encrypted alias for member. |
| `revoke` | `dao_id: u64`, `member: Address`, `admin: Address` | - | Revokes an SBT. Admin only. |
| `leave` | `dao_id: u64`, `member: Address` | - | Member voluntarily leaves DAO. |
| `self_join` | `dao_id: u64`, `member: Address`, `encrypted_alias: Option<String>` | - | Self-mints SBT for open DAOs. |
| `update_alias` | `dao_id: u64`, `member: Address`, `admin: Address`, `new_encrypted_alias: String` | - | Updates member alias. Admin only. |
| `get_member_count` | `dao_id: u64` | `u64` | Returns total member count. |
| `get_member_at_index` | `dao_id: u64`, `index: u64` | `Option<Address>` | Gets member at enumeration index. |
| `get_members` | `dao_id: u64`, `offset: u64`, `limit: u64` | `Vec<Address>` | Returns paginated member list. |
| `version` | - | `u32` | Returns contract version. |

---

## Membership Tree Contract

**Path:** `membership-tree/src/lib.rs`

On-chain Poseidon Merkle tree for ZK membership proofs (BN254 curve).

### Constructor

```rust
__constructor(env: Env, sbt_contract: Address)
```

Initializes with SBT contract and pre-computes zeros cache.

### Functions

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `init_tree` | `dao_id: u64`, `depth: u32`, `admin: Address` | - | Initializes Merkle tree (depth 1-18). Admin only. |
| `register_with_caller` | `dao_id: u64`, `commitment: U256`, `caller: Address` | - | Registers ZK commitment. Requires SBT. |
| `self_register` | `dao_id: u64`, `commitment: U256`, `member: Address` | - | Registers for open DAOs. Requires SBT. |
| `current_root` | `dao_id: u64` | `U256` | Gets current Merkle root. |
| `get_root` | `dao_id: u64` | `U256` | Alias for `current_root`. |
| `root_ok` | `dao_id: u64`, `root: U256` | `bool` | Checks if root is valid (in history). |
| `root_idx` | `dao_id: u64`, `root: U256` | `u32` | Gets root's index in history. |
| `curr_idx` | `dao_id: u64` | `u32` | Gets current root's index. |
| `get_leaf_index` | `dao_id: u64`, `commitment: U256` | `u32` | Gets leaf index for commitment. |
| `get_tree_info` | `dao_id: u64` | `(u32, u32, U256)` | Returns (depth, next_index, root). |
| `get_merkle_path` | `dao_id: u64`, `leaf_index: u32` | `(Vec<U256>, Vec<u32>)` | Computes Merkle proof path. |
| `sbt_contr` | - | `Address` | Returns SBT contract address. |
| `remove_member` | `dao_id: u64`, `member: Address`, `admin: Address` | - | Records revocation timestamp. Admin only. |
| `reinstate_member` | `dao_id: u64`, `member: Address`, `admin: Address` | - | Records reinstatement. Admin only. |
| `revok_at` | `dao_id: u64`, `commitment: U256` | `Option<u64>` | Gets revocation timestamp. |
| `reinst_at` | `dao_id: u64`, `commitment: U256` | `Option<u64>` | Gets reinstatement timestamp. |
| `version` | - | `u32` | Returns contract version. |

---

## Voting Contract

**Path:** `voting/src/lib.rs`

Anonymous voting with Groth16 ZK proof verification (BN254 pairing).

### Constructor

```rust
__constructor(env: Env, tree_contract: Address)
```

Initializes with Membership Tree contract.

### Functions

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `set_vk` | `dao_id: u64`, `vk: VerificationKey`, `admin: Address` | - | Sets verification key. Admin only. |
| `create_proposal` | `dao_id: u64`, `title: String`, `content_cid: String`, `end_time: u64`, `creator: Address`, `vote_mode: VoteMode` | `u64` | Creates proposal. Snapshots root and VK. |
| `vote` | `dao_id: u64`, `proposal_id: u64`, `vote_choice: bool`, `nullifier: U256`, `root: U256`, `commitment: U256`, `proof: Proof` | - | Submits anonymous vote with ZK proof. |
| `get_proposal` | `dao_id: u64`, `proposal_id: u64` | `ProposalInfo` | Retrieves proposal details. |
| `get_vote_mode` | `dao_id: u64`, `proposal_id: u64` | `u32` | Gets vote mode (0=Fixed, 1=Trailing). |
| `get_eligible_root` | `dao_id: u64`, `proposal_id: u64` | `U256` | Gets root at proposal creation. |
| `proposal_count` | `dao_id: u64` | `u64` | Returns total proposal count. |
| `is_nullifier_used` | `dao_id: u64`, `proposal_id: u64`, `nullifier: U256` | `bool` | Checks if nullifier is spent. |
| `tree_contract` | - | `Address` | Returns tree contract address. |
| `get_results` | `dao_id: u64`, `proposal_id: u64` | `(u64, u64)` | Gets (yes_votes, no_votes). |
| `close_proposal` | `dao_id: u64`, `proposal_id: u64`, `admin: Address` | - | Closes proposal. Admin only. |
| `archive_proposal` | `dao_id: u64`, `proposal_id: u64`, `admin: Address` | - | Archives closed proposal. Admin only. |
| `vk_version` | `dao_id: u64` | `u32` | Gets current VK version. |
| `get_vk` | `dao_id: u64` | `VerificationKey` | Gets current verification key. |
| `version` | - | `u32` | Returns contract version. |

---

## Comments Contract

**Path:** `comments/src/lib.rs`

Public and anonymous comments on proposals.

### Constructor

```rust
__constructor(env: Env, tree_contract: Address, voting_contract: Address)
```

Initializes with Tree and Voting contract addresses.

### Functions

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `add_comment` | `dao_id: u64`, `proposal_id: u64`, `content_cid: String`, `parent_id: Option<u64>`, `author: Address` | `u64` | Adds public comment. Requires SBT. |
| `add_anonymous_comment` | `dao_id: u64`, `proposal_id: u64`, `content_cid: String`, `parent_id: Option<u64>`, `nullifier: U256`, `root: U256`, `commitment: U256`, `vote_choice: bool`, `proof: Proof` | `u64` | Adds anonymous comment with ZK proof. |
| `edit_comment` | `dao_id: u64`, `proposal_id: u64`, `comment_id: u64`, `new_content_cid: String`, `author: Address` | - | Edits public comment. Owner only. |
| `edit_anonymous_comment` | `dao_id: u64`, `proposal_id: u64`, `comment_id: u64`, `new_content_cid: String`, `nullifier: U256`, `root: U256`, `commitment: U256`, `vote_choice: bool`, `proof: Proof` | - | Edits anonymous comment with proof. |
| `delete_comment` | `dao_id: u64`, `proposal_id: u64`, `comment_id: u64`, `author: Address` | - | Deletes public comment. Owner only. |
| `delete_anonymous_comment` | `dao_id: u64`, `proposal_id: u64`, `comment_id: u64`, `nullifier: U256`, `root: U256`, `commitment: U256`, `vote_choice: bool`, `proof: Proof` | - | Deletes anonymous comment with proof. |
| `admin_delete_comment` | `dao_id: u64`, `proposal_id: u64`, `comment_id: u64`, `admin: Address` | - | Admin deletes any comment. |
| `get_comment` | `dao_id: u64`, `proposal_id: u64`, `comment_id: u64` | `CommentInfo` | Retrieves single comment. |
| `comment_count` | `dao_id: u64`, `proposal_id: u64` | `u64` | Returns comment count. |
| `get_comments` | `dao_id: u64`, `proposal_id: u64`, `start_id: u64`, `limit: u64` | `Vec<CommentInfo>` | Returns paginated comments. |
| `get_comment_nonce` | `dao_id: u64`, `proposal_id: u64`, `commitment: U256` | `u64` | Gets next nonce for anonymous comments. |
| `version` | - | `u32` | Returns contract version. |

---

## Type Definitions

### Enums

#### `VoteMode`
| Value | Description |
|-------|-------------|
| `Fixed` | Only members at proposal creation can vote/comment |
| `Trailing` | Members added after creation can also vote/comment |

#### `ProposalState`
| Value | Description |
|-------|-------------|
| `Active` | Voting in progress |
| `Closed` | Voting ended |
| `Archived` | Final state, no further changes |

### Structures

#### `DaoInfo`
```rust
pub struct DaoInfo {
    pub id: u64,
    pub name: String,
    pub admin: Address,
    pub created_at: u64,
    pub membership_open: bool,
    pub members_can_propose: bool,
    pub metadata_cid: Option<String>,
}
```

#### `ProposalInfo`
```rust
pub struct ProposalInfo {
    pub id: u64,
    pub dao_id: u64,
    pub title: String,           // Max 100 bytes
    pub content_cid: String,     // IPFS CID, max 64 chars
    pub yes_votes: u64,
    pub no_votes: u64,
    pub end_time: u64,           // Unix timestamp (0 = no deadline)
    pub created_by: Address,
    pub created_at: u64,
    pub state: ProposalState,
    pub vk_hash: BytesN<32>,     // SHA256 of VK at creation
    pub vk_version: u32,
    pub eligible_root: U256,     // Merkle root snapshot
    pub vote_mode: VoteMode,
    pub earliest_root_index: u32,
}
```

#### `CommentInfo`
```rust
pub struct CommentInfo {
    pub id: u64,
    pub dao_id: u64,
    pub proposal_id: u64,
    pub author: Option<Address>, // None for anonymous
    pub content_cid: String,
    pub parent_id: Option<u64>,
    pub created_at: u64,
    pub updated_at: u64,
    pub revision_cids: Vec<String>,
    pub deleted: bool,
    pub deleted_by: u32,         // 0=none, 1=user, 2=admin
    pub nullifier: Option<U256>,
    pub comment_nonce: Option<u64>,
}
```

#### `VerificationKey`
```rust
pub struct VerificationKey {
    pub alpha: BytesN<64>,       // G1 point
    pub beta: BytesN<128>,       // G2 point
    pub gamma: BytesN<128>,      // G2 point
    pub delta: BytesN<128>,      // G2 point
    pub ic: Vec<BytesN<64>>,     // IC points (G1)
}
```

#### `Proof`
```rust
pub struct Proof {
    pub a: BytesN<64>,           // G1 point
    pub b: BytesN<128>,          // G2 point
    pub c: BytesN<64>,           // G1 point
}
```

---

## Cross-Contract Architecture

```
DAORegistry ──────────────────────────────────────────────────────┐
    │                                                              │
    │ get_admin() - Admin verification                             │
    ▼                                                              │
MembershipSBT ◄───────────────────────────────────────────────────┤
    │                                                              │
    │ has() - Membership checks                                    │
    ▼                                                              │
MembershipTree ◄──────────────────────────────────────────────────┤
    │                                                              │
    │ get_root(), root_ok(), get_merkle_path()                    │
    ▼                                                              │
Voting ◄──────────────────────────────────────────────────────────┤
    │                                                              │
    │ get_vk(), get_eligible_root(), get_vote_mode()              │
    ▼                                                              │
Comments ◄────────────────────────────────────────────────────────┘
```

All contracts verify admin status through the DAORegistry via cross-contract calls.
