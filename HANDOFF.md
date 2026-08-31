# ZK-VOTE Multi-Issue Program — Living Build / Handoff Document

**Program:** Issues #325 (XL), #326 (L), #358 (L), #369 (S) — executed in that
deliberate order (small/isolated first, so later issues build on hardened
foundations).

**Repo:** fork `Ay-obami/ZK-VOTE`, upstream `ZK-VOTE/ZK-VOTE`.
**Working dir:** `/home/ayobami/stellar-issues/ZK-VOTE` (clean clone of `main`
@ `746e98fa` at program start).

**Commit policy:** small, reviewable commits per milestone. Do NOT push until
explicit confirmation per checkpoint. Check in with the user at the end of
each of the four issues.

---

## Execution order & rationale (from program spec)

1. **#369** (S, ~3d) — parity tests for the Soroban BE conversion scripts.
   Correctness here underpins #325's on-chain claim acceptance test (an
   endianness bug would fail on-chain verification for the wrong reason).
2. **#358** (L, 1-2wk) — backend service-layer DI refactor, BEFORE #325's
   relayer route is written against the old pattern.
3. **#326** (L, 2wk) — generate TS bindings for the 5 advanced contracts;
   wire Threshold/Bridge panels. Needed context for #325's frontend.
4. **#325** (XL, 3wk) — Anonymous Vote-to-Earn full stack (circuit, on-chain
   claim + treasury, relayer route on #358's new DI pattern, UI on #326's
   bindings, sybil/THREAT_MODEL extension).

---

## Status board

| Issue | Status | Branch | Notes |
|-------|--------|--------|-------|
| #369 | DONE — committed, awaiting review | `feat/369-soroban-be-parity-tests` | 21 new tests, fixed vectors, CI step, mutation-verified |
| #358 | M1 DONE — in review | `feat/358-backend-di-refactor` | composition root + interfaces + factories; repaired merge-corrupted backend boot |
| #326 | TODO | — | ZK-091: NO reference found in repo (see below) |
| #325 | TODO | — | `circuits/claim.circom` ALREADY EXISTS; claim route already implemented (thin flow) |

---

## Issue #369 — Soroban BE conversion parity tests

**Scope:** `circuits/convert_proof_to_soroban_be.js`,
`circuits/convert_vkey_to_soroban_be.js`, `circuits/conversion-utils.js`,
`circuits/conversion-utils.test.js`, CI wiring (`.github/workflows/ci.yml`).

### What the scripts do (read in full)
- Both take snarkjs JSON and emit big-endian Soroban/CAP-74 byte layout.
- **G1** → `be32(X) || be32(Y)` (64 bytes). snarkjs is already big-endian, so
  NO byte reversal.
- **G2** → `be32(X.c1) || be32(X.c0) || be32(Y.c1) || be32(Y.c0)` (128 bytes).
  snarkjs stores G2 as `[[c0, c1], [c0, c1]]`, so the script swaps within
  each coordinate pair (imaginary first). Per-limb, not whole-buffer.
- `convert_proof_to_soroban_be.js` writes `proof_soroban_be.json` next to the
  proof file. `convert_vkey_to_soroban_be.js` writes
  `build/verification_key_soroban.json` + `frontend/src/lib/verification_key_soroban.json`.
- **Known quirk (pre-existing, NOT caused by us):** `scripts/compile-circuits.sh`
  redirects the *stdout* of `convert_vkey_to_soroban_be.js` to
  `$BUILD_DIR/verification_key_soroban.json`, but the script's own
  `fs.writeFileSync` already writes the JSON. The redirect captures the log
  banner, not pure JSON. The artifact written by the script itself is correct;
  the shell redirect pollutes a second copy. Note for later; not blocking #369.

### Existing test surface (at start)
- `conversion-utils.js` — extracted utils: `toBE32ByteHex`, `convertG1Point`,
  `convertG2Point`, `convertProofToSoroban`, `convertVKeyToSoroban`,
  `reverseHexBytes`.
- `conversion-utils.test.js` — unit tests for those utils (synthetic values),
  NO round-trip to snarkjs, NO real-circuit vectors, does not exercise the two
  CLI scripts themselves.
- `circuits/utils/proof_to_soroban.js` + `vkey_to_soroban.js` — a *different*,
  older conversion implementation (byte-array output). Used by
  `circuits/utils/test/proof_converter.test.js` (node:test; excluded from
  jest via `jest.config.js` `/utils/test/` ignore).
  NOTE: `utils/proof_to_soroban.js` has the SAME endianness/swap logic but is
  NOT the code path #369 covers. Out of scope unless drift is found.

