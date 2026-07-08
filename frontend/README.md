# ZKVote Frontend

React + TypeScript + Vite app (logic-only guardrails; no UX changes here).

## Relayer/Network Configuration
- `VITE_RELAYER_URL`: base URL for the relayer. If missing, relayer is marked “not configured”.
- `VITE_RELAYER_AUTH`: optional bearer token to hit `/ready` and `/config`.
- Local config (`src/config/contracts.ts`) defines expected contract IDs and network passphrase.
- On load, the app:
  - Validates local contract IDs/passphrase.
  - Calls relayer `/ready` and `/config`; if relayer contract IDs/RPC/passphrase differ from local config, status is set to “relayer config mismatch” and errors are surfaced so we don’t send to a mispointed relayer.

## Commands
- Install: `npm install`
- Build: `npm run build`
- Dev: `npm run dev`

## Notes
- Relayer integration is best-effort; if relayer is mismatched or not ready, the app reports the status and should avoid relay-dependent actions.
- zk/poseidon libs are bundled; expect large JS chunks until further code-splitting.
