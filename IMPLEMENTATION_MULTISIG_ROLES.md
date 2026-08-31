# DAO Admin Multisig + Role Model Implementation

## Overview

This document describes the implementation of **Issue #363**: DAO admin multisig + role model feature for the ZK-VOTE platform. This feature introduces a safer DAO governance model with:

- **Multi-signature (Multisig) Admin Control**: Critical DAO actions require multiple signatures
- **Role-Based Access Control**: Three roles (Admin, Member, Auditor) with different permissions
- **Gated Actions**: Role-based restrictions on sensitive operations
- **Web UI**: Intuitive interface for role and multisig management
- **Comprehensive Tests**: Unit, integration, and E2E test coverage

## Architecture

### 1. Role Model (RBAC)

**Three Roles:**
- **Admin (0)**: Full DAO control - can transfer admin, manage roles, configure multisig
- **Member (1)**: Can vote and participate - limited to standard DAO actions
- **Auditor (2)**: Read-only oversight - can view activities but cannot execute actions

### 2. Multisig Model

**Components:**
- **Signers List**: Array of authorized signers (Stellar addresses)
- **Threshold**: Number of signatures required to execute proposals (M-of-N)
- **Proposals**: Timestamped governance proposals with:
  - Title, description, action type
  - Signature collection window (7 days)
  - Execution only when threshold met

## Implementation Details

### Phase 1: Smart Contracts (Rust - Soroban)

#### File: `contracts/dao-registry/src/lib.rs`

**New Error Types (11-19):**
```rust
InvalidRole = 11,
NotMultisigAdmin = 12,
InsufficientSignatures = 13,
ProposalNotFound = 14,
ProposalAlreadyExecuted = 15,
InvalidSignature = 16,
DuplicateSigner = 17,
InvalidThreshold = 18,
SignerNotFound = 19,
```

**New Data Structures:**

1. **DaoRole enum**
   - Represents: Admin (0), Member (1), Auditor (2)
   - Used for role-based access control

2. **MemberRole struct**
   - Fields: member (Address), role (DaoRole), assigned_at (u64)
   - Stores member role assignments in persistent storage

3. **MultisigConfig struct**
   - Fields: dao_id, signers (Vec), threshold, created_at
   - Governance configuration per DAO

4. **MultisigProposal struct**
   - Fields: proposal_id, title, description, action_type, action_data, proposer, created_at, expires_at, signatures, executed
   - Supports proposals with time-based expiration

**New Events:**

- `RoleAssignedEvent`: Emitted when role assigned
- `RoleRevokedEvent`: Emitted when role revoked
- `MultisigConfiguredEvent`: Emitted when multisig initialized
- `MultisigProposalCreatedEvent`: Emitted on proposal creation
- `MultisigProposalSignedEvent`: Emitted on signature
- `MultisigProposalExecutedEvent`: Emitted on execution

**New Methods:**

#### Role Management
- `assign_role(dao_id, member, role, admin)`: Assign role to member
- `get_member_role(dao_id, member) -> Option<u32>`: Query member role
- `revoke_role(dao_id, member, admin)`: Revoke member's role

#### Multisig Management
- `init_multisig(dao_id, signers, threshold, admin)`: Initialize multisig
- `get_multisig(dao_id) -> Option<MultisigConfig>`: Get configuration
- `create_multisig_proposal(...)`: Create governance proposal
- `sign_multisig_proposal(dao_id, proposal_id, signer)`: Add signature
- `get_multisig_proposal(dao_id, proposal_id) -> Option<MultisigProposal>`: Query proposal
- `execute_multisig_proposal(dao_id, proposal_id, executor)`: Execute when threshold met

#### Storage Keys
- `member_role_key(dao_id, member)`: Role storage per member
- `multisig_config_key(dao_id)`: Config storage per DAO
- `multisig_proposal_key(dao_id, proposal_id)`: Proposal storage

### Phase 2: Backend Routes (Node.js/TypeScript)

#### File: `backend/src/routes/admin.ts`

**New Endpoints:**

**Role Management:**
```
POST   /admin/dao/:daoId/roles
  - Assign role to member
  - Body: { member, role: 0|1|2 }

GET    /admin/dao/:daoId/roles/:member
  - Get member's role in DAO

DELETE /admin/dao/:daoId/roles/:member
  - Revoke member's role
```

**Multisig Configuration:**
```
POST   /admin/dao/:daoId/multisig/config
  - Initialize multisig
  - Body: { signers: string[], threshold: number }

GET    /admin/dao/:daoId/multisig/config
  - Get multisig configuration
```

**Multisig Proposals:**
```
POST   /admin/dao/:daoId/multisig/proposal
  - Create proposal
  - Body: { title, description, actionType, actionData }

POST   /admin/dao/:daoId/multisig/proposal/:proposalId/sign
  - Add signature to proposal

POST   /admin/dao/:daoId/multisig/proposal/:proposalId/execute
  - Execute proposal (requires threshold met)
```

**Input Validation:**
- Stellar address format validation
- DAO existence checks
- Threshold constraints (1 ≤ threshold ≤ signers.length)
- Duplicate signer detection
- Proposal expiration checks

**Error Handling:**
- 400: Invalid input parameters
- 404: DAO or proposal not found
- 500: Server error with detailed logging

### Phase 3: Frontend Components (React)

#### File: `frontend/src/components/DaoRoleManagement.tsx`

