/**
 * Minimal self-contained BN254 (alt_bn128) G1 point arithmetic for the
 * privacy-analytics demo (issue #306).
 *
 * This is a small reference implementation of Weierstrass curve
 *   y² = x³ + 3   (mod p)
 * sufficient to produce a deterministic ElGamal "contribution of 1" so the UI
 * can exercise the homomorphic accumulation endpoint without pulling in @noble
 * (which is a backend-only dependency). It is NOT production-grade constant-time
 * code and MUST NOT be used for real vote encryption — the relayer owns that
 * responsibility (see backend/src/services/threshold-crypto.ts).
 */

export const BN254_P =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

// Generator of the G1 subgroup (cofactor 1): x = 1, y = 2.
export const GX = 1n;
export const GY = 2n;

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

function modInv(a: bigint, m: bigint): bigint {
  let t = 0n;
  let newT = 1n;
  let r = m;
  let newR = mod(a, m);
  while (newR !== 0n) {
    const q = r / newR;
    [t, newT] = [newT, t - q * newT];
    [r, newR] = [newR, r - q * newR];
  }
  if (r > 1n) throw new Error("not invertible");
  return mod(t, m);
}

export interface G1Point {
  x: bigint;
  y: bigint;
  infinity: boolean;
}

export const ZERO: G1Point = { x: 0n, y: 0n, infinity: true };
export const BASE: G1Point = { x: GX, y: GY, infinity: false };

function pointAdd(a: G1Point, b: G1Point): G1Point {
  if (a.infinity) return b;
  if (b.infinity) return a;
  if (a.x === b.x) {
    if (mod(a.y + b.y, BN254_P) === 0n) return ZERO;
    return pointDouble(a);
  }
  const m = mod((b.y - a.y) * modInv(b.x - a.x, BN254_P), BN254_P);
  const x3 = mod(m * m - a.x - b.x, BN254_P);
  const y3 = mod(m * (a.x - x3) - a.y, BN254_P);
  return { x: x3, y: y3, infinity: false };
}

function pointDouble(a: G1Point): G1Point {
  if (a.infinity || a.y === 0n) return ZERO;
  const m = mod((3n * a.x * a.x) * modInv(2n * a.y, BN254_P), BN254_P);
  const x3 = mod(m * m - 2n * a.x, BN254_P);
  const y3 = mod(m * (a.x - x3) - a.y, BN254_P);
  return { x: x3, y: y3, infinity: false };
}

// Double-and-add scalar multiplication (scalar may be negative; we operate on
// the field-reduced absolute value and negate at the end if needed).
function scalarMul(scalar: bigint, p: G1Point): G1Point {
  const neg = scalar < 0n;
  let k = mod(neg ? -scalar : scalar, BN254_P - 1n);
  let result = ZERO;
  let addend: G1Point = p;
  while (k > 0n) {
    if (k & 1n) result = pointAdd(result, addend);
    addend = pointDouble(addend);
    k >>= 1n;
  }
  if (neg && !result.infinity) {
    result = { x: result.x, y: mod(-result.y, BN254_P), infinity: false };
  }
  return result;
}

export function parsePoint(hex: string): G1Point {
  const clean = hex.replace(/^0x/, "");
  const padded = clean.padStart(128, "0");
  const x = BigInt("0x" + padded.slice(0, 64));
  const y = BigInt("0x" + padded.slice(64, 128));
  if (x === 0n && y === 0n) return ZERO;
  return { x, y, infinity: false };
}

export function pointToHex(p: G1Point): string {
  if (p.infinity) return "0".padStart(128, "0");
  return (
    p.x.toString(16).padStart(64, "0") + p.y.toString(16).padStart(64, "0")
  );
}

export function pointAddPub(a: G1Point, b: G1Point): G1Point {
  return pointAdd(a, b);
}

/**
 * Produce a deterministic ElGamal ciphertext of the value `1` under
 * `publicKeyHex`. Only used to exercise the accumulation endpoint in the demo.
 */
export function encryptVoteDemo(
  publicKeyHex: string,
): { c1: string; c2: string } {
  const h = parsePoint(publicKeyHex);
  const r = 1n; // deterministic for demo only
  const c1 = scalarMul(r, BASE);
  const hr = scalarMul(r, h);
  const g1 = scalarMul(1n, BASE);
  const c2 = pointAdd(hr, g1);
  return { c1: pointToHex(c1), c2: pointToHex(c2) };
}

export {
  pointAdd,
  pointDouble,
  scalarMul,
  pointToHex as toHex,
  pointAddPub as add,
};