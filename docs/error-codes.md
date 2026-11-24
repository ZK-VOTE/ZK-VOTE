# ZKVote Error Codes Reference

All contract errors are numeric codes. This reference provides human-readable explanations.

## DAO Registry Errors

| Code | Name | Description | Common Cause |
|------|------|-------------|--------------|
| 1 | `NameTooLong` | DAO name exceeds 24 character limit | Provide a shorter name |
| 2 | `DaoNotFound` | DAO with given ID doesn't exist | Check dao_id is valid |
| 3 | `NotAdmin` | Caller is not the DAO admin | Use admin account |
| 4 | `MetadataCidTooLong` | Metadata CID exceeds 64 character limit | Use shorter CID |

## Membership SBT Errors

| Code | Name | Description | Common Cause |
|------|------|-------------|--------------|
| 1 | `NotDaoAdmin` | Caller is not the DAO admin | Use admin account |
| 2 | `AlreadyMinted` | Member already has an SBT for this DAO | Member already registered |
| 3 | `NotMember` | Address is not a member of this DAO | Check membership status |
| 4 | `NotOpenMembership` | DAO membership is not open for self-join | Admin must add members |
| 5 | `AlreadyInitialized` | Contract already initialized | Constructor already called |

## Membership Tree Errors

| Code | Name | Description | Common Cause |
|------|------|-------------|--------------|
| 1 | `NotAdmin` | Caller is not the DAO admin | Use admin account |
| 2 | `InvalidDepth` | Tree depth must be 1-18 | Use valid depth |
| 3 | `TreeInitialized` | Tree already initialized for this DAO | DAO tree exists |
| 4 | `TreeNotInitialized` | Tree not initialized for this DAO | Initialize tree first |
| 5 | `CommitmentExists` | Identity commitment already registered | Commitment is duplicate |
| 6 | `MemberExists` | Member already registered in tree | Member already has commitment |
| 7 | `TreeFull` | Merkle tree is full (2^depth leaves) | Increase tree depth |
| 8 | `NoSbt` | Member does not have an SBT | Mint SBT first |
| 9 | `NotOpenMembership` | DAO membership is not open | Admin must add members |
| 10 | `LeafOutOfBounds` | Leaf index exceeds tree capacity | Invalid leaf index |
| 11 | `MemberRemoved` | Member has been removed/revoked | Member was revoked |
| 12 | `MemberNotInTree` | Member not found in tree | Register commitment first |
| 13 | `RootNotFound` | Merkle root not in history | Root was evicted or invalid |
| 14 | `AlreadyInitialized` | Tree already initialized | Constructor already called |
| 15 | `MemberNotRevoked` | Member has not been revoked | Can only reinstate revoked members |
| 16 | `CommitmentAlreadyUsed` | Commitment already bound to a different address | Commitment collision |
| 17 | `RateLimited` | Call rate-limited | Too many calls in one window |
| 18 | `MaxRootsOutOfRange` | Requested root history size is out of range | Configure fewer roots |
| 19 | `RootPinnedByProposal` | Root is pinned by an in-flight proposal | Wait for proposals to close |
| 20 | `Sha3TreeNotInitialized` | Post-quantum tree not initialized for DAO | Initialize the PQ tree first |
| 21 | `PqCommitmentExists` | C_PQ commitment already stored | Commitment collision |
| 22 | `InvalidField` | Poseidon field symbol is not `BN254` or `BLS12_381` | Typo in the field passed to `init_tree` |

## Voting Contract Errors

| Code | Name | Description | Common Cause |
|------|------|-------------|--------------|
| 1 | `NotAdmin` | Caller is not the DAO admin | Use admin account |
| 2 | `VkIcLengthMismatch` | VK IC length doesn't match expected (6) | Wrong circuit VK |
| 3 | `VkIcTooLarge` | VK IC vector too large | Invalid VK format |
| 4 | `TitleTooLong` | Proposal title exceeds limit | Use shorter title |
| 5 | `NotDaoMember` | Caller not a member of this DAO | Join DAO first |
| 6 | `EndTimeInvalid` | Proposal end time is in the past | Use future timestamp |
| 7 | `NullifierUsed` | Vote already cast (nullifier used) | Already voted on this proposal |
| 8 | `VotingClosed` | Voting period has ended | Vote before end time |
| 9 | `CommitmentRevokedAtCreation` | Member was revoked when proposal created | Fixed mode: cannot vote |
| 10 | `CommitmentRevokedDuringVoting` | Member revoked during voting | Trailing mode: cannot vote |
| 11 | `RootMismatch` | Root doesn't match proposal snapshot | Use proposal's eligible_root |
| 12 | `RootNotInHistory` | Merkle root not in tree history | Root was evicted |
| 13 | `RootPredatesProposal` | Root is from before proposal creation | Use recent root |
| 14 | `VkChanged` | VK changed after proposal creation | Use original VK version |
| 15 | `InvalidProof` | ZK proof verification failed | Proof is invalid/tampered |
| 16 | `VkNotSet` | Verification key not set for DAO | Admin must set VK first |
| 17 | `VkVersionMismatch` | VK version doesn't match proposal | Use proposal's vk_version |
| 18 | `AlreadyInitialized` | Contract already initialized | Constructor already called |
| 19 | `Unauthorized` | Caller not authorized | Check permissions |
| 20 | `InvalidState` | Invalid contract state | Internal error |
| 21 | `InvalidContentCid` | Content CID invalid format | Check CID format |
| 22 | `OnlyAdminCanPropose` | Only admin can create proposals | DAO restricts proposal creation |
| 23 | `InvalidG1Point` | G1 point not on BN254 curve | Invalid proof point |
| 24 | `RootPredatesRemoval` | Root is from before member removal | Get fresh proof |
| 25 | `SignalNotInField` | Public signal ≥ BN254 Fr modulus | Signal value too large |
| 26 | `InvalidNullifier` | Nullifier is zero | Nullifier cannot be zero |

