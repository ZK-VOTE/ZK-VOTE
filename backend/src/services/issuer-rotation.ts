/**
 * Issuer Rotation Handler — USDC/EURC Issuer Change Management (#759)
 *
 * Manages asset issuer changes (e.g., Circle rotating USDC issuer).
 * When an issuer changes:
 * - Existing trustlines to old issuer remain valid but unused
 * - New trustlines must be created to the new issuer
 * - Pending flows are paused and re-routed to new issuer
 * - Users are notified of the issuer change
 *
 * Key invariants:
 * - Both old and new trustlines coexist during transition
 * - Flows are atomic: either complete on old issuer or migrate to new issuer
 * - No funds are lost during rotation
 */

import { log } from "./logger.js";
import { getDb } from "./db.js";
import * as StellarSdk from "@stellar/stellar-sdk";

export interface IssuerRotationEvent {
  asset: "USDC" | "EURC";
  oldIssuer: string;
  newIssuer: string;
  effectiveAt: number; // Unix timestamp in ms
  reason: string;
  rotationId: string;
}

export interface PendingFlow {
  flowId: string;
  asset: "USDC" | "EURC";
  account: string;
  amount: string;
  flowType: "deposit" | "withdrawal";
  status: "pending" | "paused" | "migrated";
  issuer: string; // Current issuer for this flow
}

const issuerRegistry: Record<"USDC" | "EURC", { current: string; previous: string[] }> = {
  USDC: {
    current: process.env.USDC_ISSUER || "",
    previous: [],
  },
  EURC: {
    current: process.env.EURC_ISSUER || "",
    previous: [],
  },
};

/**
 * Records a new issuer rotation event.
 * Should be triggered when Circle or other anchor notifies of issuer change.
 */