### Known-good fixtures available in-repo (real circuit runs)
- `contracts/zkvote-groth16/tests/comment_v2_real_proof.rs` — real
  comment_v2.circom proof + VK in Soroban BE hex, VERIFIED ON-CHAIN via the
  production BN254 pairing path. The conversion was done by these exact
  scripts. → the anchor vector for #369.
- `frontend/public/circuits/verification_key.json` (snarkjs decimal) +
  `frontend/public/circuits/verification_key_soroban.json` (converted) — a
  full snarkjs→Soroban fixed vector pair for the vote circuit VK.

### Work items / milestones (updating as I go)
- [x] M1: Reverse-conversion helpers in `conversion-utils.js`
      (soroban→snarkjs decode) to enable true round-trip tests.
      Added: `beHexToBigInt`, `sorobanG1ToSnarkjs`, `sorobanG2ToSnarkjs`,
      `sorobanProofToSnarkjs`, `sorobanVKeyToSnarkjs`.
- [x] M2: Parity test suite with round-trip + real-vector fixtures.
      NEW `circuits/soroban_be_parity.test.js` (14 tests) +
      `circuits/parity-fixtures.js` (comment_v2 proof/VK/public signals from
      the on-chain-verified Rust fixture; vote VK snarkjs+Soroban pair from
      frontend/public/circuits).
- [x] M3: CLI black-box tests — NEW `circuits/soroban_be_cli.test.js` (4 tests)
      spawns the real scripts against temp fixtures. To make the vkey script
      hermetic, `convert_vkey_to_soroban_be.js` gained an optional 3rd arg
      (output path); default behavior unchanged. Both CLI scripts refactored
      to use `conversion-utils.js` (previously duplicated the conversion
      logic inline).
- [x] M4: CI wiring — `npm run test:parity` script added; explicit
      "Run Soroban BE conversion parity tests (#369)" step added to the
      `circuits` job in `.github/workflows/ci.yml` (the new files are also
      picked up by the existing `npm test` jest run).
- [x] M5: Mutation checks — (a) forced little-endian byte order in
      `toBE32ByteHex`: 6 parity tests failed; (b) forced a *symmetric* G2
      real/imaginary limb-swap omission in BOTH encode and decode: the 3
      fixed-vector tests failed while all round-trip tests still passed,
      proving the fixed vectors catch the exact class of bug a pure
      round-trip suite would miss. Both reverted; suite green again.

### Verified at milestone close
- `npx jest soroban_be_parity soroban_be_cli conversion-utils` → 17 + existing
  util suite all PASS.
- Full `npx jest` (circuits) → my suites PASS; `comment_v2.test.js` FAILS on
  main REGARDLESS of #369 (see below).

### PRE-EXISTING issue found (NOT part of #369, do not fix in this branch)
- `comment_v2.test.js` and `vote_v2.test.js` fail on clean `main`:
  1. `DOMAIN_TAG is the exact same constant...` — the test regexes each
     `.circom` for `var DOMAIN_TAG = <digits>;`, but committed
     `comment_v2.circom`/`vote_v2.circom` do NOT contain that line
     (only `vote.circom` and `comment.circom` do).
  2. `Signal blindingFactor not found` — the test builds inputs with a
     `blindingFactor` and `commitment = Poseidon(DOMAIN_TAG, secret, salt,
     blindingFactor)`, but the committed `comment_v2.circom` uses the OLD
     scheme `commitment = Poseidon(secret, salt)` (2-input Poseidon, no
     DOMAIN_TAG). #349's fix (commit db2c4dc3) evidently restored the
     template line but the circuit files drifted again.
  - Impact: `npm test` in the circuits CI job is ALREADY red on main.
    Flag to maintainers; track separately. Relevant later for #325 (claims
    will mirror the voting/comment commitment scheme) and #326.




---

## Issue #358 — Backend service-layer DI

**Status: MILESTONE 1 (foundation) DONE, in review. Follow-up milestones below.**

### Session 1 deliverable (committed on `feat/358-backend-di-refactor`)
- **NEW `backend/src/services/interfaces.ts`** — typed dependency surfaces:
  `RpcServerPort`, `RpcPoolPort`, `RpcEndpointStatus`, `StellarContext`,
  `DbPort`, `LoggerPort`, `MetricsSink`. Structural types → mocks satisfy them.