## Comments Contract Errors

| Code | Name | Description | Common Cause |
|------|------|-------------|--------------|
| 1 | `NotAdmin` | Caller is not the DAO admin | Use admin account |
| 5 | `NotDaoMember` | Caller not a member of this DAO | Join DAO first |
| 9 | `CommitmentRevoked` | Member's commitment was revoked | Cannot comment after revocation |
| 12 | `RootNotInHistory` | Merkle root not in tree history | Root was evicted |
| 15 | `InvalidProof` | ZK proof verification failed | Proof is invalid |
| 16 | `ContractNotSet` | Required contract reference not set | Initialize contract |
| 18 | `AlreadyInitialized` | Contract already initialized | Constructor already called |
| 19 | `Unauthorized` | Caller not authorized | Check permissions |
| 22 | `CommentNotFound` | Comment ID doesn't exist | Check comment_id |
| 23 | `CommentDeleted` | Comment was already deleted | Cannot modify deleted comment |
| 24 | `NotCommentOwner` | Caller doesn't own this comment | Only owner can edit/delete |
| 25 | `InvalidParentComment` | Parent comment doesn't exist | Check parent_id |
| 27 | `CommentContentTooLong` | Comment exceeds length limit | Use shorter content |
| 28 | `ProposalNotFound` | Proposal doesn't exist | Check proposal_id |
| 29 | `RootMismatch` | Root doesn't match proposal | Use correct root |
| 30 | `RootPredatesProposal` | Root is from before proposal | Use recent root |
| 31 | `SignalNotInField` | Public signal ≥ BN254 Fr modulus | Signal value too large |
| 32 | `InvalidNullifier` | Nullifier is zero | Nullifier cannot be zero |
| 33 | `RootPredatesRemoval` | Root is from before member removal | Get fresh proof |

## Groth16 Verification Errors

These errors can be returned by any contract using Groth16 verification:

| Code | Name | Description | Common Cause |
|------|------|-------------|--------------|
| 30 | `IcLengthMismatch` | IC vector length doesn't match public inputs | Wrong number of signals |
| 31 | `SignalNotInField` | Public signal ≥ BN254 Fr modulus | Value exceeds field |
| 32 | `InvalidNullifier` | Nullifier is zero | Zero is not valid nullifier |

## Handling Errors

### Frontend (TypeScript)

```typescript
import { getErrorMessage, VotingError } from './types';

try {
  await vote(proof);
} catch (error) {
  if (error.code === VotingError.NullifierUsed) {
    showError("You've already voted on this proposal");
  } else if (error.code === VotingError.VotingClosed) {
    showError("Voting has ended");
  } else {
    showError(getErrorMessage('Voting', error.code));
  }
}
```

## Token Errors

| Code | Name | Description | Common Cause |
|------|------|-------------|--------------|
| 1 | `AlreadyInitialized` | Contract already initialized | Constructor called twice |
| 2 | `InsufficientBalance` | Not enough tokens to transfer/burn | Check sender balance |
| 3 | `InsufficientAllowance` | Spender has insufficient allowance | Check allowance or increase it |
| 4 | `Unauthorized` | Caller not authorized for action | Use correct signer |
| 5 | `InvalidAmount` | Amount cannot be negative | Pass non-negative amount |
| 6 | `Overflow` | Arithmetic overflow in add/sub | Allowance near i128::MAX |
| 7 | `AllowanceRaceRejected` | `approve` rejected non-zero to different non-zero | Use `increase_allowance` / `decrease_allowance` |
| 8 | `NotAdmin` | Caller is not the token admin | Use admin account |
| 9 | `NegativeAllowance` | Negative amount passed to increase/decrease | Pass non-negative amount |

### Backend (Node.js)

```typescript
import { ERROR_MESSAGES } from './types';

function handleContractError(contract: string, code: number): string {
  return ERROR_MESSAGES[contract]?.[code] ?? `Unknown error (code ${code})`;
}
```
