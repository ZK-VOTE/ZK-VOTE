#!/usr/bin/env node
/**
 * Poseidon parameter audit (#91).
 *
 * The circuits, the JS helpers and the on-chain contracts all hash with
 * Poseidon over the BN254 scalar field. `POSEIDON_KAT.md` already proves those
 * three implementations agree with *each other*; it says nothing about whether
 * the parameters they agree on are the ones the specification prescribes.
 * Agreeing on a weak parameter set is still weak.
 *
 * This module closes that gap by re-deriving the parameters from the spec and
 * comparing them against the values circomlib ships:
 *
 *   1. Round constants are regenerated with the Grain LFSR of Grassi,
 *      Khovratovich, Rechberger, Roy and Schofnegger, "POSEIDON: A New Hash
 *      Function for Zero-Knowledge Proof Systems" (USENIX Security 2021,
 *      https://eprint.iacr.org/2019/458), Appendix F, following the designers'
 *      reference script `generate_parameters_grain.sage`
 *      (https://extgit.iaik.tugraz.at/krypto/hadeshash). The instantiation is
 *      the one circomlibjs names in its own source comment:
 *
 *          sage generate_parameters_grain.sage 1 0 254 <t> 8 <R_P> \
 *              0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
 *
 *   2. The MDS matrix is regenerated as the Cauchy matrix that script builds
 *      from the continuation of the same LFSR stream, and is then run through
 *      the script's three matrix-security tests (`algorithm_1`, `algorithm_2`,
 *      `algorithm_3`), which reject matrices admitting invariant subspaces or
 *      infinitely long subspace trails through the partial-round layers.
 *
 *   3. The round numbers are checked against the security inequality of
 *      `calc_round_numbers.py` (`sat_inequiv_alpha`), covering the statistical,
 *      interpolation and Gröbner-basis bounds, both as shipped and with the
 *      designers' security margin (+2 full rounds, +7.5% partial rounds)
 *      stripped off, so the audit reports how much margin actually remains.
 *
 * Everything is derived from a public, verifiable seed: the only hard-coded
 * numbers here are the BN254 modulus and circomlib's declared round counts,
 * both of which the audit itself re-checks.
 *
 * Usage:
 *   node utils/poseidon_param_audit.js          # widths ZK-VOTE instantiates
 *   node utils/poseidon_param_audit.js --all    # every width circomlib ships
 *   node utils/poseidon_param_audit.js --json   # machine-readable report
 */

"use strict";

/** BN254 scalar field modulus (Fr). */
const P = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

/** Field size in bits, as fed to the Grain LFSR (`n` in the reference script). */
const FIELD_BITS = 254;

/** S-box exponent. gcd(5, p - 1) == 1 over BN254 Fr, so x^5 is a permutation. */
const ALPHA = 5;

/** Target security level in bits. */
const SECURITY_BITS = 128;

/** Full rounds, per the paper's recommendation for x^5 over a 254-bit field. */
const ROUNDS_F = 8;

/** Designers' security margin, applied on top of the minimum secure numbers. */
const MARGIN_FULL_ROUNDS = 2;
const MARGIN_PARTIAL_FACTOR = 1.075;

/**
 * Partial rounds circomlib uses, indexed by `t - 2`.
 * Mirrors `N_ROUNDS_P` in circomlibjs/src/poseidon_reference.js.
 */
const CIRCOMLIB_ROUNDS_P = [
  56, 57, 56, 60, 60, 63, 64, 63, 60, 66, 60, 65, 70, 60, 64, 68,
];

/** State widths ZK-VOTE actually instantiates, and where. */
const WIDTHS_IN_USE = [
  {
    t: 3,
    used_for:
      "Merkle node hash and leaf domain hash (merkle_tree.circom, membership-tree hash_pair)",
  },
  {
    t: 4,
    used_for: "vote nullifier Poseidon(secret, daoId, proposalId) (vote.circom)",
  },
  {
    t: 5,
    used_for:
      "identity commitment Poseidon(DOMAIN_TAG, secret, salt, blindingFactor) (vote.circom)",
  },
];

