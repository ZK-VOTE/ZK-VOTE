/**
 * Single-source-of-truth for all runtime URLs consumed by the frontend.
 *
 * All three service URLs (relayer, Soroban RPC, Horizon) are read from
 * Vite env vars so they can be overridden per-environment without
 * touching compiled output.  Downstream modules MUST import from here
 * rather than hard-coding values or calling `import.meta.env` directly.
 *
 * Issue #556 — config drift fix: previously `NETWORK_CONFIG.rpcUrl` was
 * hard-coded in `contracts.ts`, `RELAYER_URL` lived inline in `api.ts`,
 * and `HORIZON_URL` had no canonical home.  This file is the single
 * composition-root for all three.
 */

/** Backend relayer base URL (no trailing slash). */
export const RELAYER_URL: string =
  (import.meta.env.VITE_RELAYER_URL as string | undefined)?.replace(/\/$/, "") ??
  "http://localhost:3001";

/** Stellar Soroban RPC endpoint. */
export const SOROBAN_RPC_URL: string =
  (import.meta.env.VITE_SOROBAN_RPC_URL as string | undefined) ??
  "https://soroban-testnet.stellar.org";

/** Stellar Horizon REST endpoint. */
export const HORIZON_URL: string =
  (import.meta.env.VITE_HORIZON_URL as string | undefined) ??
  "https://horizon-testnet.stellar.org";

/**
 * Deployed `TreasuryEscrow.sol` address (ZV-107). Empty when unset — the
 * escrow UI stays hidden rather than pointing at a placeholder address.
 */
export const TREASURY_ESCROW_ADDRESS: string =
  (import.meta.env.VITE_TREASURY_ESCROW_ADDRESS as string | undefined) ?? "";

/** Convenience: all three URLs as a plain object for logging / drift checks. */
export const SERVICE_URLS = {
  relayer: RELAYER_URL,
  sorobanRpc: SOROBAN_RPC_URL,
  horizon: HORIZON_URL,
} as const;
