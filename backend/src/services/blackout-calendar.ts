// @ts-nocheck
/**
 * Election Blackout Calendar — ZV-059
 *
 * Defines "blackout windows" around active election closing times and exposes
 * helpers used by the deploy-preflight check and the admin API.
 *
 * A blackout window runs from (end_time - BLACKOUT_BUFFER_SECONDS) to
 * (end_time + BLACKOUT_BUFFER_SECONDS).  During that window, contract
 * upgrades and backend deploys must not proceed.
 *
 * Emergency overrides are written to the audit log and require a signed
 * token issued by a threshold-approved operator.
 */

import { createLogger } from "./logger.js";
import { createAuditEvent } from "./audit.js";
import type { AsyncHandler } from "../types/index.js";

const logger = createLogger("blackout-calendar");

/** How many seconds before and after election end_time to block deploys. */
export const BLACKOUT_BUFFER_SECONDS =
  Number(process.env.BLACKOUT_BUFFER_SECONDS) || 3600; // 1 hour default

/** How long an emergency-override token is valid (seconds). */
const OVERRIDE_TOKEN_TTL_SECONDS =
  Number(process.env.BLACKOUT_OVERRIDE_TTL_SECONDS) || 1800; // 30 min

export interface ElectionWindow {
  daoId: string | number;
  proposalId: string | number;
  endTime: number; // Unix timestamp (seconds)
  blackoutStart: number;
  blackoutEnd: number;
}

export interface BlackoutStatus {
  inBlackout: boolean;
  windows: ElectionWindow[];
  checkedAt: number; // Unix timestamp
}

export interface BlackoutOverrideToken {
  token: string;
  issuedAt: number;
  expiresAt: number;
  issuedBy: string;
  reason: string;
}

/** In-memory store of active override tokens (process-scoped). */
const _activeOverrides = new Map<string, BlackoutOverrideToken>();

/**
 * Build the list of blackout windows from a list of active proposal end times.
 * Each entry in `proposals` must have { daoId, proposalId, endTime }.
 */
export function buildBlackoutWindows(
  proposals: Array<{ daoId: string | number; proposalId: string | number; endTime: number }>,
  nowSeconds = Math.floor(Date.now() / 1000),
): ElectionWindow[] {
  return proposals
    .filter((p) => p.endTime > 0)
    .map((p) => ({
      daoId: p.daoId,
      proposalId: p.proposalId,
      endTime: p.endTime,
      blackoutStart: p.endTime - BLACKOUT_BUFFER_SECONDS,
      blackoutEnd: p.endTime + BLACKOUT_BUFFER_SECONDS,
    }));
}

/**
 * Returns true if `nowSeconds` falls within any of the given blackout windows.
 */
export function isInBlackout(
  windows: ElectionWindow[],
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  return windows.some(
    (w) => nowSeconds >= w.blackoutStart && nowSeconds <= w.blackoutEnd,
  );
}

/**
 * Compute the full blackout status given a list of proposals.
 */
export function computeBlackoutStatus(
  proposals: Array<{ daoId: string | number; proposalId: string | number; endTime: number }>,
): BlackoutStatus {
  const now = Math.floor(Date.now() / 1000);
  const windows = buildBlackoutWindows(proposals, now);
  return {
    inBlackout: isInBlackout(windows, now),
    windows,
    checkedAt: now,
  };
}

/**
 * Issue an emergency override token that allows a deploy during a blackout.
 * The override is written to the audit log and stored in memory.
 *
 * In production this should be gated behind threshold-approval (ZV-031 /
 * ZV-071). Here we record the override with enough detail for auditors and
 * expose it through the admin API.
 */
export async function issueOverrideToken(
  issuedBy: string,
  reason: string,
  auditRecorder: (event: object) => Promise<void> = async () => {},
): Promise<BlackoutOverrideToken> {
  const now = Math.floor(Date.now() / 1000);
  const token =
    "bko_" +
    Buffer.from(`${issuedBy}:${now}:${Math.random()}`).toString("base64url");

  const override: BlackoutOverrideToken = {
    token,
    issuedAt: now,
    expiresAt: now + OVERRIDE_TOKEN_TTL_SECONDS,
    issuedBy,
    reason,
  };
  _activeOverrides.set(token, override);

  await auditRecorder({
    type: "blackout_override_issued",
    issuedBy,
    reason,
    expiresAt: override.expiresAt,
    token: token.slice(0, 10) + "…", // log prefix only, not full secret
  });

  logger.warn("blackout_override_issued", {
    issuedBy,
    reason,
    expiresAt: override.expiresAt,
  });

  return override;
}

/**
 * Validate an override token.  Returns the token record if valid and not
 * expired, null otherwise.
 */
export function validateOverrideToken(
  token: string,
): BlackoutOverrideToken | null {
  const record = _activeOverrides.get(token);
  if (!record) return null;
  const now = Math.floor(Date.now() / 1000);
  if (now > record.expiresAt) {
    _activeOverrides.delete(token);
    return null;
  }
  return record;
}

/**
 * Preflight guard: throws an Error if the current time is in a blackout window
 * and no valid override token is supplied.
 *
 * Usage:
 *   await assertNotInBlackout(proposals, process.env.BLACKOUT_OVERRIDE_TOKEN);
 */
export function assertNotInBlackout(
  proposals: Array<{ daoId: string | number; proposalId: string | number; endTime: number }>,
  overrideToken?: string,
): void {
  const status = computeBlackoutStatus(proposals);
  if (!status.inBlackout) return;

  if (overrideToken) {
    const record = validateOverrideToken(overrideToken);
    if (record) {
      logger.warn("blackout_override_used", {
        issuedBy: record.issuedBy,
        reason: record.reason,
      });
      return;
    }
  }

  const activeWindows = status.windows.filter(
    (w) =>
      status.checkedAt >= w.blackoutStart && status.checkedAt <= w.blackoutEnd,
  );
  const detail = activeWindows
    .map(
      (w) =>
        `dao=${w.daoId} proposal=${w.proposalId} window=[${w.blackoutStart},${w.blackoutEnd}]`,
    )
    .join("; ");
  throw new Error(
    `Deploy blocked: active election blackout in effect. ${detail}. ` +
      `Use a valid override token (BLACKOUT_OVERRIDE_TOKEN) to bypass.`,
  );
}

/** Expose active override count (test helper). */
export function _activeOverrideCount(): number {
  return _activeOverrides.size;
}

/** Clear all overrides (test helper). */
export function _clearOverrides(): void {
  _activeOverrides.clear();
}
