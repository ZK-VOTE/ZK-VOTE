export const HORIZON_ASSET_DECIMALS = 7;
export const SOROBAN_ASSET_DECIMALS = 12;
export const STROOPS_PER_UNIT = 10_000_000n;
export const SOROBAN_UNITS_PER_STROOP = 100_000n;
const MAX_STELLAR_STROOPS = 9_223_372_036_854_775_807n;

export function parseStroops(amount: string, allowZero = false): bigint {
  if (typeof amount !== "string") {
    throw new Error("Amount must be a decimal string");
  }

  const match = /^(0|[1-9]\d*)(?:\.(\d{1,7}))?$/.exec(amount);
  if (!match) {
    throw new Error("Amount must use at most 7 decimal places");
  }

  const whole = BigInt(match[1]);
  const fractional = BigInt((match[2] ?? "").padEnd(7, "0") || "0");
  const stroops = whole * STROOPS_PER_UNIT + fractional;
  if ((!allowZero && stroops === 0n) || stroops > MAX_STELLAR_STROOPS) {
    throw new Error("Amount is outside the Stellar int64 range");
  }
  return stroops;
}

export function formatStroops(stroops: bigint): string {
  if (stroops < 0n || stroops > MAX_STELLAR_STROOPS) {
    throw new Error("Stroop amount is outside the Stellar int64 range");
  }
  const whole = stroops / STROOPS_PER_UNIT;
  const fractional = (stroops % STROOPS_PER_UNIT).toString().padStart(7, "0");
  return `${whole}.${fractional}`;
}

export function canonicalizeStellarAmount(
  amount: string,
  allowZero = false,
): string {
  return formatStroops(parseStroops(amount, allowZero));
}

/** Convert 7-decimal Horizon stroops to 12-decimal Soroban token units exactly. */
export function horizonStroopsToSorobanAmount(stroops: bigint): bigint {
  if (stroops < 0n || stroops > MAX_STELLAR_STROOPS) {
    throw new Error("Stroop amount is outside the Stellar int64 range");
  }
  return stroops * SOROBAN_UNITS_PER_STROOP;
}

/** Convert 12-decimal Soroban token units to Horizon stroops without rounding. */
export function sorobanAmountToHorizonStroops(amount: bigint): bigint {
  if (amount < 0n || amount % SOROBAN_UNITS_PER_STROOP !== 0n) {
    throw new Error("Soroban amount is not exactly representable with 7 Horizon decimals");
  }
  const stroops = amount / SOROBAN_UNITS_PER_STROOP;
  if (stroops > MAX_STELLAR_STROOPS) {
    throw new Error("Converted Horizon amount exceeds the Stellar int64 range");
  }
  return stroops;
}

export function stellarDecimalToSorobanAmount(
  amount: string,
  allowZero = false,
): bigint {
  return horizonStroopsToSorobanAmount(parseStroops(amount, allowZero));
}

/**
 * Canonical Stellar / Soroban amount utilities (SPIKE-098 / #764).
 *
 * All monetary values travel as BigInt stroops internally.  This module is
 * the single boundary that converts between the 7-decimal-string form Horizon
 * accepts ("10.0000000") and the integer-stroop form used everywhere else.
 *
 * Float64 money paths are forbidden — all arithmetic uses BigInt.
 *
 * Rounding direction table (per boundary):
 * ─────────────────────────────────────────────────────────────────────────
 *  Boundary                          Direction   Rationale
 * ─────────────────────────────────────────────────────────────────────────
 *  Horizon decimal → stroops         exact       7-decimal input; reject any
 *                                                sub-stroop precision silently
 *                                                mis-parsed as a larger int.
 *  Soroban i128 → stroops            floor       User receives ≤ quoted;
 *                                                relayer keeps dust.
 *  Stroops → Soroban i128            floor       Relayer absorbs dust; dust
 *                                                posted to dust ledger.
 *  Fee (stroops) → XLM display       ceil        Never under-report cost.
 *  Batch pro-rata split              floor       Remainder in relayer account;
 *                                                swept on settlement.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Dust ownership rule: any remainder from a floor division is relayer dust
 * and must be tracked via `DustLedger` (caller's responsibility) rather than
 * silently discarded.  Functions that produce dust return it explicitly.
 */

export const STROOPS_PER_XLM = 10_000_000n;

/**
 * Soroban smart-contract amounts use a 5-decimal fixed-point scale
 * (1 Soroban unit = 100_000 stroops = 0.01 XLM).  This constant converts
 * between the two integer domains.  Non-divisible conversions always use
 * floor so dust goes to the relayer, never to an unchecked discard.
 */
export const SOROBAN_STROOPS_FACTOR = 100_000n;

// ── Horizon decimal ↔ stroops ────────────────────────────────────────────

/**
 * Parse a Stellar 7-decimal-place string to a BigInt stroop count.
 *
 * Throws `RangeError` if the value has more than 7 decimal places (would
 * silently truncate float arithmetic) or is negative.
 *
 * @example parseDecimalToStroops("10.0000000") === 100_000_000n
 * @example parseDecimalToStroops("0.0000001") === 1n  // 1 stroop
 */
