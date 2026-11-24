export const HORIZON_ASSET_DECIMALS = 7;
export const SOROBAN_ASSET_DECIMALS = 12;
const STROOPS_PER_UNIT = 10_000_000n;
const SOROBAN_UNITS_PER_STROOP = 100_000n;
const MAX_STELLAR_STROOPS = 9_223_372_036_854_775_807n;

export function parseStroops(amount: string, allowZero = false): bigint {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,7}))?$/.exec(amount);
  if (!match)
    throw new Error("Use a positive amount with at most 7 decimal places");
  const stroops =
    BigInt(match[1]) * STROOPS_PER_UNIT +
    BigInt((match[2] ?? "").padEnd(7, "0") || "0");
  if ((!allowZero && stroops === 0n) || stroops > MAX_STELLAR_STROOPS) {
    throw new Error("Amount is outside the Stellar range");
  }
  return stroops;
}

export function formatStroops(stroops: bigint): string {
  if (stroops < 0n || stroops > MAX_STELLAR_STROOPS) {
    throw new Error("Stroop amount is outside the Stellar range");
  }
  return `${stroops / STROOPS_PER_UNIT}.${(stroops % STROOPS_PER_UNIT)
    .toString()
    .padStart(7, "0")}`;
}

export function canonicalizeStellarAmount(amount: string): string {
  return formatStroops(parseStroops(amount));
}

export function horizonStroopsToSorobanAmount(stroops: bigint): bigint {
  if (stroops < 0n || stroops > MAX_STELLAR_STROOPS) {
    throw new Error("Stroop amount is outside the Stellar range");
  }
  return stroops * SOROBAN_UNITS_PER_STROOP;
}

export function sorobanAmountToHorizonStroops(amount: bigint): bigint {
  if (amount < 0n || amount % SOROBAN_UNITS_PER_STROOP !== 0n) {
    throw new Error("Soroban amount is not exactly representable with 7 Horizon decimals");
  }
  const stroops = amount / SOROBAN_UNITS_PER_STROOP;
  if (stroops > MAX_STELLAR_STROOPS) {
    throw new Error("Converted amount is outside the Stellar range");
  }
  return stroops;
}

// ── Safe domain-form validators — SPIKE-132 / #923 ───────────────────────
//
// Mirror of the backend safeAmountSchema / safeAddressSchema / … for use in
// React forms.  Return `null` on success or a human-readable error string.
// All validators trim input before checking so a trailing space never causes
// a spurious error.
//
// Rules match the backend exactly:
//  • No scientific notation (e, E).
//  • No Unicode digits (only ASCII 0-9 accepted by the regex).
//  • No sub-stroop precision (> 7 decimal places).
//  • Zero and negative values rejected.
//  • Overflow (> i64 max) rejected.

const G_RE = /^G[A-Z2-7]{55}$/;
const M_RE = /^M[A-Z2-7]{68}$/;
const C_RE = /^C[A-Z2-7]{55}$/;
const AMOUNT_RE = /^[0-9]+(\.[0-9]+)?$/;
const MAX_WHOLE = "922337203685"; // floor(i64::MAX / 1e7)

/** Returns null on success, or an error string. */
export function validateStellarAmount(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Amount is required";
  if (/[eE]/.test(v)) return "Scientific notation is not allowed";
  if (!AMOUNT_RE.test(v)) return "Amount must be a plain decimal number (e.g. 10.5000000)";
  const [whole, frac] = v.split(".");
  if (frac && frac.length > 7) return "Amount must have at most 7 decimal places (stroop precision)";
  if (parseFloat(v) <= 0) return "Amount must be greater than zero";
  if (whole.length > MAX_WHOLE.length || (whole.length === MAX_WHOLE.length && whole > MAX_WHOLE)) {
    return "Amount exceeds the Stellar i64 maximum";
  }
  return null;
}

/** Validates a G... or M... Stellar destination address. */
export function validateStellarAddress(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Address is required";
  if (!G_RE.test(v) && !M_RE.test(v)) {
    return "Invalid Stellar address. Must be G... (56 chars) or M... (69 chars), base32 only";
  }
  return null;
}

/** Validates a Soroban C... contract ID. */
export function validateContractId(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Contract ID is required";
  if (!C_RE.test(v)) return "Invalid contract ID. Must be C... 56 chars, base32 only";
  return null;
}

/** Validates a Stellar asset code (1-12 alphanumeric chars). */
export function validateAssetCode(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Asset code is required";
  if (!/^[A-Za-z0-9]{1,12}$/.test(v)) return "Asset code must be 1-12 alphanumeric characters";
  return null;
}

/** Validates a Stellar text memo (max 28 bytes). */
export function validateMemoText(raw: string): string | null {
  if (!raw) return null; // memo is optional
  if (new TextEncoder().encode(raw).length > 28) return "Memo text must be 28 bytes or fewer";
  return null;
}
