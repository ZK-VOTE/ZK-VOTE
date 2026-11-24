/**
 * Baby Jubjub ElGamal primitives for encrypted tallies.
 *
 * Mirrors `frontend/src/lib/elgamal.ts` and `circuits/elgamal.circom`. The
 * backend never sees individual plaintext choices; it only:
 *   - homomorphically adds submitted ciphertexts,
 *   - coordinates the 2-of-3 decryption ceremony after `end_time`,
 *   - publishes the aggregate tally.
 */

import { randomBytes } from "node:crypto";
import { buildBabyjub } from "circomlibjs";

export const BN254_FR_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const BABYJUB_SUBORDER =
  2736030358979909402780800718157159386076813972158567259200215660948447373041n;

export const BASE8: readonly [bigint, bigint] = [
  5299619240641551281634865583518297030282874472190772894086521144482721001553n,
  16950150798460657717958625567821834550301663161624707787222815936182638968203n,
];

export interface Point {
  x: bigint;
  y: bigint;
}

export interface Ciphertext {
  c1: Point;
  c2: Point;
}

export interface BallotCiphertext {
  c1: Point;
  cYes: Point;
  cNo: Point;
  randomness: bigint;
}

type BabyJub = {
  F: { toString: (v: unknown) => string; e: (v: unknown) => unknown };
  addPoint: (a: unknown[], b: unknown[]) => unknown[];
  mulPointEscalar: (base: unknown[], scalar: bigint) => unknown[];
  inCurve: (p: unknown[]) => boolean;
};

let babyjubPromise: Promise<BabyJub> | null = null;

export function getBabyJub(): Promise<BabyJub> {
  if (!babyjubPromise) {
    babyjubPromise = buildBabyjub() as unknown as Promise<BabyJub>;
  }
  return babyjubPromise;
}

function toBigInt(F: BabyJub["F"], v: unknown): bigint {
  return BigInt(F.toString(v));
}

function scalarToField(F: BabyJub["F"], v: bigint): unknown {
  return F.e(v);
}

export function randomScalar(): bigint {
  let value = 0n;
  for (const byte of randomBytes(32)) value = (value << 8n) | BigInt(byte);
  value %= BABYJUB_SUBORDER;
  return value === 0n ? 1n : value;
}

export async function generateElGamalKeypair(): Promise<{
  privateKey: bigint;
  publicKey: Point;
}> {
  const babyjub = await getBabyJub();
  const privateKey = randomScalar();
  const pk = babyjub.mulPointEscalar(
    [babyjub.F.e(BASE8[0]), babyjub.F.e(BASE8[1])],
    privateKey,
  );
  return {
    privateKey,
    publicKey: {
      x: toBigInt(babyjub.F, pk[0]),
      y: toBigInt(babyjub.F, pk[1]),
    },
  };
}

export async function addPoints(a: Point, b: Point): Promise<Point> {
  const babyjub = await getBabyJub();
  const sum = babyjub.addPoint(
    [babyjub.F.e(a.x), babyjub.F.e(a.y)],
    [babyjub.F.e(b.x), babyjub.F.e(b.y)],
  );
  return {
    x: toBigInt(babyjub.F, sum[0]),
    y: toBigInt(babyjub.F, sum[1]),
  };
}