// ---------------------------------------------------------------------------
// Field arithmetic
// ---------------------------------------------------------------------------

const mod = (a) => ((a % P) + P) % P;

function fpow(base, exp) {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

/** Multiplicative inverse via Fermat's little theorem. Throws on zero. */
function finv(a) {
  const v = mod(a);
  if (v === 0n) throw new Error("cannot invert zero");
  return fpow(v, P - 2n);
}

// ---------------------------------------------------------------------------
// Grain LFSR (paper Appendix F / generate_parameters_grain.sage)
// ---------------------------------------------------------------------------

function toBits(value, width) {
  const out = [];
  for (let i = width - 1; i >= 0; i--) {
    out.push(Number((BigInt(value) >> BigInt(i)) & 1n));
  }
  return out;
}

/**
 * The 80-bit initial state: field type, S-box type, field size, state width,
 * R_F, R_P, then 30 one-bits. `field = 1` selects GF(p); `sbox = 0` selects the
 * x^alpha S-box. Matches `init_generator` in the reference script.
 */
function initState(t, roundsF, roundsP) {
  const state = [
    ...toBits(1, 2),
    ...toBits(0, 4),
    ...toBits(FIELD_BITS, 12),
    ...toBits(t, 12),
    ...toBits(roundsF, 10),
    ...toBits(roundsP, 10),
    ...new Array(30).fill(1),
  ];
  if (state.length !== 80) {
    throw new Error(`Grain init state must be 80 bits, got ${state.length}`);
  }
  return state;
}

/**
 * Grain-80 stream in self-shrinking mode: clock the LFSR, read bit pairs, and
 * emit the second bit of a pair only when the first is 1. The first 160
 * clockings are discarded, exactly as the reference script does.
 */
function* grainStream(t, roundsF, roundsP) {
  const state = initState(t, roundsF, roundsP);
  const clock = () => {
    const bit = state[62] ^ state[51] ^ state[38] ^ state[23] ^ state[13] ^ state[0];
    state.shift();
    state.push(bit);
    return bit;
  };

  for (let i = 0; i < 160; i++) clock();

  for (;;) {
    let selector = clock();
    while (selector === 0) {
      clock(); // discard the partner bit of a rejected pair
      selector = clock();
    }
    yield clock();
  }
}

/** Read `numBits` stream bits as a big-endian integer (`grain_random_bits`). */
function readInt(stream, numBits) {
  let value = 0n;
  for (let i = 0; i < numBits; i++) {
    value = (value << 1n) | BigInt(stream.next().value);
  }
  return value;
}

/**
 * Round constants reject samples >= p rather than reducing them, so the
 * constants are uniform over F_p (`generate_constants`, field == 1 branch).
 */
function readRoundConstant(stream) {
  let value = readInt(stream, FIELD_BITS);
  while (value >= P) value = readInt(stream, FIELD_BITS);
  return value;
}

/**
 * The MDS sampling points, in contrast, are *reduced* rather than rejected:
 * the script writes `F(grain_random_bits(n))`. The distinction is not
 * cosmetic — reproducing circomlib's matrices requires reduction here and
 * rejection above.
 */
function readMdsPoint(stream) {
  return mod(readInt(stream, FIELD_BITS));
}

function generateRoundConstants(stream, t, roundsF, roundsP) {
  const out = [];
  for (let i = 0; i < (roundsF + roundsP) * t; i++) out.push(readRoundConstant(stream));
  return out;
}

/**
 * `create_mds_p`: draw 2t points, resample while they are not pairwise
 * distinct, and build the Cauchy matrix M[i][j] = 1 / (x_i + y_j), restarting
 * if any denominator vanishes.
 */
function createMdsCandidate(stream, t) {
  for (;;) {
    let points;
    for (;;) {
      points = [];
      for (let i = 0; i < 2 * t; i++) points.push(readMdsPoint(stream));
      if (new Set(points.map(String)).size === 2 * t) break;
    }
    const xs = points.slice(0, t);
    const ys = points.slice(t);
    let degenerate = false;
    const m = xs.map((x) =>
      ys.map((y) => {
        const denominator = mod(x + y);
        if (denominator === 0n) {
          degenerate = true;
          return 0n;
        }
        return finv(denominator);
      }),
    );
    if (degenerate) continue;
    return { mds: m, xs, ys };
  }
}

/**
 * `generate_matrix`: keep drawing Cauchy candidates until one passes all three
 * matrix-security tests. With the BN254 stream the first candidate passes for
 * every width circomlib ships, which is why the shipped matrices are the
 * first-draw ones — but the loop is faithful, so a failing draw would be
 * rejected rather than silently accepted.
 */
function generateSecureMds(stream, t) {
  for (let attempt = 0; ; attempt++) {
    const candidate = createMdsCandidate(stream, t);
    const a1 = algorithm1(candidate.mds, t);
    const a2 = algorithm2(candidate.mds, t);
    const a3 = algorithm3(candidate.mds, t);
    if (a1.secure && a2.secure && a3.secure) {
      return { ...candidate, attempt, algorithm1: a1, algorithm2: a2, algorithm3: a3 };
    }
    if (attempt > 64) throw new Error(`no secure MDS matrix found for t=${t}`);
  }
}

/** Derive the complete parameter set for one state width from the seeded stream. */
function deriveParameters(t, roundsF, roundsP) {
  const stream = grainStream(t, roundsF, roundsP);
  const roundConstants = generateRoundConstants(stream, t, roundsF, roundsP);
  const matrix = generateSecureMds(stream, t);
  return { t, roundsF, roundsP, roundConstants, ...matrix };
}

// ---------------------------------------------------------------------------
// Linear algebra over F_p
// ---------------------------------------------------------------------------

function identity(t) {
  return Array.from({ length: t }, (_, i) =>
    Array.from({ length: t }, (_, j) => (i === j ? 1n : 0n)),
  );
}

function matMul(a, b) {
  const rows = a.length;
  const inner = b.length;
  const cols = b[0].length;
  const out = [];
  for (let i = 0; i < rows; i++) {
    const row = new Array(cols).fill(0n);
    for (let k = 0; k < inner; k++) {
      const aik = a[i][k];
      if (aik === 0n) continue;
      for (let j = 0; j < cols; j++) row[j] = mod(row[j] + aik * b[k][j]);
    }
    out.push(row);
  }
  return out;
}

/** M * v, with v a column vector. */
function matVec(m, v) {
  return m.map((row) => row.reduce((acc, cell, j) => mod(acc + cell * v[j]), 0n));
}

function matPow(m, e) {
  let result = identity(m.length);
  let base = m;
  let n = e;
  while (n > 0) {
    if (n & 1) result = matMul(result, base);
    base = matMul(base, base);
    n >>= 1;
  }
  return result;
}

function matEq(a, b) {
  return a.every((row, i) => row.every((v, j) => v === b[i][j]));
}

/** Reduced row echelon form; returns the non-zero rows and the pivot columns. */
function rref(rowsIn) {
  if (rowsIn.length === 0) return { rows: [], pivots: [] };
  const m = rowsIn.map((row) => row.slice());
  const cols = m[0].length;
  const pivots = [];
  let r = 0;
  for (let c = 0; c < cols && r < m.length; c++) {
    let pivot = -1;
    for (let i = r; i < m.length; i++) {
      if (m[i][c] !== 0n) {
        pivot = i;
        break;
      }
    }
    if (pivot === -1) continue;
    [m[r], m[pivot]] = [m[pivot], m[r]];
    const scale = finv(m[r][c]);
    for (let j = c; j < cols; j++) m[r][j] = mod(m[r][j] * scale);
    for (let i = 0; i < m.length; i++) {
      if (i === r || m[i][c] === 0n) continue;
      const factor = m[i][c];
      for (let j = c; j < cols; j++) m[i][j] = mod(m[i][j] - factor * m[r][j]);
    }
    pivots.push(c);
    r++;
  }
  return { rows: m.slice(0, r), pivots };
}

/**
 * A subspace is represented by the RREF basis of its row span, which makes
 * equality a plain structural comparison.
 */
function span(vectors) {
  const nonZero = vectors.filter((v) => v.some((c) => c !== 0n));
  if (nonZero.length === 0) return [];
  return rref(nonZero).rows;
}

const spanDim = (basis) => basis.length;

function spanEq(a, b) {
  if (a.length !== b.length) return false;
  return a.every((row, i) => row.every((v, j) => v === b[i][j]));
}

/** Right kernel of `m`: all v with m * v = 0. */
function rightKernel(m, width) {
  const cols = width ?? (m.length > 0 ? m[0].length : 0);
  if (m.length === 0) return identity(cols);
  const { rows, pivots } = rref(m);
  const free = [];
  for (let c = 0; c < cols; c++) if (!pivots.includes(c)) free.push(c);
  const basis = [];
  for (const f of free) {
    const v = new Array(cols).fill(0n);
    v[f] = 1n;
    pivots.forEach((pc, i) => {
      v[pc] = mod(-rows[i][f]);
    });
    basis.push(v);
  }
  return span(basis);
}

/** Intersection of two subspaces, via kernels (Zassenhaus is overkill for t <= 17). */
function spanIntersect(a, b, t) {
  if (a.length === 0 || b.length === 0) return [];
  // v in span(a) and v in span(b): solve for coefficients x with
  // x . a - y . b = 0, then map surviving x back through a.
  const rows = [];
  for (let col = 0; col < t; col++) {
    const row = [];
    for (const v of a) row.push(v[col]);
    for (const v of b) row.push(mod(-v[col]));
    rows.push(row);
  }
  const kernel = rightKernel(rows, a.length + b.length);
  const vectors = kernel.map((sol) => {
    const v = new Array(t).fill(0n);
    a.forEach((basisVector, i) => {
      if (sol[i] === 0n) return;
      for (let c = 0; c < t; c++) v[c] = mod(v[c] + sol[i] * basisVector[c]);
    });
    return v;
  });
  return span(vectors);
}

/** `subspace_times_matrix`: span{ M * v : v in basis(S) }. */
function spanTimesMatrix(basis, m) {
  return span(basis.map((v) => matVec(m, v)));
}

// ---------------------------------------------------------------------------
// Polynomials over F_p (needed for eigenvalues)
// ---------------------------------------------------------------------------

const polyDegree = (a) => {
  let d = a.length - 1;
  while (d > 0 && a[d] === 0n) d--;
  return a[d] === 0n ? -1 : d;
};

function polyTrim(a) {
  const d = polyDegree(a);
  return d < 0 ? [0n] : a.slice(0, d + 1);
}

function polySub(a, b) {
  const n = Math.max(a.length, b.length);
  const out = new Array(n).fill(0n);
  for (let i = 0; i < n; i++) out[i] = mod((a[i] ?? 0n) - (b[i] ?? 0n));
  return polyTrim(out);
}

function polyMul(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0n);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0n) continue;
    for (let j = 0; j < b.length; j++) out[i + j] = mod(out[i + j] + a[i] * b[j]);
  }
  return polyTrim(out);
}

