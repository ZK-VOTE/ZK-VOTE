# DAO Naming Policy

> SPIKE-055 / issue #734 — Permissionless DAO creation: name squatting and creation front-running

## Canonical Identity

**A DAO's canonical identity is its numeric `dao_id`**, assigned deterministically
at creation time from an on-chain counter. Names are non-unique labels attached
to a `dao_id` and carry no ownership guarantee.

This means:

- Two DAOs may share the same name — the `dao_id` disambiguates them.
- Squatting a name does not block a legitimate organization from creating a DAO
  with the same name under a different `dao_id`.
- Frontends and search results MUST display the `dao_id` alongside the name to
  prevent lookalike spoofing.

## Front-Running Model on Soroban

Unlike EVM, Soroban has no mempool fee auction. Transaction ordering is
ledger-sequence based (first-submitted wins within a ledger). The attack
surface is therefore:

- **Sequence-position racing**: a watcher monitors pending transactions and
  submits an identical creation before the victim's transaction closes.
- **Mass squatting**: register a portfolio of premium names cheaply. With
  permissionless creation and no cost, 100 names cost only 100 transaction fees
  (~0.001 XLM each as of Protocol 25).

## Mitigations (v1)

### 1. Numeric-ID-canonical identity (implemented)

Since the `dao_id` is canonical, squatting a name label does not steal identity.
Search and indexer results rank by `dao_id` age (older = more established) and
display both `dao_id` and name. Squatted lookalikes are visually distinguishable.

### 2. Optional commit-reveal reservation (implemented)

`dao-registry` exposes a `commit_name` / `create_dao` two-step flow for callers
who want front-running resistance on premium names:

1. Compute off-chain: `commitment = SHA-256(name || nonce || caller_address)`
2. Call `commit_name(commitment, caller)` — stores a `NameReservation` entry
   keyed by the commitment hash.
3. Wait at least `REVEAL_MIN_WAIT_LEDGERS` (~5 minutes) before calling
   `create_dao`. A verifier in `create_dao` checks the reservation if the
   caller supplies a `nonce` argument.
4. The reservation expires after `RESERVATION_TTL_LEDGERS` (~1 hour) if unused.

Commit-reveal is **optional**. Callers that accept the small front-running risk
can call `create_dao` directly.

### 3. Search anti-spoofing (to implement)

`GET /daos?search` results MUST:

- Return both `dao_id` and `name` in every row.
- Sort results with oldest `dao_id` first when names collide.
- Never present a younger DAO with a matching name above an older DAO.

Frontend name-search UI MUST display `#<dao_id>` next to every name result.

## Reverse-Griefing Note

A per-user creation-rate limit could be introduced to raise the cost of mass
squatting without blocking legitimate use. This is deferred to a follow-up;
the numeric-ID-canonical model already removes the economic incentive for
squatting names.

## Non-Goals

- Trademark / legal name protection.
- Unique name enforcement (would break permissionless creation).
- EVM-style fee-auction front-running resistance (not applicable on Soroban).