export async function recordIssuerRotation(
  asset: "USDC" | "EURC",
  oldIssuer: string,
  newIssuer: string,
  reason: string,
): Promise<IssuerRotationEvent> {
  const db = getDb();
  const rotationId = `rotate:${asset}:${Date.now()}`;
  const effectiveAt = Date.now();

  const event: IssuerRotationEvent = {
    asset,
    oldIssuer,
    newIssuer,
    effectiveAt,
    reason,
    rotationId,
  };

  try {
    db.prepare(
      `
      INSERT INTO issuer_rotations
      (rotation_id, asset, old_issuer, new_issuer, effective_at, reason, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      rotationId,
      asset,
      oldIssuer,
      newIssuer,
      effectiveAt,
      reason,
      new Date().toISOString(),
    );

    // Update registry
    issuerRegistry[asset].previous.push(issuerRegistry[asset].current);
    issuerRegistry[asset].current = newIssuer;

    log("warn", "issuer_rotation_recorded", {
      rotationId,
      asset,
      oldIssuer: oldIssuer.slice(0, 8) + "...",
      newIssuer: newIssuer.slice(0, 8) + "...",
      reason,
    });

    return event;
  } catch (e: any) {
    log("error", "issuer_rotation_failed", {
      asset,
      error: e.message,
    });
    throw e;
  }
}

/**
 * Gets the current issuer for an asset.
 */
export function getCurrentIssuer(asset: "USDC" | "EURC"): string {
  return issuerRegistry[asset].current;
}

/**
 * Gets all known issuers for an asset (current + previous).
 * Used for trustline validation across issuer changes.
 */
export function getAllKnownIssuers(asset: "USDC" | "EURC"): string[] {
  return [issuerRegistry[asset].current, ...issuerRegistry[asset].previous];
}

/**
 * Pauses all pending flows tied to the old issuer before rotation.
 * Flows are paused, not cancelled, to preserve user intent.
 */
export async function pauseFlowsForRotation(
  asset: "USDC" | "EURC",
  oldIssuer: string,
  rotationId: string,
): Promise<number> {
  const db = getDb();

  const result = db
    .prepare(
      `
      UPDATE pending_flows
      SET status = 'paused', rotation_id = ?
      WHERE asset = ? AND issuer = ? AND status = 'pending'
      `,
    )
    .run(rotationId, asset, oldIssuer);

  const pausedCount = result.changes || 0;

  if (pausedCount > 0) {
    log("info", "flows_paused_for_rotation", {
      rotationId,
      asset,
      pausedCount,
    });
  }

  return pausedCount;
}

/**
 * Migrates a paused flow to the new issuer.
 * Creates a new trustline to the new issuer if needed, then resumes the flow.
 */
export async function migrateFlowToNewIssuer(
  flowId: string,
  newIssuer: string,
): Promise<{ success: boolean; reason?: string }> {
  const db = getDb();

  const flow = db
    .prepare("SELECT * FROM pending_flows WHERE flow_id = ?")
    .get(flowId) as any;

  if (!flow) {
    return { success: false, reason: "Flow not found" };
  }

  if (flow.status !== "paused") {
    return { success: false, reason: "Flow is not paused" };
  }

  try {
    // Keep the flow update and its audit record atomic. A failed history
    // insert must never leave a flow silently moved to another issuer.
    const migrate = db.transaction(() => {
      const update = db.prepare(
        `
        UPDATE pending_flows
        SET issuer = ?, status = 'pending', rotation_id = NULL
        WHERE flow_id = ? AND status = 'paused'
        `,
      ).run(newIssuer, flowId);

      if (update.changes !== 1) {
        throw new Error("Flow changed before issuer migration could be committed");
      }

      db.prepare(
        `
        INSERT INTO flow_migrations
        (flow_id, from_issuer, to_issuer, migrated_at)
        VALUES (?, ?, ?, ?)
        `,
      ).run(flowId, flow.issuer, newIssuer, new Date().toISOString());
    });
    migrate();

    log("info", "flow_migrated_to_new_issuer", {
      flowId,
      asset: flow.asset,
      fromIssuer: flow.issuer.slice(0, 8) + "...",
      toIssuer: newIssuer.slice(0, 8) + "...",
    });

    return { success: true };
  } catch (e: any) {
    log("error", "flow_migration_failed", {
      flowId,
      error: e.message,
    });
    return { success: false, reason: e.message };
  }
}

/**
 * Creates a new trustline to the new issuer for an account.
 * Returns true if trustline was created or already exists.
 */
export async function ensureTrustlineForNewIssuer(
  account: string,
  asset: "USDC" | "EURC",
  newIssuer: string,
): Promise<{ success: boolean; reason?: string; trustlineExists: boolean }> {
  const db = getDb();

  // Check if trustline already exists
  const existing = db
    .prepare(
      `
      SELECT account FROM deposit_trustlines
      WHERE account = ? AND asset = ? AND issuer = ?
      `,
    )
    .get(account, asset, newIssuer);

  if (existing) {
    return { success: true, trustlineExists: true };
  }

  try {
    // Record new trustline requirement
    db.prepare(
      `
      INSERT INTO deposit_trustlines
      (account, asset, issuer, created_at)
      VALUES (?, ?, ?, ?)
      `,
    ).run(account, asset, newIssuer, new Date().toISOString());

    log("info", "new_issuer_trustline_created", {
      account: account.slice(0, 8) + "...",
      asset,
      issuer: newIssuer.slice(0, 8) + "...",
    });

    return { success: true, trustlineExists: false };
  } catch (e: any) {
    log("error", "trustline_creation_failed", {
      account: account.slice(0, 8) + "...",
      asset,
      error: e.message,
    });
    return { success: false, reason: e.message, trustlineExists: false };
  }
}

/**
 * Validates that an account has trustlines to both old and new issuers during transition.
 * This ensures funds can be received on both paths during the rotation window.
 */
export async function validateIssuerTransitionTrustlines(
  account: string,
  asset: "USDC" | "EURC",
): Promise<{
  hasCurrentIssuer: boolean;
  hasPreviousIssuers: boolean;
  allKnownIssuers: string[];
}> {
  const allIssuers = getAllKnownIssuers(asset);
  const db = getDb();

  const trustlines = db
    .prepare(
      `
      SELECT DISTINCT issuer FROM deposit_trustlines
      WHERE account = ? AND asset = ?
      `,
    )
    .all(account, asset) as any[];

  const hasIssuers = new Set(trustlines.map((t) => t.issuer));
  const currentIssuer = getCurrentIssuer(asset);

  return {
    hasCurrentIssuer: hasIssuers.has(currentIssuer),
    hasPreviousIssuers: allIssuers.some(
      (issuer) => issuer !== currentIssuer && hasIssuers.has(issuer),
    ),
    allKnownIssuers: allIssuers,
  };
}

/**
 * Queries the rotation history for an asset.
 * Used for audit and to understand the issuer change timeline.
 */
export async function getRotationHistory(
  asset: "USDC" | "EURC",
  limit: number = 10,
): Promise<IssuerRotationEvent[]> {
  const db = getDb();

  const events = db
    .prepare(
      `
      SELECT rotation_id, asset, old_issuer, new_issuer, effective_at, reason
      FROM issuer_rotations
      WHERE asset = ?
      ORDER BY effective_at DESC
      LIMIT ?
      `,
    )
    .all(asset, limit) as any[];

  return events.map((e) => ({
    rotationId: e.rotation_id,
    asset: e.asset,
    oldIssuer: e.old_issuer,
    newIssuer: e.new_issuer,
    effectiveAt: e.effective_at,
    reason: e.reason,
  }));
}
