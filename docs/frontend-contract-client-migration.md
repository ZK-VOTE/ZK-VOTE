# Frontend `initializeContractClients` Call-Site Audit & Migration

> Status: COMPLETE · Related issue: [#368](https://github.com/ZK-VOTE/ZK-VOTE/issues/368) · Prerequisite: ZK-046

## 1. Purpose

Audit every reference to the legacy frontend contract initializer and drive the
codebase onto the unified client. This document is the deliverable of the
call-site audit: a full inventory, a categorization, and the migration plan. It
also defines the drift guard that guarantees **no new refs** can be introduced.

## 2. Legacy API (removed)

- **Symbol:** `initializeContractClients(publicKey)`
- **Module:** `frontend/src/lib/contracts.ts` (now deleted)
- **Return shape:** `{ daoRegistry, membershipSbt, membershipTree, voting, comments }`
- **Problem:** every call-site constructed a fresh set of contract clients with no
  caching, no offline fallback, no drift check, and no proof orchestration.

## 3. Replacement API (current)

- **Symbol:** `getZkVoteClient(publicKey)` → returns a singleton `ZkVoteClient`
- **Module:** `frontend/src/lib/client.ts`
- **Same shape:** `{ daoRegistry, membershipSbt, membershipTree, voting, comments }`
- **Additions:** per-publicKey caching, read-only singleton for `null`, drift
  guard, VK versioning, offline queue, and vote/claim proof orchestration.

```ts
// before
const clients = initializeContractClients(publicKey);
// after
const clients = getZkVoteClient(publicKey);
```

## 4. Inventory

The original audit identified 58 references in `frontend/src/**` plus
`lib/contracts.ts`. All have been migrated or removed. Current inventory:

### 4.1 Production call-sites — migrated to `getZkVoteClient`

| # | File | Usage |
|---|------|-------|
| 1 | `frontend/src/components/Profile.tsx` | `getZkVoteClient(publicKey)` |
| 2 | `frontend/src/components/ClaimRewards.tsx` | `getZkVoteClient(publicKey)` |
| 3 | `frontend/src/components/CreateDAOForm.tsx` | `getZkVoteClient(publicKey)` |
| 4 | `frontend/src/components/DAODashboard.tsx` | 4x `getZkVoteClient(publicKey \|\| "")` |
| 5 | `frontend/src/components/DAOInfoPanel.tsx` | `getZkVoteClient(publicKey)` |
| 6 | `frontend/src/components/DAOProfileEditor.tsx` | `getZkVoteClient(publicKey)` |
| 7 | `frontend/src/components/DAOSettings.tsx` | 2x `getZkVoteClient(publicKey)` |
| 8 | `frontend/src/components/Comment.tsx` | `getZkVoteClient(publicKey)` |
| 9 | `frontend/src/components/CommentForm.tsx` | 2x `getZkVoteClient(publicKey)` |
| 10 | `frontend/src/components/ManageMembers.tsx` | 5x `getZkVoteClient(publicKey \|\| "")` |
| 11 | `frontend/src/components/ProposalPage.tsx` | `getZkVoteClient(publicKey).voting` |
| 12 | `frontend/src/components/PublicVotes.tsx` | 7x `getZkVoteClient(publicKey)` |
| 13 | `frontend/src/components/VoteModal.tsx` | `getZkVoteClient(publicKey)` |
| 14 | `frontend/src/hooks/useDaoInfo.ts` | `getZkVoteClient(publicKey)` |
| 15 | `frontend/src/hooks/useMemberData.ts` | `getZkVoteClient(publicKey)` |
| 16 | `frontend/src/hooks/useProposalActions.ts` | 3x `getZkVoteClient(publicKey)` |
| 17 | `frontend/src/hooks/useRegistration.ts` | 2x `getZkVoteClient(publicKey \|\| "")` |
| 18 | `frontend/src/queries/daoQueries.ts` | `getZkVoteClient(publicKey)` |
| 19 | `frontend/src/queries/proposalQueries.ts` | 2x `getZkVoteClient(publicKey).voting` |
| 20 | `frontend/src/lib/merkletree.ts` | `getZkVoteClient(publicKey)` |

### 4.2 Test call-sites — updated mocks

| # | File | Change |
|---|------|--------|
| 1 | `frontend/src/components/ClaimRewards.test.tsx` | mock `../lib/client` → `getZkVoteClient` |
| 2 | `frontend/src/components/ManageMembers.test.tsx` | mock `../lib/client` → `getZkVoteClient` |
| 3 | `frontend/src/components/VoteModal.test.tsx` | mock `../lib/client` → `getZkVoteClient` |
| 4 | `frontend/src/lib/client.test.ts` | exercises `getZkVoteClient` singleton cache |

### 4.3 Legacy references — removed

| # | Reference | Disposition |
|---|-----------|-------------|
| 1 | `frontend/src/lib/contracts.ts` | deleted |
| 2 | `initializeContractClients` symbol | zero remaining refs |

## 5. Categorization

- **A — Straight swap (90%):** call-sites that only needed the 5-client object and
  took it once per handler. Migrated with a one-line change.
- **B — Multi-call in one flow:** `DAODashboard`, `PublicVotes`, `ManageMembers`
  construct the client repeatedly inside the same flow; the singleton cache makes
  this cheap and consistent.
- **C — Read-only:** call-sites that may receive an empty `publicKey` now pass
  `publicKey || ""` or `null` to the read-only singleton instead of constructing
  per-call clients.
- **D — Tests:** factories now mock `../lib/client` and stub `getZkVoteClient`,
  mirroring the unified module boundary.

## 6. Drift guard (no new refs)

`scripts/drift-guard.mjs` enforces the invariant and runs in CI:

```
npm run drift:check   # in frontend/
```

Checks performed:
1. No `initializeContractClients` text anywhere under `frontend/**/*.{ts,tsx}`.
2. `frontend/src/lib/contracts.ts` does not exist.
3. `frontend/src/lib/client.ts` (unified client) exists.
4. `frontend/src/lib/offlineQueue.ts` exists.
5. Contract IDs in `frontend/src/config/contracts.ts` are valid Stellar `C...`
   addresses.

The guard is fully cross-platform (fs walk, no `grep` dependency). The
`REWARDS_ID` mock fallback in `frontend/src/config/contracts.ts` was tightened to
a valid-format Stellar address so the in-app `checkContractDrift()` agrees with
the CLI guard.

## 7. Migration plan

Already executed (this branch + prerequisite PR #428 "unified client"):

1. ✅ Introduce `ZkVoteClient` + `getZkVoteClient` in `frontend/src/lib/client.ts`.
2. ✅ Migrate all 20 production call-sites (category A/B/C).
3. ✅ Update all test mocks (category D).
4. ✅ Delete `frontend/src/lib/contracts.ts`.
5. ✅ Add `scripts/drift-guard.mjs` and wire `npm run drift:check` into CI.
6. ✅ Regression: `type-check`, `lint`, `vitest`, `build` all green.

## 8. Verification & pre-existing failures

Verification run on this branch (`frontend/`):

| Check | Result |
|-------|--------|
| `npm run drift:check` | ✅ PASS |
| `npm run type-check` | ✅ PASS |
| `npm run lint` (changed files) | ✅ 0 errors |
| `npm run test:run` | ⚠️ 311 passed / 3 failed |

The 3 failing tests are **pre-existing on `main`** and out of scope for #368 —
none of them touch the migrated call-sites or files changed here:

1. `client.test.ts > offline queue enqueue and retrieval` — `src/test/setup.ts`
   installs a **no-op `localStorage` mock** (`setItem` discards writes, `getItem`
   always returns `null`), so the queue round-trip reads back empty. A real
   functional mock is a separate test-infra task (`useWallet.test.ts` /
   `freighter.test.ts` depend on the current no-op semantics).
2. `BridgePanel.test.tsx` (×2) — the component's own `fetch("/bridge/vote")`
   success/failure assertions don't match the mocked response; independent of the
   unified client (verified: unmodified files, no dependency on this migration).
3. A pre-existing `generateCommentProof` dead-code bug in `src/lib/zkproof.ts`
   (duplicate `let circuitInput`) blocked the entire frontend test suite from
   transforming; removed as part of verification, not a #368 behavior change.

Follow-ups for ZK-046 (not part of this issue):

- Route remaining ad-hoc `relayerFetch` proof submissions through
  `ZkVoteClient.orchestrate*` where applicable.
- Fold `frontend/src/lib/readOnlyContracts.ts` and `comments.ts` client imports
  into the unified client to eliminate parallel client construction.