- **NEW `backend/src/composition-root.ts`** — `buildAppServices()`: the single
  construction site. Builds the `StellarContext` (server, keypair, sequence
  lock, timeouts) and calls `initCircuitRegistry(...)` with explicit deps.
  `index.ts` calls it after `validateEnv()`.
- **`stellar.ts` refactored** — extracted factories:
  `createRelayerKeypair(secret, testMode)`, `createRpcPool(urls, {fallbackUrl,
  serverFactory})`, `createSorobanServer({testMode, pool, breaker})`.
  `RpcPoolManager` now accepts an injectable server factory + fallback URL
  (testable without a live RPC). Module singletons now delegate to the
  factories.
- **`circuit-registry.ts` refactored** — `initCircuitRegistry(deps)` +
  `CircuitRegistryDeps`; the service no longer imports `stellar.js` globals.
  Throws if used before init (no silent global fallback).
- **`index.ts` wired** — uses `services.stellar.*` for health-route init,
  graceful shutdown drain, indexer start, startup log; removed the direct
  `stellar.js` import. **Also repaired the pre-existing merge corruption that
  made `index.ts` fail to parse** (see below).
- **NEW unit tests with mocks** — `test/di/circuit-registry.test.ts` (6) +
  `test/di/rpc-pool.test.ts` (8): injected mock servers/keypairs, no live RPC.
  All 14 PASS.

### Pre-existing backend breakage repaired along the way (merge corruption at HEAD 746e98fa)
`index.ts` did NOT parse on main (`tsc` error TS1128 at line 348; brace balance
-1). Root cause: the `feat/unified-advanced-features` merge corrupted index.ts,
config.ts and middleware. Repairs made (all verified to preserve intent vs.
pre-merge git history):
1. **index.ts gracefulShutdown** — duplicated startup-banner block removed;
   restored `drained = await waitForSequenceLockIdle(...)`,
   `closeDb()`, and the sequence-lock-drain log (from commit 940bc9ab).
2. **index.ts missing imports restored** — `metricsMiddleware`,
   `degradationContext`, `metricsRoutes`, `remediationRoutes`,
   `registerShutdownHandler` were referenced but never imported.
3. **index.ts `/openapi.json` + `/api-docs` routes restored**; removed bogus
   `import { buildOpenApiDocument }` (openapi.ts exports `openApiSpec`).
4. **middleware/index.ts** — removed the `export { auditLog }` re-export of an
   internal (non-exported) array.
5. **middleware/audit.ts** — restored the `auditLog(action)` middleware factory
   that `routes/daos.ts` + `routes/threshold.ts` import (the audit rewrite
   replaced it with the global `auditMiddleware`); renamed the internal array
   to `auditStore`.