export async function encryptBallot(
  publicKey: Point,
  vote: 0 | 1 | boolean,
  randomness: bigint = randomScalar(),
): Promise<BallotCiphertext> {
  const choice = typeof vote === "boolean" ? (vote ? 1n : 0n) : BigInt(vote);
  if (choice !== 0n && choice !== 1n) {
    throw new Error("encryptBallot: vote must be 0 or 1");
  }
  const babyjub = await getBabyJub();
  const G = [babyjub.F.e(BASE8[0]), babyjub.F.e(BASE8[1])];
  const H = [babyjub.F.e(publicKey.x), babyjub.F.e(publicKey.y)];
  if (!babyjub.inCurve(H)) {
    throw new Error("encryptBallot: public key is not on Baby Jubjub");
  }

  const r = randomness % BABYJUB_SUBORDER;
  if (r === 0n) throw new Error("encryptBallot: randomness must be non-zero");

  const c1 = babyjub.mulPointEscalar(G, r);
  const shared = babyjub.mulPointEscalar(H, r);
  const yesPoint = choice === 1n ? G : [babyjub.F.e(0), babyjub.F.e(1)];
  const noPoint = choice === 0n ? G : [babyjub.F.e(0), babyjub.F.e(1)];
  const cYes = babyjub.addPoint(shared, yesPoint);
  const cNo = babyjub.addPoint(shared, noPoint);

  return {
    c1: { x: toBigInt(babyjub.F, c1[0]), y: toBigInt(babyjub.F, c1[1]) },
    cYes: { x: toBigInt(babyjub.F, cYes[0]), y: toBigInt(babyjub.F, cYes[1]) },
    cNo: { x: toBigInt(babyjub.F, cNo[0]), y: toBigInt(babyjub.F, cNo[1]) },
    randomness: r,
  };
}

export async function homomorphicAdd(
  a: Ciphertext,
  b: Ciphertext,
): Promise<Ciphertext> {
  return {
    c1: await addPoints(a.c1, b.c1),
    c2: await addPoints(a.c2, b.c2),
  };
}

export async function aggregateCiphertexts(
  ciphertexts: Ciphertext[],
): Promise<Ciphertext> {
  if (ciphertexts.length === 0) {
    throw new Error("aggregateCiphertexts: no ciphertexts");
  }
  let acc = ciphertexts[0];
  for (const ct of ciphertexts.slice(1)) acc = await homomorphicAdd(acc, ct);
  return acc;
}

export function pointToHex(point: Point): string {
  return (
    point.x.toString(16).padStart(64, "0") +
    point.y.toString(16).padStart(64, "0")
  );
}

export function pointFromHex(hex: string): Point {
  const clean = hex.replace(/^0x/, "");
  const padded = clean.padStart(128, "0");
  return {
    x: BigInt("0x" + padded.slice(0, 64)),
    y: BigInt("0x" + padded.slice(64, 128)),
  };
}

export function ciphertextToHex(ct: { c1: Point; c2: Point }): {
  c1: string;
  c2: string;
} {
  return { c1: pointToHex(ct.c1), c2: pointToHex(ct.c2) };
}

export async function discreteLog(
  point: Point,
  max = 1_000_000,
): Promise<bigint> {
  const babyjub = await getBabyJub();
  const F = babyjub.F;
  const G = [F.e(BASE8[0]), F.e(BASE8[1])];
  const target = [F.e(point.x), F.e(point.y)];

  const m = BigInt(Math.ceil(Math.sqrt(max)));
  const table = new Map<string, bigint>();
  let cur = [F.e(0), F.e(1)];
  for (let j = 0n; j < m; j++) {
    table.set(
      `${toBigInt(F, cur[0]).toString(16)}:${toBigInt(F, cur[1]).toString(16)}`,
      j,
    );
    cur = babyjub.addPoint(cur, G);
  }

  const negG = [F.e(BN254_FR_MODULUS - BASE8[0]), F.e(BASE8[1])];
  const step = babyjub.mulPointEscalar(negG, m);
  let gamma = target;
  for (let i = 0n; i <= m; i++) {
    const key = `${toBigInt(F, gamma[0]).toString(16)}:${toBigInt(F, gamma[1]).toString(16)}`;
    const j = table.get(key);
    if (j !== undefined) return i * m + j;
    gamma = babyjub.addPoint(gamma, step);
  }
  throw new Error("discreteLog: value outside the supported tally range");
}

export async function decryptCiphertext(
  ciphertext: Ciphertext,
  privateKey: bigint,
  max = 1_000_000,
): Promise<bigint> {
  const babyjub = await getBabyJub();
  const F = babyjub.F;
  const c1 = [F.e(ciphertext.c1.x), F.e(ciphertext.c1.y)];
  const c2 = [F.e(ciphertext.c2.x), F.e(ciphertext.c2.y)];
  const shared = babyjub.mulPointEscalar(c1, privateKey);
  const negShared = [
    F.e(BN254_FR_MODULUS - toBigInt(F, shared[0])),
    F.e(shared[1]),
  ];
  const messagePoint = babyjub.addPoint(c2, negShared);
  return discreteLog(
    {
      x: toBigInt(F, messagePoint[0]),
      y: toBigInt(F, messagePoint[1]),
    },
    max,
  );
}