export function parseDecimalToStroops(decimal: string): bigint {
  const trimmed = decimal.trim();
  if (trimmed === "" || trimmed === "-" || trimmed.startsWith("-")) {
    throw new RangeError(`Stellar amounts must be non-negative; got: ${decimal}`);
  }

  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > 7) {
    throw new RangeError(
      `Amount has ${frac.length} decimal places; Stellar allows at most 7. Value: ${decimal}`
    );
  }

  const paddedFrac = frac.padEnd(7, "0");
  const stroops = BigInt(whole) * STROOPS_PER_XLM + BigInt(paddedFrac);
  return stroops;
}

/**
 * Format a BigInt stroop count to a Stellar 7-decimal-place string.
 *
 * @example formatStroopsToDecimal(100_000_000n) === "10.0000000"
 * @example formatStroopsToDecimal(1n) === "0.0000001"
 */
export function formatStroopsToDecimal(stroops: bigint): string {
  if (stroops < 0n) throw new RangeError(`Stroops must be non-negative; got: ${stroops}`);
  const whole = stroops / STROOPS_PER_XLM;
  const frac = stroops % STROOPS_PER_XLM;
  return `${whole}.${frac.toString().padStart(7, "0")}`;
}

// ── Directed division with explicit dust ─────────────────────────────────

export interface DivisionResult {
  quotient: bigint;
  /** Remainder that must be posted to the caller's dust ledger. */
  dust: bigint;
}

/**
 * Divide `stroops` by `divisor` with documented direction.
 *
 * Always returns `dust` — callers must account for it rather than discard.
 */
export function divideStroops(
  stroops: bigint,
  divisor: bigint,
  direction: "floor" | "ceil"
): DivisionResult {
  if (divisor <= 0n) throw new RangeError(`Divisor must be positive; got: ${divisor}`);
  const quotient = stroops / divisor;
  const dust = stroops % divisor;
  if (direction === "ceil" && dust > 0n) {
    return { quotient: quotient + 1n, dust: 0n };
  }
  return { quotient, dust };
}

// ── Soroban i128 ↔ stroops ───────────────────────────────────────────────

/**
 * Convert a Soroban i128 amount to Stellar stroops.
 *
 * Direction: floor — the user receives at most what was quoted; the relayer
 * absorbs any sub-stroop dust.  Returns dust so callers can post it.
 */
export function sorobanToStroops(sorobanAmount: bigint): DivisionResult {
  if (sorobanAmount < 0n) {
    throw new RangeError(`Soroban amount must be non-negative; got: ${sorobanAmount}`);
  }
  return divideStroops(sorobanAmount, SOROBAN_STROOPS_FACTOR, "floor");
}

/**
 * Convert Stellar stroops to a Soroban i128 amount.
 *
 * Direction: floor — the relayer absorbs dust; dust is returned for posting.
 */
export function stroopsToSoroban(stroops: bigint): DivisionResult {
  if (stroops < 0n) throw new RangeError(`Stroops must be non-negative; got: ${stroops}`);
  return divideStroops(stroops, SOROBAN_STROOPS_FACTOR, "floor");
}

// ── Batch pro-rata split ─────────────────────────────────────────────────

export interface BatchSplitResult {
  /** Per-recipient stroop amount (same for all recipients; dust not included). */
  perRecipient: bigint;
  /** Total remainder dust that must be posted to the relayer dust ledger. */
  dust: bigint;
}

/**
 * Split `totalStroops` evenly across `recipientCount` recipients.
 *
 * Direction: floor — each recipient receives the floor; the remainder stays
 * with the relayer and must be swept on settlement.
 */
export function splitBatchStroops(
  totalStroops: bigint,
  recipientCount: bigint
): BatchSplitResult {
  if (recipientCount <= 0n) {
    throw new RangeError(`Recipient count must be positive; got: ${recipientCount}`);
  }
  const { quotient, dust } = divideStroops(totalStroops, recipientCount, "floor");
  return { perRecipient: quotient, dust };
}

// ── Fee display ───────────────────────────────────────────────────────────

/**
 * Format a fee in stroops for user display as an XLM decimal.
 *
 * Direction: ceil — never under-report the cost the user will pay.
 */
export function formatFeeStroopsForDisplay(feeStroops: bigint): string {
  const { quotient } = divideStroops(feeStroops, 1n, "ceil");
  return formatStroopsToDecimal(quotient);
}

/**
 * Parse a fee string from Horizon (may be a plain stroop integer or 7-decimal
 * XLM) and return its stroop value as BigInt, replacing the float path in
 * ttl.ts that previously used `Number(feeStr) / 10_000_000` (lossy above 2^53
 * stroops and undefined rounding direction).
 *
 * Accepts:
 *   "100"          → 100n (plain integer, already in stroops)
 *   "0.0000100"    → 100n (7-decimal XLM string)
 */
export function parseFeeStringToStroops(feeStr: string): bigint {
  const trimmed = feeStr.trim();
  if (trimmed.includes(".")) {
    return parseDecimalToStroops(trimmed);
  }
  const v = BigInt(trimmed);
  if (v < 0n) throw new RangeError(`Fee must be non-negative; got: ${feeStr}`);
  return v;
}