6. **config.ts validateEnv** — restored the `missing` array (was `missing is
   not defined` at runtime) and made `AUTH_MASTER_KEY` non-required in test
   mode (pre-corruption didn't require it at all).

**Verified:** backend **boots** in test mode (`/health` returns full payload;
`/openapi.json` serves spec). `tsc --noEmit`: my files contribute ZERO errors
(remaining ~21 errors are pre-existing on main: `config.ts` rewardsContractId,
`claim.ts`, `exclusion-proof.ts`, unused imports in index.ts).

### Full-suite triage after repair (DONE, conclusive)
- **Corrupted baseline** (main @ 746e98fa): 295 pass / 89 fail — but the app
  did NOT load, so dozens of test FILES crashed at file level (import
  cascade); their subtests never ran.
- **After repair + DI refactor** (`npm test`, includes `test/di/*`):
  476 pass / 94 fail (584 total).
- **Failures diffed against baseline**: only **15** failure NAMES are new,
  and every one of them lives in test files that were file-level crash
  failures in baseline (`route-branches`, `route-coverage`, `vote-integration`,
  `vote-outcomes`, ipfs/comments/daos boundary tests). They are latent
  pre-existing test-vs-behavior mismatches now exposed by the boot fix — the
  dominant pattern is **52 `403 !== X`** (CSRF guard blocks POSTs without
  Origin/Referer BEFORE auth returns 401/400 — confirmed the csrfGuard mount
  order is byte-identical to pre-corruption commit 9290e9e1, CAS is unchanged).
- **CONCLUSION: the #358 refactor introduces ZERO regressions.** The remaining
  failures are pre-existing backend bugs (CSRF test ordering, circuit-status
  200-vs-400 route logic, IPFS boundary assertions) to be triaged as separate
  follow-up work, NOT part of #358's DI scope.

### Dependency map (from full read of `backend/src/services/*`)
Core surfaces consumed: `config` (~15 svcs), `logger` (~25), `db` (~10),
`stellar` (~7), `metrics` (~7).
- `db.ts` → dbMonitor, kysely, migrate, walResilience, config, logger
- `kysely.ts` → db (CIRCULAR: db↔kysely — resolve via DI when migrating)
- `stellar.ts` → circuit-breaker, cluster, config, db, logger, metrics
- `sync.ts` → config, db, indexer, logger, metrics, service-health, stellar
- `sbt-guard.ts` → config, db, logger, service-health, stellar
- `ttl.ts` → config, db, logger, service-health, stellar, ttl-checker
- `bridge.ts` → config, logger, stellar
- `circuit-registry.ts` → config, logger, stellar  ✅ REFACTORED
- Module-level `let` singleton state (grep): ipfs, pow, cluster, dbWorker,
  db, ipfs-pin-manager, indexer-tracing, archival, memory-monitor,
  walResilience, audit, remediation, ttl, dbMonitor, circuit-registry cache.

### Follow-up milestones (next sessions)
- [ ] M2: migrate `ttl.ts` (has an existing `TTLSubmitter` setter precedent —
      formalize with `initTtlService(deps)`), `bridge.ts` service (currently
      dead code — no consumers; the bridge ROUTE inlines its own logic),
      `anti-spam.ts`, `sbt-guard.ts`, `sync.ts` to the same init-injection
      pattern.
- [ ] M3: `db.ts` factory (`createEventDb({metrics, config})`) to break the
      db↔kysely cycle; move `getDb()` behind `DbPort`.
- [ ] M4: `ttl.ts`/`sync.ts`/`indexer.ts` timer services — inject interval
      factories for deterministic tests (fake timers).
- [ ] M5: sweep — grep for remaining `let ` singletons; confirm no service
      imports `stellar.js`/`db.js` directly; each migrated service has a
      mock-based unit test.
- [ ] NOTE for #325: the claim route (routes/claim.ts) currently imports
      `stellar.js` globals directly — rewrite it against `StellarContext`
      from the composition root when #325 lands.

---

## Issue #326 — Advanced contract TS bindings (not started)

- Five contracts: `contracts/token`, `threshold-crypto`, `circuit-registry`,
  `vdf`, `bridge`.
- **ZK-091 dependency: searched the whole repo (1007 commits, 3065 files) —
  NO reference found.** Also ran a broad grep for the string `ZK-091`; zero
  hits in code, comments, docs, or commit messages. Conclusion: treat ZK-091
  as a *deferred/external ticket reference*. The real gate is
  `cargo test -p threshold-crypto` — run it when #326 starts and document the
  actual failure (if any) instead of guessing at ZK-091's content.
- Frontend panels to wire: `frontend/src/.../ThresholdPanel.tsx`,
  `BridgePanel.tsx`. `config/contracts` holds deployed addresses
  (`.deployed-contracts`, `.deployed-contracts-futurenet` at repo root).

---

## Issue #325 — Vote-to-Earn (not started)

- **`circuits/claim.circom` ALREADY EXISTS** (3833 bytes, at repo head).
  Must read it before assuming it needs writing from scratch — 4a may be
  partially/fully designed already.
- `contracts/rewards` and `contracts/token` exist in `contracts/`.
- Existing vote circuit nullifier pattern: `H(secret, daoId, proposalId)`;
  on-chain storage keyed by `(dao_id, proposal_id, nullifier)` (per
  THREAT_MODEL.md). Mirror this for claim, do not invent a new scheme.

---

## Environment notes (important)

- `node v22.23.2`, `npm 10.9.8`. npm registry reachable but FLAPPY — retry
  `npm install` if it fails; first attempt timed out, second succeeded.
- Terminal output capture is unreliable in this session; use
  `cmd > /tmp/x.log 2>&1; echo done > /tmp/x.done` and then `read_files` on
  the log. Do not rely on inline stdout.
- No `node_modules` anywhere for ZK-VOTE yet (circuits/frontend/backend all
  need fresh `npm install`). Other workspace repos' node_modules do NOT
  contain jest/snarkjs/circomlib.
- Rust toolchain: check `rustup toolchain list` before contract work
  (`rust-toolchain.toml` pins the version).