export function createShares(
  secret: bigint,
  threshold: number,
  total: number,
): Array<{ index: number; value: bigint }> {
  if (threshold < 1 || threshold > total) {
    throw new Error("createShares: invalid threshold");
  }
  const coeffs = [secret];
  for (let i = 1; i < threshold; i++) coeffs.push(randomScalar());
  return Array.from({ length: total }, (_, i) => {
    const x = BigInt(i + 1);
    let y = 0n;
    for (let j = coeffs.length - 1; j >= 0; j--) {
      y = (y * x + coeffs[j]) % BABYJUB_SUBORDER;
    }
    return { index: i + 1, value: y };
  });
}

function modInv(a: bigint, m: bigint): bigint {
  let [oldR, r] = [((a % m) + m) % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error("modInv: not invertible");
  return ((oldS % m) + m) % m;
}

export function lagrangeAtZero(index: number, indices: number[]): bigint {
  const xi = BigInt(index);
  let num = 1n;
  let den = 1n;
  for (const j of indices) {
    if (j === index) continue;
    const xj = BigInt(j);
    num = (((num * (0n - xj)) % BABYJUB_SUBORDER) + BABYJUB_SUBORDER) % BABYJUB_SUBORDER;
    den = (((den * (xi - xj)) % BABYJUB_SUBORDER) + BABYJUB_SUBORDER) % BABYJUB_SUBORDER;
  }
  return (
    ((num * modInv(den, BABYJUB_SUBORDER)) % BABYJUB_SUBORDER) +
    BABYJUB_SUBORDER
  ) % BABYJUB_SUBORDER;
}

export async function combineDecryptionShares(
  shares: Array<{ index: number; point: Point }>,
): Promise<Point> {
  if (shares.length === 0) throw new Error("combineDecryptionShares: empty");
  const indices = shares.map((s) => s.index);
  const babyjub = await getBabyJub();
  const F = babyjub.F;
  let result: Point = { x: 0n, y: 1n };
  for (const share of shares) {
    const lambda = lagrangeAtZero(share.index, indices);
    const weighted = babyjub.mulPointEscalar(
      [F.e(share.point.x), F.e(share.point.y)],
      lambda,
    );
    result = await addPoints(result, {
      x: toBigInt(F, weighted[0]),
      y: toBigInt(F, weighted[1]),
    });
  }
  return result;
}

export async function generateDecryptionShare(
  ciphertext: Ciphertext,
  privateKeyShare: bigint,
): Promise<Point> {
  const babyjub = await getBabyJub();
  const F = babyjub.F;
  const c1 = [F.e(ciphertext.c1.x), F.e(ciphertext.c1.y)];
  const share = babyjub.mulPointEscalar(c1, privateKeyShare);
  return { x: toBigInt(F, share[0]), y: toBigInt(F, share[1]) };
}

export async function decryptWithCombinedShare(
  ciphertext: Ciphertext,
  combined: Point,
  max = 1_000_000,
): Promise<bigint> {
  const babyjub = await getBabyJub();
  const F = babyjub.F;
  const c2 = [F.e(ciphertext.c2.x), F.e(ciphertext.c2.y)];
  const neg = [F.e(BN254_FR_MODULUS - combined.x), F.e(combined.y)];
  const messagePoint = babyjub.addPoint(c2, neg);
  return discreteLog(
    {
      x: toBigInt(F, messagePoint[0]),
      y: toBigInt(F, messagePoint[1]),
    },
    max,
  );
}

/** Convenience for the ceremony: split an existing key into 2-of-3 shares. */
export function splitCeremonyKey(
  privateKey: bigint,
  threshold = 2,
  total = 3,
): Array<{ index: number; value: bigint }> {
  return createShares(privateKey, threshold, total);
}

export { scalarToField };
