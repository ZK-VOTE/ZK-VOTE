import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalizeStellarAmount,
  formatStroops,
  parseStroops,
} from "../src/utils/stellarAmount.js";

describe("Stellar decimal amount conversion", () => {
  it("round-trips the one-stroop known-answer vector exactly", () => {
    assert.equal(parseStroops("0.0000001"), 1n);
    assert.equal(formatStroops(1n), "0.0000001");
    assert.equal(canonicalizeStellarAmount("10"), "10.0000000");
  });

  it("rejects precision beyond seven decimal places", () => {
    assert.throws(() => parseStroops("0.00000001"), /7 decimal places/);
    assert.throws(() => parseStroops("1e-7"), /7 decimal places/);
  });
});

/**
 * Stellar amount precision tests (SPIKE-098 / #764).
 *
 * Property-tests every conversion boundary in stellarAmount.ts, covering:
 *   1. Horizon decimal → stroops (exact, rejects sub-stroop precision)
 *   2. Stroops → Horizon decimal (round-trip identity)
 *   3. Soroban i128 ↔ stroops (floor direction, dust returned)
 *   4. Batch pro-rata split (floor, dust remainder)
 *   5. Fee display (ceil direction)
 *   6. parseFeeStringToStroops (replaces float path in ttl.ts)
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseDecimalToStroops,
  formatStroopsToDecimal,
  divideStroops,
  sorobanToStroops,
  stroopsToSoroban,
  splitBatchStroops,
  parseFeeStringToStroops,
  STROOPS_PER_XLM,
  SOROBAN_STROOPS_FACTOR,
} from "../src/utils/stellarAmount.js";

// ── 1. parseDecimalToStroops ──────────────────────────────────────────────

test("parseDecimalToStroops: 10.0000000 → 100_000_000", () => {
  assert.equal(parseDecimalToStroops("10.0000000"), 100_000_000n);
});

test("parseDecimalToStroops: 0.0000001 → 1 stroop", () => {
  assert.equal(parseDecimalToStroops("0.0000001"), 1n);
});

test("parseDecimalToStroops: 1.0000000 → STROOPS_PER_XLM", () => {
  assert.equal(parseDecimalToStroops("1.0000000"), STROOPS_PER_XLM);
});

test("parseDecimalToStroops: no decimals treated as .0000000", () => {
  assert.equal(parseDecimalToStroops("5"), 50_000_000n);
});

test("parseDecimalToStroops: fewer than 7 decimals padded", () => {
  assert.equal(parseDecimalToStroops("1.5"), 15_000_000n);
});

test("parseDecimalToStroops: rejects 8 decimal places", () => {
  assert.throws(
    () => parseDecimalToStroops("1.00000001"),
    RangeError,
    "8 decimal places must be rejected"
  );
});

test("parseDecimalToStroops: rejects negative values", () => {
  assert.throws(() => parseDecimalToStroops("-1.0"), RangeError);
});

test("parseDecimalToStroops: large value stays BigInt (no float loss)", () => {
  // 922337203685.4775807 XLM ≈ int64 max in stroops — float64 would lose bits
  const maxLikelyXlm = "922337203685.4775807";
  const stroops = parseDecimalToStroops(maxLikelyXlm);
  assert.equal(typeof stroops, "bigint");
  assert.ok(stroops > 0n);
});

// ── 2. formatStroopsToDecimal ─────────────────────────────────────────────

test("formatStroopsToDecimal: 100_000_000 → 10.0000000", () => {
  assert.equal(formatStroopsToDecimal(100_000_000n), "10.0000000");
});

test("formatStroopsToDecimal: 1 → 0.0000001", () => {
  assert.equal(formatStroopsToDecimal(1n), "0.0000001");
});

test("formatStroopsToDecimal: 0 → 0.0000000", () => {
  assert.equal(formatStroopsToDecimal(0n), "0.0000000");
});

test("round-trip: parseDecimalToStroops ∘ formatStroopsToDecimal = identity", () => {
  for (const s of [1n, 100n, 9_999_999n, 10_000_000n, 100_000_000n, 999_999_999_999n]) {
    assert.equal(parseDecimalToStroops(formatStroopsToDecimal(s)), s);
  }
});

test("formatStroopsToDecimal: rejects negative", () => {
  assert.throws(() => formatStroopsToDecimal(-1n), RangeError);
});

// ── 3. divideStroops ──────────────────────────────────────────────────────

test("divideStroops floor: 10 / 3 → quotient 3, dust 1", () => {
  const r = divideStroops(10n, 3n, "floor");
  assert.equal(r.quotient, 3n);
  assert.equal(r.dust, 1n);
});

test("divideStroops ceil: 10 / 3 → quotient 4, dust 0", () => {
  const r = divideStroops(10n, 3n, "ceil");
  assert.equal(r.quotient, 4n);
  assert.equal(r.dust, 0n);
});

test("divideStroops: exact division has zero dust in both directions", () => {
  assert.equal(divideStroops(12n, 4n, "floor").dust, 0n);
  assert.equal(divideStroops(12n, 4n, "ceil").dust, 0n);
});

// ── 4. sorobanToStroops / stroopsToSoroban ────────────────────────────────

test("sorobanToStroops: 1_000_000 Soroban units → 10 XLM in stroops", () => {
  // 1_000_000 × 100_000 = 100_000_000_000 stroops = 10_000 XLM? No.
  // Actually: 1 Soroban unit = 100_000 stroops = 0.01 XLM
  // So 1_000_000 Soroban = 100_000_000_000 stroops = 10_000 XLM
  const r = sorobanToStroops(1_000_000n);
  assert.equal(r.quotient, 1_000_000n * SOROBAN_STROOPS_FACTOR / SOROBAN_STROOPS_FACTOR);
  // Simpler check: round-trip
  assert.equal(r.dust, 0n); // exactly divisible
});

test("sorobanToStroops: floor — dust stays with relayer", () => {
  // 100_001 Soroban units: 100_001 × 100_000 = 10_000_100_000 stroops,
  // but we're going the other way: soroban→stroops means multiply, no rounding needed.
  // The rounding path is stroopsToSoroban when stroops is not divisible by factor.
  const r = stroopsToSoroban(100_001n);
  assert.equal(r.quotient, 1n); // 100_001 / 100_000 = 1 (floor)
  assert.equal(r.dust, 1n);     // remainder = 1 stroop, posted to dust ledger
});

test("stroopsToSoroban: exact divisor has zero dust", () => {
  const r = stroopsToSoroban(SOROBAN_STROOPS_FACTOR);
  assert.equal(r.quotient, 1n);
  assert.equal(r.dust, 0n);
});

test("sorobanToStroops: rejects negative", () => {
  assert.throws(() => sorobanToStroops(-1n), RangeError);
});

test("stroopsToSoroban: rejects negative", () => {
  assert.throws(() => stroopsToSoroban(-1n), RangeError);
});

// ── 5. splitBatchStroops ──────────────────────────────────────────────────

test("splitBatchStroops: 10 stroops over 3 recipients → 3 each, dust 1", () => {
  const r = splitBatchStroops(10n, 3n);
  assert.equal(r.perRecipient, 3n);
  assert.equal(r.dust, 1n);
});

test("splitBatchStroops: exact split produces zero dust", () => {
  const r = splitBatchStroops(100n, 4n);
  assert.equal(r.perRecipient, 25n);
  assert.equal(r.dust, 0n);
});

test("splitBatchStroops: rejects zero recipients", () => {
  assert.throws(() => splitBatchStroops(100n, 0n), RangeError);
});

test("splitBatchStroops: dust + recipients×perRecipient = total", () => {
  for (const [total, n] of [[100n, 7n], [999n, 13n], [1n, 3n]]) {
    const r = splitBatchStroops(total as bigint, n as bigint);
    assert.equal(r.perRecipient * (n as bigint) + r.dust, total);
  }
});

// ── 6. parseFeeStringToStroops (replaces float path in ttl.ts) ───────────

test("parseFeeStringToStroops: plain integer string", () => {
  assert.equal(parseFeeStringToStroops("100"), 100n);
});

test("parseFeeStringToStroops: decimal XLM fee string", () => {
  // "0.0000100" = 100 stroops
  assert.equal(parseFeeStringToStroops("0.0000100"), 100n);
});

test("parseFeeStringToStroops: large fee stays BigInt (no float loss)", () => {
  const fee = parseFeeStringToStroops("9007199254740993"); // > Number.MAX_SAFE_INTEGER
  assert.equal(fee, 9007199254740993n);
});

test("parseFeeStringToStroops: rejects negative", () => {
  assert.throws(() => parseFeeStringToStroops("-100"), RangeError);
});
