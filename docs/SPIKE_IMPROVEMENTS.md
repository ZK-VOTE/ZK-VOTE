# SPIKE Issues Implementation Summary

This document outlines the improvements made to address four complex SPIKE issues (#791, #792, #796, #799).

## Issue #792: RTL Locale Support

### Implementation

1. **Tailwind RTL Utilities** (`frontend/tailwind.config.js`)
   - Added logical property utilities: `ms-auto`, `me-auto`, `ps-safe`, `pe-safe`
   - Added directional utilities: `border-s`, `border-e`, `start-0`, `end-0`
   - Added text alignment: `text-start`, `text-end`, `float-start`, `float-end`

2. **Bidi Safety Library** (`frontend/src/lib/bidi.ts`)
   - `stripBidiOverrides()`: Remove malicious bidi override characters
   - `isolateBidi()`: Wrap text in FSI...PDI for safe rendering
   - `sanitizeAddress()`: Safely display Stellar addresses
   - `hasBidiOverrides()`: Detect potential attacks

3. **Bidi-Safe React Components** (`frontend/src/lib/bidiSafe.tsx`)
   - `<BidiSafe>`: Automatic isolation for user-generated content
   - `<SafeAddress>`: Specialized component for Stellar addresses

4. **Backend Validation** (`backend/src/utils/bidi.ts`)
   - Server-side bidi character detection and stripping
   - Input validation for DAO names, proposals, comments

### Usage

```tsx
import { BidiSafe, SafeAddress } from "@/lib/bidiSafe";

// Render user-generated content safely
<BidiSafe>{daoName}</BidiSafe>

// Render Stellar address safely
<SafeAddress address={stellarAddress} />
```

### ZV-109: Physical->Logical CSS Migration, Isolation Coverage & Confusable Names

- **Audited and converted** every physical directional utility
  (`ml-`/`mr-`/`pl-`/`pr-`/`left-`/`right-`/`text-left`/`text-right`/
  `float-left`/`float-right`/`border-l`/`border-r`) across the 29
  `frontend/src/components/**` files that used them, to their logical
  equivalents (`ms-`/`me-`/`ps-`/`pe-`/`start-`/`end-`/`text-start`/
  `text-end`/`float-start`/`float-end`/`border-s`/`border-e`). Tailwind
  3.3+ ships this whole scale natively, so `tailwind.config.js`'s custom
  plugin was trimmed down to just the two utilities Tailwind doesn't
  provide (`ps-safe`/`pe-safe`). `frontend/src/test/logical-css.test.ts`
  statically scans every component file and fails if a physical utility
  is reintroduced, so this stays enforced going forward.
- **Fixed a `hasBidiOverrides` false-negative** in
  `frontend/src/lib/bidi.ts`: it reused a global-flagged regex for
  `.test()`, so `lastIndex` persisting between calls could make a real
  override in a later, unrelated string go undetected. The backend
  (`backend/src/utils/bidi.ts`) already had the equivalent fix from
  ZV-130; the frontend copy had the same bug and was missed.
- **Wired `<BidiSafe>`/`<SafeAddress>` into real rendering**: both
  components existed but were never actually used anywhere. DAO names
  (`DAOHeader.tsx`, `DAOCard.tsx`), proposal titles (`ProposalCard.tsx`,
  `ProposalPage.tsx`), truncated/full member and comment-author addresses
  (`Comment.tsx`, `ManageMembers.tsx`), and the DAO description markdown
  now isolate or strip bidi overrides. `RevisionHistory.tsx` was
  rendering a historical comment body through bare `ReactMarkdown` with
  no sanitization at all (unlike `Comment.tsx`'s current-revision view) —
  switched to the shared `SafeMarkdown` component.
- **Confusable DAO names** (`backend/src/utils/confusables.ts`): detects
  a name that mixes plain Latin letters with visually-identical
  Cyrillic/Greek letters (e.g. a Cyrillic "а" substituted into "DAO"),
  which is almost always an impersonation attempt — a name written
  entirely in one script, including entirely in Cyrillic or Greek, is
  left alone. Wired into the previously-unused `daoNameSchema` and into
  `DaoProvisioningService.start()`, the one concrete backend "create a
  DAO" entry point, so a confusable name is rejected before provisioning
  begins.

**Still open** (need a human, not just code): RTL visual regression
screenshots and native-speaker review of the shipped Arabic locale. A
Playwright + `@playwright/test` smoke suite already exists
(`frontend/e2e/smoke.spec.ts`) targeting the deployed site, but there's
no visual-diffing baseline yet, and establishing one still needs someone
to eyeball the first screenshots; this should be a follow-up.

## Issue #791: User Onboarding & Secret Backup

### Implementation

**Backup Verification Library** (`frontend/src/lib/backupVerification.ts`)

- `verifyMnemonicBackup()`: Verify backed-up mnemonic can recover secret
- `generateVerificationChallenge()`: Create random word position challenge
- `verifyWordAtPosition()`: Verify single word from mnemonic
- `markBackupVerified()`: Track verification status
- `isBackupVerified()`: Check if user has verified backup

### Usage

```typescript
import { verifyMnemonicBackup } from "@/lib/backupVerification";

// Verify user entered their backup correctly
const result = verifyMnemonicBackup(masterSecret, userEnteredMnemonic);
if (result.success) {
  markBackupVerified(masterSecret);
}
```

### ZV-108: Integration, Funnel Instrumentation & Progressive Onboarding

The items below were the open gap: the backup-verification library existed
but nothing called it, there were no reminders or word-challenge UI, and a
new visitor was forced into HD-mnemonic secret generation immediately.

- **`VoterRegistration.tsx`** now has three modes: `choice` (first visit —
  browse read-only, create an identity, or import one), `explore`
  (read-only; never generates a secret or derives keys), and `setup` (the
  existing HD-mnemonic flow). A new member can't finish — `derivedKeys`
  are handed to `onCredentialsDerived` only once the backup is confirmed.
- **Word-challenge UI**: `generateVerificationChallenge()` /
  `verifyWordAtPosition()` are wired into a "confirm one word" step. Note
  `verifyWordAtPosition` now takes the mnemonic directly rather than
  re-deriving one from the master secret — `mnemonicToMasterSecret` /
  `masterSecretToMnemonic` reduce entropy modulo the BN254 field and
  aren't a faithful round trip, so re-deriving could silently check
  against a different phrase than the one actually backed up. The exact
  phrase is now also persisted (`zkvote_hd_mnemonic`) so a restored
  session shows what was actually backed up, not a regenerated
  approximation.
- **`markBackupVerified()`/`isBackupVerified()`** are now scoped to a
  specific master secret (not a bare global boolean), so importing a
  different secret into the same browser doesn't inherit a previous
  secret's verified status.
- **Reminder banner**: an unverified backup shows a static-copy warning
  (no interpolated secret data) with a "Verify my backup" action.
- **Funnel instrumentation** (`frontend/src/lib/onboardingFunnel.ts` +
  `backend/src/services/onboardingFunnel.ts`, migration `017`): each step
  (`registration_started`, `explore_readonly_selected`, `secret_created`,
  `backup_viewed`, `backup_verification_started`,
  `backup_verification_passed`, `registration_completed`) increments a
  single aggregate counter server-side — no session id, wallet address,
  secret, or mnemonic is ever sent, and no per-event record is stored, so
  the server can never reconstruct one member's path through onboarding.
  Drop-off is read via `GET /onboarding/funnel/summary` as the delta
  between consecutive step counts. Wired into both credential systems
  below, including the wallet-signature flow (`useRegistration.ts`).
- **Dual-secret model documented in the UI**: `VoterRegistration.tsx`
  explains the HD mnemonic is self-custodied and must be backed up here,
  while `RegistrationFlow.tsx` (the wallet-signature flow used by
  `useRegistration.ts`) explains that credential system is derived from a
  wallet signature on demand and has nothing separate to back up.

## Issue #796: Double-Entry Financial Ledger

### Implementation

1. **Database Schema** (`backend/src/migrations/014_double_entry_ledger.up.sql`)
   - `ledger_accounts`: Chart of accounts (assets, liabilities, equity, revenue, expense)
   - `ledger_entries`: Journal entry headers
   - `ledger_lines`: Journal entry lines (debits and credits)
   - `ledger_daily_close`: Daily balance proof and close procedure
   - `ledger_reconciliations`: Chain-vs-books reconciliation tracking
   - Views: `ledger_account_balances`, `ledger_trial_balance`
   - Trigger: `ensure_balanced_entry` enforces double-entry invariant

2. **Ledger Service** (`backend/src/services/ledger.ts`)
   - `postEntry()`: Post balanced journal entries
   - `postPayment()`: Record payment transactions
   - `postSwap()`: Record swap transactions with dust accounting
   - `performDailyClose()`: Daily balance verification
   - `getAccountBalance()`: Query account balances

### Chart of Accounts

```
1000 - Relayer Float (Asset)
1100 - DAO Treasuries (Asset)
1200 - Escrows (Asset)
2000 - Fees Payable (Liability)
3000 - Equity
4000 - Fee Revenue (Revenue)
5000 - Transaction Fees (Expense)
5100 - Dust Account (Expense)
5200 - Rounding Adjustments (Expense)
```

### Usage

```typescript
import { LedgerService } from "@/services/ledger";

const ledger = new LedgerService(db);

// Post a payment
await ledger.postPayment({
  amountStroops: 10000000n,
  feeStroops: 100n,
  paymentHash: "abc123",
});

// Perform daily close
const balanced = await ledger.performDailyClose(new Date());
```

### Remaining Work

- Integrate ledger posting into payments.ts, swap.ts, anchor.ts
- Implement reconciliation jobs (compare chain state vs books)
- Add cryptographic balance proof in daily close
- Implement auditor export (redacted, read-only)
- Backfill historical transactions from chain
- Add balance invariant monitoring and alerts
- Implement tax classification (absorbed SPIKE-145)

## Issue #799: EURC Liquidity & Depth-Aware Swaps

### Implementation

**Swap Depth Service** (`backend/src/services/swap-depth.ts`)

- Asset tier classification (tier1: XLM/USDC, tier2: EURC, tier3: experimental)
- Per-tier position limits and price impact thresholds
- `estimateDepth()`: Walk order book to estimate fillability
- `checkPositionLimits()`: Enforce tier-based limits
- `getQuoteWithDepth()`: Combine depth check with quote
- `checkDepthDegradation()`: Monitor liquidity degradation

### Tier Limits

| Tier | Assets          | Max Swap USD | Warn Impact | Block Impact |
| ---- | --------------- | ------------ | ----------- | ------------ |
| 1    | XLM, USDC, AQUA | $100,000     | 1%          | 5%           |
| 2    | EURC, yUSDC     | $10,000      | 0.5%        | 2%           |
| 3    | Experimental    | $1,000       | 0.2%        | 1%           |

### Usage

```typescript
import { SwapDepthService } from "@/services/swap-depth";

const depthService = new SwapDepthService(horizonUrl);

// Get quote with depth awareness
const quote = await depthService.getQuoteWithDepth(
  sourceAsset,
  destAsset,
  sourceAmount,
);

if (!quote) {
  // Swap blocked due to price impact
}

if (quote.depthCheck.warning) {
  // Show warning to user
}
```

### Remaining Work

- Integrate depth checks into swap.ts route
- Add depth/impact warnings to SwapPanel.tsx UI
- Implement Soroswap depth checking (currently Horizon only)
- Add depth degradation monitoring and alerts
- Implement split-execution strategy for large swaps
- Add partial-fill handling with clear fund states
- Document asset listing policy (depth-gated)

## Testing

Run the existing test suites:

```bash
# Frontend tests
cd frontend && npm test

# Backend tests
cd backend && npm test
```

## Next Steps

1. **Code Review**: Review all new utilities and services
2. **Integration**: Wire up services to existing routes and components
3. **Testing**: Add unit and integration tests
4. **Documentation**: Update user-facing docs and API specs
5. **Monitoring**: Add metrics and alerts for new features
6. **Deployment**: Staged rollout with feature flags

## Notes

These implementations provide foundation infrastructure for each SPIKE issue. Full resolution requires:

- Integration into existing flows
- Comprehensive testing (unit, integration, E2E)
- Native speaker review (for RTL)
- Auditor validation (for ledger)
- Load testing (for swap depth)
- User research (for onboarding)

Each SPIKE is estimated at 24 hours total implementation + testing + validation.
