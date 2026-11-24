/**
 * Muxed-Account Deposit Router — Attribution & Routing Fix (#761)
 *
 * Properly routes deposits to muxed accounts (M...) and their base accounts (G...).
 * Muxed accounts are NOT interchangeable with their base accounts — a deposit to
 * a muxed account must be routed to that specific sub-account, not the base.
 *
 * Key invariants:
 * - Deposits to M... must be attributed to the specific mux ID, not base account
 * - Exchange inflows use base G... accounts for liquidity aggregation
 * - Anchor inflows check both trustline ownership and mux routing
 */

import { log } from "./logger.js";
import { getDb } from "./db.js";
import * as StellarSdk from "@stellar/stellar-sdk";

export interface MuxedDepositRoute {
  destination: string; // M... or G...
  baseAccount: string; // Always G...
  muxId?: string; // Only set if M...
  isMuxed: boolean;
  attributionId: string; // Unique ID for deposit tracking
}

/**
 * Parses a Stellar address and extracts base account and mux ID.
 * Returns structured routing information for deposit attribution.
 */
export function parseMuxedAddress(address: string): MuxedDepositRoute {
  const isMuxed = address.startsWith("M");

  if (!isMuxed) {
    // Plain G... address
    if (!address.match(/^G[A-Z2-7]{55}$/)) {
      throw new Error(`Invalid Stellar address format: ${address}`);
    }
    return {
      destination: address,
      baseAccount: address,
      isMuxed: false,
      attributionId: `base:${address}`,
    };
  }

  // Muxed M... address
  if (!address.match(/^M[A-Z2-7]{68}$/)) {
    throw new Error(`Invalid muxed address format: ${address}`);
  }

  try {
    const ma = new StellarSdk.MuxedAccount(address, "0");
    const baseAccount = ma.baseAccount().accountId();
    const muxId = ma.id();

    return {
      destination: address,
      baseAccount,
      muxId,
      isMuxed: true,
      attributionId: `mux:${baseAccount}:${muxId}`,
    };
  } catch (e) {
    throw new Error(`Failed to parse muxed address: ${address}`);
  }
}

/**
 * Validates that a deposit destination has proper trustline ownership.
 * For muxed accounts, both the base account and the specific mux ID are tracked.
 */
export async function validateDepositDestination(
  destination: string,
  asset: "USDC" | "EURC" | "XLM",
): Promise<{
  valid: boolean;
  reason?: string;
  trustlineAccount: string;
}> {
  const route = parseMuxedAddress(destination);

  // For native assets, any valid address is acceptable
  if (asset === "XLM") {
    return {
      valid: true,
      trustlineAccount: route.baseAccount,
    };
  }

  // For credit assets, validate trustline on the base account
  // Muxed accounts inherit trustlines from their base account
  const db = getDb();
  const trustline = db
    .prepare(
      "SELECT account, asset FROM deposit_trustlines WHERE account = ? AND asset = ?",
    )
    .get(route.baseAccount, asset);

  if (!trustline) {
    return {
      valid: false,
      reason: `No ${asset} trustline found for base account ${route.baseAccount}`,
      trustlineAccount: route.baseAccount,
    };
  }

  return {
    valid: true,
    trustlineAccount: route.baseAccount,
  };
}

/**
 * Records a deposit with proper muxed account attribution.
 * Ensures the routing ID is recorded separately from trustline ownership.
 */
export async function recordMuxedDeposit(
  destination: string,
  asset: "USDC" | "EURC",
  amount: string,
  anchorTxnId: string,
  source: "exchange" | "anchor",
): Promise<void> {
  const route = parseMuxedAddress(destination);
  const db = getDb();

  const deposit = {
    deposit_id: `${anchorTxnId}:${route.attributionId}`,
    destination: route.destination,
    base_account: route.baseAccount,
    mux_id: route.muxId || null,
    asset,
    amount,
    anchor_txn_id: anchorTxnId,
    source,
    attributed_at: new Date().toISOString(),
  };

  // Anchor callbacks and payment reconciliation can replay the same
  // transaction. Treat an identical replay as a no-op, but reject reuse of
  // the same id with different attribution or value.
  const persist = db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT destination, asset, amount, source
         FROM muxed_deposits WHERE deposit_id = ?`,
      )
      .get(deposit.deposit_id) as
      | { destination: string; asset: string; amount: string; source: string }
      | undefined;

    if (existing) {
      if (
        existing.destination !== deposit.destination ||
        existing.asset !== deposit.asset ||
        existing.amount !== deposit.amount ||
        existing.source !== deposit.source
      ) {
        throw new Error(`Conflicting replay for deposit ${deposit.deposit_id}`);
      }
      return;
    }

    db.prepare(
      `
      INSERT INTO muxed_deposits
      (deposit_id, destination, base_account, mux_id, asset, amount, anchor_txn_id, source, attributed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      deposit.deposit_id,
      deposit.destination,
      deposit.base_account,
      deposit.mux_id,
      deposit.asset,
      deposit.amount,
      deposit.anchor_txn_id,
      deposit.source,
      deposit.attributed_at,
    );
  });
  persist();

  log("info", "muxed_deposit_attributed", {
    depositId: deposit.deposit_id,
    destination: route.destination,
    baseAccount: route.baseAccount,
    isMuxed: route.isMuxed,
    asset,
    amount,
    source,
  });
}

/**
 * Retrieves all deposits for a given destination (muxed or base account).
 * For muxed accounts, only returns deposits to that specific mux ID.
 */
export async function getDepositsForDestination(
  destination: string,
): Promise<
  Array<{
    depositId: string;
    amount: string;
    asset: string;
    source: "exchange" | "anchor";
    attributedAt: string;
  }>
> {
  const route = parseMuxedAddress(destination);
  const db = getDb();

  const deposits = db
    .prepare(
      `
    SELECT deposit_id, amount, asset, source, attributed_at
    FROM muxed_deposits
    WHERE destination = ?
    ORDER BY attributed_at DESC
    `,
    )
    .all(route.destination) as any[];

  return deposits.map((d) => ({
    depositId: d.deposit_id,
    amount: d.amount,
    asset: d.asset,
    source: d.source,
    attributedAt: d.attributed_at,
  }));
}

/**
 * Resolves deposit misrouting incidents where a deposit arrived at the wrong destination.
 * Records the correction for audit purposes and relayer fee adjustments.
 */
export async function resolveDepositMisroute(
  depositId: string,
  originalDestination: string,
  correctDestination: string,
  reason: string,
): Promise<void> {
  const db = getDb();

  const incident = {
    incident_id: `misroute:${depositId}:${Date.now()}`,
    deposit_id: depositId,
    original_destination: originalDestination,
    correct_destination: correctDestination,
    reason,
    resolved_at: new Date().toISOString(),
  };

  db.prepare(
    `
    INSERT INTO deposit_misroutes
    (incident_id, deposit_id, original_destination, correct_destination, reason, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?)
    `,
  ).run(
    incident.incident_id,
    incident.deposit_id,
    incident.original_destination,
    incident.correct_destination,
    incident.reason,
    incident.resolved_at,
  );

  log("warn", "deposit_misroute_resolved", {
    incidentId: incident.incident_id,
    depositId,
    originalDestination,
    correctDestination,
    reason,
  });
}