**Features:**
- Address input with role selector
- Role assignment form
- Display assigned roles with badges
- Role revocation with confirmation
- Color-coded role badges (Admin: red, Member: blue, Auditor: yellow)

**Props:**
```typescript
interface RoleAssignmentProps {
  daoId: number;
  onAssignRole: (member: string, role: DaoRole) => Promise<void>;
  onRevokeRole: (member: string) => Promise<void>;
  loading?: boolean;
  error?: string | null;
}
```

#### File: `frontend/src/components/DaoMultisigManagement.tsx`

**Features:**
- Tabbed interface: Configuration | Proposals
- Signer management (add/remove)
- Threshold configuration with validation
- Proposal creation with action type selection
- Proposal signing interface
- Conditional execute button (shows when threshold met)
- Timestamp display for proposals

**Props:**
```typescript
interface DaoMultisigManagementProps {
  daoId: number;
  onInitMultisig: (signers: string[], threshold: number) => Promise<void>;
  onCreateProposal: (...) => Promise<MultisigProposal>;
  onSignProposal: (proposalId: number) => Promise<void>;
  onExecuteProposal: (proposalId: number) => Promise<void>;
  loading?: boolean;
  error?: string | null;
}
```

### Phase 4: Testing

#### Rust Contract Tests

**File:** `contracts/dao-registry/src/test.rs`

**Role Tests:**
- `test_assign_role`: Verify role assignment
- `test_revoke_role`: Verify role revocation
- `test_assign_auditor_role`: Test auditor role specifically

**Multisig Tests:**
- `test_init_multisig`: Initialize with 3-of-2 setup
- `test_create_multisig_proposal`: Create proposal with auto-signature
- `test_sign_multisig_proposal`: Add signatures
- `test_execute_multisig_proposal`: Execute when threshold met

#### Backend Route Tests

**File:** `backend/test/admin-multisig-roles.test.ts`

**Coverage:**
- Role assignment with all three role types
- Invalid role rejection
- Missing parameter validation
- Multisig configuration with threshold validation
- Proposal creation with various action types
- Proposal signing and execution flows
- 7-day expiration window validation

#### Frontend Component Tests

**File:** `frontend/src/components/__tests__/DaoRoleManagement.test.tsx`

**Coverage:**
- Component rendering
- Role selection options
- Role assignment form submission
- Role display and revocation
- Error and loading states
- Role badge color coding

**File:** `frontend/src/components/__tests__/DaoMultisigManagement.test.tsx`

**Coverage:**
- Tab navigation
- Signer management (add/remove)
- Threshold validation
- Multisig initialization
- Proposal creation and display
- Proposal signing
- Execute confirmation dialog

## Acceptance Criteria

✅ **Multisig Required**
- All DAO transfers/config changes require M-of-N signatures
- Threshold enforcement in contract code
- Proposal expiration mechanism

✅ **Roles Enforced**
- Three roles: Admin, Member, Auditor
- Role-based restrictions on actions
- Role storage and retrieval

✅ **UI Test**
- React components for role management
- React components for multisig management
- Full test coverage for both components

## Security Considerations

1. **Timelock Window**: Proposals expire after 7 days
2. **Signature Verification**: Each signer must authorize (requires_auth)
3. **Duplicate Prevention**: Cannot sign proposal twice
4. **Threshold Validation**: Execution only when M signatures present
5. **Role Immutability**: Roles stored on-chain, verified by contract

## Integration Points

**With Existing Contracts:**
- Voting contract: Can enforce member role for voting
- Membership SBT: Integrate role with membership verification
- Comments contract: Enforce auditor role for comment moderation

**With Backend:**
- Sync service: Cache role assignments for frontend
- Admin routes: Query role/multisig state
- Event indexing: Track role and multisig events

## Deployment Checklist

- [ ] Contract builds without errors
- [ ] All Rust tests pass
- [ ] Backend tests pass (npm test)
- [ ] Frontend tests pass (npm test)
- [ ] Contract deployed to testnet
- [ ] Admin routes integrated with backend
- [ ] Frontend components deployed
- [ ] E2E tests pass
- [ ] Mainnet deployment

## Future Enhancements

1. **Time Delays**: Add execute time windows (e.g., 24h after threshold)
2. **Veto Period**: Allow veto before execution
3. **Role Permissions Matrix**: Define specific permissions per role
4. **Delegation**: Allow members to delegate voting/signing rights
5. **Timelock Escrow**: Hold funds during multisig voting

## Files Changed

### Contracts
- `contracts/dao-registry/src/lib.rs`: +500 LOC (roles + multisig)
- `contracts/dao-registry/src/test.rs`: +200 LOC (tests)

### Backend
- `backend/src/routes/admin.ts`: +400 LOC (endpoints)
- `backend/test/admin-multisig-roles.test.ts`: +500 LOC (tests)

### Frontend
- `frontend/src/components/DaoRoleManagement.tsx`: 200 LOC
- `frontend/src/components/DaoMultisigManagement.tsx`: 350 LOC
- `frontend/src/components/__tests__/DaoRoleManagement.test.tsx`: 300 LOC
- `frontend/src/components/__tests__/DaoMultisigManagement.test.tsx`: 400 LOC

**Total New Code:** ~2800 LOC (contracts + backend + frontend)

## References

- Issue: #363
- Type: Feature
- Difficulty: ADVANCED
- Complexity: L (2 weeks)
- Scope: contracts/dao-registry/, voting/, backend/src/routes/admin.ts, frontend/