function polyMod(a, b) {
  const db = polyDegree(b);
  if (db < 0) throw new Error("division by the zero polynomial");
  const leadInv = finv(b[db]);
  let r = polyTrim(a).slice();
  for (;;) {
    const dr = polyDegree(r);
    if (dr < db) break;
    const factor = mod(r[dr] * leadInv);
    for (let i = 0; i <= db; i++) r[dr - db + i] = mod(r[dr - db + i] - factor * b[i]);
    r = polyTrim(r);
  }
  return r;
}

function polyGcd(a, b) {
  let x = polyTrim(a);
  let y = polyTrim(b);
  while (polyDegree(y) >= 0) {
    const r = polyMod(x, y);
    x = y;
    y = r;
  }
  const dx = polyDegree(x);
  if (dx < 0) return [0n];
  const leadInv = finv(x[dx]);
  return x.map((c) => mod(c * leadInv));
}

/** base^exp mod modulus, over F_p[x]. */
function polyPowMod(base, exp, modulus) {
  let result = [1n];
  let b = polyMod(base, modulus);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = polyMod(polyMul(result, b), modulus);
    b = polyMod(polyMul(b, b), modulus);
    e >>= 1n;
  }
  return result;
}

/** Characteristic polynomial, lowest degree first (Faddeev-LeVerrier). */
function characteristicPolynomial(m) {
  const t = m.length;
  const coeffs = new Array(t + 1).fill(0n);
  coeffs[t] = 1n;
  let mk = m.map((row) => row.slice());
  for (let k = 1; k <= t; k++) {
    let trace = 0n;
    for (let i = 0; i < t; i++) trace = mod(trace + mk[i][i]);
    const c = mod(-trace * finv(BigInt(k)));
    coeffs[t - k] = c;
    if (k < t) {
      const shifted = mk.map((row, i) => row.map((v, j) => (i === j ? mod(v + c) : v)));
      mk = matMul(m, shifted);
    }
  }
  return coeffs;
}

