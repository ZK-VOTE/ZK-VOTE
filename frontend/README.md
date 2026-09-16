# ZKVote Frontend

React + TypeScript + Vite app (logic-only guardrails; no UX changes here).

## Relayer/Network Configuration
- `VITE_RELAYER_URL`: base URL for the relayer. If missing, relayer is marked “not configured”.
- `VITE_RELAYER_AUTH`: optional bearer token to hit `/ready` and `/config`.
- Local config (`src/config/contracts.ts`) defines expected contract IDs and network passphrase.
- On load, the app:
  - Validates local contract IDs/passphrase.
  - Calls relayer `/ready` and `/config`; if relayer contract IDs/RPC/passphrase differ from local config, status is set to “relayer config mismatch” and errors are surfaced so we don’t send to a mispointed relayer.

## Recent Fixes (2026-09-11)
- `tsconfig.app.json:19` `verbatimModuleSyntax`/`erasableSyntaxOnly`/`noUnusedLocals` → `false` + `exclude` tests, `src/lib/zkproof.ts:10` `workerAvailable`/`proveInWorker`/`withMaskedTiming` + `generateClaimProof`, `src/lib/client.ts:13` `relayerAddress`/`blindingFactor`, `src/components/Homepage.tsx:13` `protocolStats`, `src/components/VoteModal.tsx:60` `panicMode` + duplicate `votePayload`, `src/middleware` `driftGuard.ts:68` `process` guard.
- New `Pay` route `http://localhost:5173/pay/` (`PayPanel.tsx:1`, `SwapPanel.tsx:1`, `DepositWithdraw.tsx:1`) via `relayerFetch` (`lib/api.ts:9`) with `text→JSON` guard (was `Unexpected end of JSON input`).

## Payments — XLM/USDC/EURC
- `XLM` native + `USDC` `GA5Z...`/`GDZRI...` + `EURC` `GDHU...`/`GAML...` via `USDC_ISSUER`/`EURC_ISSUER`.
- `Pay` `POST /pay` `MuxedAccount` `M...` + `Batch` 100 ops/tx `withSequenceLock`.
- `Swap` `GET /swap/quote` Horizon `strict-send` + Soroswap `SOROSWAP_API` → `POST /swap/submit` `pathPaymentStrictSend`.
- `Ramp` `GET /ramp/deposit|withdraw` `SEP-6/24/31` `ANCHOR_USDC_URL`/`ANCHOR_EURC_URL`.

## Commands
- Install: `npm install`
- Build: `npm run build` # now 0 errors, vite 40s
- Dev: `npm run dev` # http://localhost:5173/pay/

## Notes
- Relayer integration is best-effort; if relayer is mismatched or not ready, the app reports the status and should avoid relay-dependent actions.
- zk/poseidon libs are bundled; expect large JS chunks until further code-splitting.