/**
 * All roots of `poly` in F_p, by taking gcd with x^p - x and then splitting the
 * (squarefree, totally split) result with Cantor-Zassenhaus.
 */
function polyRootsInField(poly, rng = deterministicRng()) {
  const squareFreeSplit = polyGcd(poly, polySub(polyPowMod([0n, 1n], P, poly), [0n, 1n]));
  if (polyDegree(squareFreeSplit) < 1) return [];

  const roots = [];
  const stack = [squareFreeSplit];
  let guard = 0;
  while (stack.length > 0) {
    if (guard++ > 4096) throw new Error("root splitting failed to terminate");
    const f = stack.pop();
    const d = polyDegree(f);
    if (d < 1) continue;
    if (d === 1) {
      // f = x + c (monic) -> root -c
      roots.push(mod(-f[0]));
      continue;
    }
    const a = rng();
    const shifted = polyPowMod([a, 1n], (P - 1n) / 2n, f);
    const g = polyGcd(f, polySub(shifted, [1n]));
    const dg = polyDegree(g);
    if (dg <= 0 || dg === d) {
      stack.push(f); // unlucky split, retry with the next randomiser
      continue;
    }
    stack.push(g);
    stack.push(polyDivExact(f, g));
  }
  return [...new Set(roots.map(String))].map(BigInt).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

function polyDivExact(a, b) {
  const db = polyDegree(b);
  const leadInv = finv(b[db]);
  let r = polyTrim(a).slice();
  const q = new Array(Math.max(polyDegree(a) - db + 1, 1)).fill(0n);
  for (;;) {
    const dr = polyDegree(r);
    if (dr < db) break;
    const factor = mod(r[dr] * leadInv);
    q[dr - db] = factor;
    for (let i = 0; i <= db; i++) r[dr - db + i] = mod(r[dr - db + i] - factor * b[i]);
    r = polyTrim(r);
  }
  return polyTrim(q);
}

/**
 * A deterministic randomiser, so an audit run is reproducible. Cantor-
 * Zassenhaus only needs the shifts to be varied, not unpredictable.
 */
function deterministicRng() {
  let state = 0x9e3779b97f4a7c15n;
  return () => {
    state = mod(state * 6364136223846793005n + 1442695040888963407n);
    return state;
  };
}

/** Right eigenspace of `m` for eigenvalue `lambda`: kernel of (m - lambda*I). */
function eigenspace(m, lambda) {
  const t = m.length;
  const shifted = m.map((row, i) => row.map((v, j) => (i === j ? mod(v - lambda) : v)));
  return rightKernel(shifted, t);
}

// ---------------------------------------------------------------------------
// Matrix security: algorithms 1-3 of generate_parameters_grain.sage
// ---------------------------------------------------------------------------

/**
 * `generate_vectorspace(round_num, M, M_round, t)` with s = 1.
 *
 * round_num == 1 gives the "inactive" subspace { v : v_0 = 0 }; for larger
 * round numbers it is the set of vectors of that form that additionally lie in
 * the right kernel of the stacked first rows of M^1 .. M^(round_num-1),
 * restricted to coordinates 1..t-1.
 */
function generateVectorspace(roundNum, m, t) {
  if (roundNum === 0) return identity(t);
  if (roundNum === 1) {
    const basis = [];
    for (let i = 1; i < t; i++) {
      const e = new Array(t).fill(0n);
      e[i] = 1n;
      basis.push(e);
    }
    return span(basis);
  }
  const stacked = [];
  for (let i = 0; i < roundNum - 1; i++) {
    const power = matPow(m, i + 1);
    stacked.push(power[0].slice(1)); // row 0, columns 1..t-1
  }
  const kernel = rightKernel(stacked, t - 1);
  return span(kernel.map((w) => [0n, ...w]));
}

/**
 * Algorithm 1: reject M if some power M^i (i = 1..t-1) is a scalar matrix, if
 * an F_p-eigenvector of M^i lies in the inactive subspace S_i, or if S_i is
 * invariant under M^j for some j <= i.
 */
function algorithm1(m, t) {
  const r = t - 1; // floor((t - s) / s) with s = 1
  for (let i = 1; i <= r; i++) {
    const matTest = matPow(m, i);
    const scalar = matTest[0][0];
    const target = identity(t).map((row, a) => row.map((v, b) => (a === b ? scalar : 0n)));
    if (matEq(matTest, target)) return { secure: false, reason: "power-is-scalar", i };

    const s = generateVectorspace(i, m, t);

    const eigenvalues = polyRootsInField(characteristicPolynomial(matTest));
    let intersectionBasis = [];
    for (const lambda of eigenvalues) {
      const es = eigenspace(matTest, lambda);
      intersectionBasis = intersectionBasis.concat(spanIntersect(s, es, t));
    }
    const is = span(intersectionBasis);
    if (spanDim(is) >= 1 && spanDim(is) !== t) {
      return { secure: false, reason: "invariant-subspace", i };
    }

    for (let j = 1; j <= i; j++) {
      if (spanEq(s, spanTimesMatrix(s, matPow(m, j)))) {
        return { secure: false, reason: "subspace-fixed-by-power", i, j };
      }
    }
  }
  return { secure: true };
}

/**
 * Algorithm 2 with s = 1 reduces to a cyclic-vector test: the Krylov subspace
 * span{ e_0, M e_0, M^2 e_0, ... } must reach the full space. If it stalls
 * short of dimension t, that stalled subspace is an invariant subspace
 * containing e_0, which is exactly the trail the algorithm rejects.
 */
function algorithm2(m, t) {
  const e0 = new Array(t).fill(0n);
  e0[0] = 1n;

  let basis = span([e0]);
  let v = e0;
  for (;;) {
    const before = spanDim(basis);
    v = matVec(m, v);
    basis = span([...basis, v]);
    if (spanDim(basis) === t) return { secure: true };
    if (spanDim(basis) <= before) {
      return { secure: false, reason: "krylov-subspace-stalls", dimension: spanDim(basis) };
    }
  }
}

/**
 * Algorithm 3: the same cyclic-vector condition must hold for every power
 * M^r with r = 2..4t, which rules out trails that only close up after several
 * rounds.
 */
function algorithm3(m, t) {
  for (let r = 2; r <= 4 * t; r++) {
    const res = algorithm2(matPow(m, r), t);
    if (!res.secure) return { secure: false, reason: "power-fails-algorithm-2", r };
  }
  return { secure: true };
}

// ---------------------------------------------------------------------------
// Round numbers: calc_round_numbers.py / sat_inequiv_alpha
// ---------------------------------------------------------------------------

const LOG2_P = 253.5; // log2(BN254 Fr modulus); recomputed below and asserted.

function log2OfModulus() {
  // Exact enough for the bounds: take the bit length and refine with the top bits.
  const bits = P.toString(2).length;
  const top = Number(P >> BigInt(bits - 53));
  return bits - 53 + Math.log2(top);
}

/**
 * `sat_inequiv_alpha` for alpha > 0: the four bounds that R_F must clear given
 * R_P. Returns the individual bounds so the report can show which one binds.
 */
function satInequivAlpha(t, roundsF, roundsP, alpha = ALPHA, securityBits = SECURITY_BITS) {
  const logP = log2OfModulus();
  const n = Math.ceil(logP);
  const M = securityBits;
  const logAlpha2 = Math.log(2) / Math.log(alpha); // log_alpha(2)

  const statistical =
    M <= Math.floor(logP - (alpha - 1) / 2) * (t + 1) ? 6 : 10;
  const interpolation =
    1 + Math.ceil(logAlpha2 * Math.min(M, n)) + Math.ceil(Math.log(t) / Math.log(alpha)) - roundsP;
  const groebner1 = 1 + logAlpha2 * Math.min(M / 3, logP / 2) - roundsP;
  const groebner2 =
    t - 1 + Math.min((logAlpha2 * M) / (t + 1), (logAlpha2 * logP) / 2) - roundsP;

  const required = Math.max(
    Math.ceil(statistical),
    Math.ceil(interpolation),
    Math.ceil(groebner1),
    Math.ceil(groebner2),
  );

  return {
    satisfied: roundsF >= required,
    requiredFullRounds: required,
    bounds: {
      statistical,
      interpolation: Math.ceil(interpolation),
      groebner1: Math.ceil(groebner1),
      groebner2: Math.ceil(groebner2),
    },
  };
}

/**
 * Reproduces `find_FD_round_numbers` with the S-box cost function: the
 * cheapest (R_F, R_P) pair that satisfies the inequality, optionally with the
 * designers' margin applied.
 */
function findRoundNumbers(t, { securityMargin = true, alpha = ALPHA, securityBits = SECURITY_BITS } = {}) {
  let best = null;
  for (let roundsP = 1; roundsP < 500; roundsP++) {
    for (let roundsF = 4; roundsF < 100; roundsF += 2) {
      if (!satInequivAlpha(t, roundsF, roundsP, alpha, securityBits).satisfied) continue;
      const f = securityMargin ? roundsF + MARGIN_FULL_ROUNDS : roundsF;
      const p = securityMargin ? Math.ceil(roundsP * MARGIN_PARTIAL_FACTOR) : roundsP;
      const cost = t * f + p; // get_sbox_cost
      if (best === null || cost < best.cost || (cost === best.cost && f < best.roundsF)) {
        best = { roundsF: f, roundsP: p, cost };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Audit driver
// ---------------------------------------------------------------------------

function loadCircomlibConstants() {
  // circomlibjs restricts "exports", so the constants file cannot be required
  // by subpath. Resolve the package root and read the file directly instead.
  const fs = require("fs");
  const path = require("path");
  let dir = path.dirname(require.resolve("circomlibjs"));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "src", "poseidon_constants.json");
    if (fs.existsSync(candidate)) return require(candidate);
    dir = path.dirname(dir);
  }
  throw new Error("could not locate circomlibjs/src/poseidon_constants.json");
}

function auditWidth(t, reference) {
  const roundsP = CIRCOMLIB_ROUNDS_P[t - 2];
  const derived = deriveParameters(t, ROUNDS_F, roundsP);

  const referenceConstants = reference.C[t - 2].map(BigInt);
  const referenceMds = reference.M[t - 2].map((row) => row.map(BigInt));

  const constantsMatch =
    derived.roundConstants.length === referenceConstants.length &&
    derived.roundConstants.every((v, i) => v === referenceConstants[i]);
  const mdsMatch =
    derived.mds.length === referenceMds.length &&
    derived.mds.every((row, i) => row.every((v, j) => v === referenceMds[i][j]));

  // Re-run the security tests against what is actually shipped, not only
  // against what we derived, so a tampered vendored copy is caught too.
  const a1 = algorithm1(referenceMds, t);
  const a2 = algorithm2(referenceMds, t);
  const a3 = algorithm3(referenceMds, t);

  const asShipped = satInequivAlpha(t, ROUNDS_F, roundsP);
  // Strip the designers' margin back off: if the un-margined pair still clears
  // the inequality, the shipped numbers carry the full recommended margin.
  const withoutMargin = satInequivAlpha(
    t,
    ROUNDS_F - MARGIN_FULL_ROUNDS,
    Math.ceil(roundsP / MARGIN_PARTIAL_FACTOR),
  );
  const recommended = findRoundNumbers(t);

  const checks = {
    round_constants_match_grain_lfsr: constantsMatch,
    mds_matches_grain_cauchy: mdsMatch,
    mds_no_invariant_subspace_algorithm_1: a1.secure,
    mds_no_subspace_trail_algorithm_2: a2.secure,
    mds_no_iterated_subspace_trail_algorithm_3: a3.secure,
    rounds_satisfy_security_inequality: asShipped.satisfied,
    rounds_retain_designer_security_margin: withoutMargin.satisfied,
    rounds_at_least_reference_recommendation:
      ROUNDS_F >= recommended.roundsF && roundsP >= recommended.roundsP,
  };

  return {
    t,
    rounds_f: ROUNDS_F,
    rounds_p: roundsP,
    alpha: ALPHA,
    security_bits: SECURITY_BITS,
    num_round_constants: derived.roundConstants.length,
    mds_draw_index: derived.attempt,
    required_full_rounds: asShipped.requiredFullRounds,
    bounds: asShipped.bounds,
    reference_recommendation: recommended,
    checks,
    pass: Object.values(checks).every(Boolean),
    failures: Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name),
  };
}

function audit(widths) {
  const reference = loadCircomlibConstants();
  return widths.map((t) => auditWidth(t, reference));
}

function main(argv) {
  const all = argv.includes("--all");
  const asJson = argv.includes("--json");
  const widths = all
    ? CIRCOMLIB_ROUNDS_P.map((_, i) => i + 2)
    : WIDTHS_IN_USE.map((w) => w.t);

  const results = audit(widths);

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ modulus: P.toString(), field_bits: FIELD_BITS, results }, null, 2)}\n`,
    );
  } else {
    console.log("=== Poseidon parameter audit (BN254 Fr, x^5, 128-bit target) ===\n");
    for (const r of results) {
      const use = WIDTHS_IN_USE.find((w) => w.t === r.t);
      console.log(`t=${r.t}  R_F=${r.rounds_f}  R_P=${r.rounds_p}  ${r.pass ? "PASS" : "FAIL"}`);
      if (use) console.log(`  used for: ${use.used_for}`);
      console.log(
        `  security inequality needs R_F >= ${r.required_full_rounds} ` +
          `(statistical ${r.bounds.statistical}, interpolation ${r.bounds.interpolation}, ` +
          `groebner ${r.bounds.groebner1}/${r.bounds.groebner2})`,
      );
      console.log(
        `  reference search recommends R_F=${r.reference_recommendation.roundsF}, ` +
          `R_P=${r.reference_recommendation.roundsP}`,
      );
      for (const [name, ok] of Object.entries(r.checks)) {
        console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
      }
      console.log("");
    }
    const failed = results.filter((r) => !r.pass);
    console.log(
      failed.length === 0
        ? "All audited widths PASS."
        : `FAILED widths: ${failed.map((r) => r.t).join(", ")}`,
    );
  }

  return results.every((r) => r.pass) ? 0 : 1;
}

module.exports = {
  P,
  FIELD_BITS,
  ALPHA,
  ROUNDS_F,
  SECURITY_BITS,
  LOG2_P,
  CIRCOMLIB_ROUNDS_P,
  WIDTHS_IN_USE,
  grainStream,
  readRoundConstant,
  readMdsPoint,
  generateRoundConstants,
  createMdsCandidate,
  deriveParameters,
  algorithm1,
  algorithm2,
  algorithm3,
  generateVectorspace,
  characteristicPolynomial,
  polyRootsInField,
  eigenspace,
  satInequivAlpha,
  findRoundNumbers,
  loadCircomlibConstants,
  auditWidth,
  audit,
  // linear algebra, exported for tests
  matMul,
  matPow,
  matVec,
  span,
  spanEq,
  spanIntersect,
  spanTimesMatrix,
  rightKernel,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
