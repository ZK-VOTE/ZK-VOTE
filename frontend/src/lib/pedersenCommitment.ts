/**
 * Pedersen Commitment (hiding-property enhancement)
 *
 * The existing identity commitment scheme used throughout ZK-VOTE is
 * `commitment = Poseidon(DOMAIN_TAG, secret, salt, blindingFactor)` (see
 * `frontend/src/lib/crypto.ts` and `circuits/vote.circom`). Poseidon is a
 * collision-resistant hash, so this commitment is *computationally* hiding,
 * but not *statistically* (information-theoretically) hiding.
 *
 * This module implements a Pedersen commitment using the Pedersen
 * hash-to-point construction over the Baby Jubjub curve, exactly as
 * shipped in `circomlib`/`circomlibjs` and mirrored by the Circom template
 * in `circuits/pedersen_commitment.circom`:
 *
 *   commitment = Pedersen(secret_LE_32B || blindingFactor_LE_32B).x
 *
 * Properties:
 *   - Perfectly hiding: for a fixed output point, every `secret` is equally
 *     likely once `blindingFactor` is drawn uniformly at random.
 *   - Computationally binding: finding two distinct `(secret, blinding)`
 *     pairs mapping to the same point requires breaking discrete log on
 *     Baby Jubjub.
 *
 * This is an additive building block: it does not replace the production
 * Poseidon commitment wired into `vote.circom` / `comment.circom` (doing so
 * is a breaking migration of the on-chain Merkle tree and is explicitly out
 * of scope here — see the PR description for details). It is provided as a
 * ready-to-integrate primitive plus a full test suite exercising the hiding
 * and binding properties described in the issue.
 */

import { buildPedersenHash, buildBabyjub } from "circomlibjs";

export const BN254_MODULUS = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

export interface PedersenCommitmentResult {
  /** x-coordinate of the commitment point, as a decimal string (field element). */
  commitment: string;
  /** y-coordinate of the commitment point, as a decimal string (field element). */
  commitmentY: string;
}

/**
 * Encode a field element as 32 little-endian bytes (matching
 * circomlibjs's `PedersenHash.buffer2bits`, and thus `Num2Bits` bit order
 * in the companion Circom circuit).
 */
function fieldElementToLE32(value: bigint): Buffer {
  if (value < 0n) {
    throw new Error("Pedersen commitment input must be non-negative");
  }
  const reduced = value % BN254_MODULUS;
  const buf = Buffer.alloc(32);
  let v = reduced;
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

let pedersenPromise: ReturnType<typeof buildPedersenHash> | null = null;
function getPedersen() {
  if (!pedersenPromise) {
    pedersenPromise = buildPedersenHash();
  }
  return pedersenPromise;
}

/**
 * Generate a cryptographically random blinding factor in the BN254 scalar
 * field, suitable for use as the `blindingFactor` input to
 * {@link computePedersenCommitment}.
 *
 * Requires the Web Crypto API (`globalThis.crypto.getRandomValues`), available
 * in all modern browsers and Node.js ≥ 18. Throws rather than silently falling
 * back to a non-CSPRNG source: a weak blinding factor breaks the hiding
 * property of the commitment and must never be permitted.
 */
export function generateBlindingFactor(): bigint {
  const bytes = new Uint8Array(32);
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.getRandomValues === "function"
  ) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    throw new Error(
      "generateBlindingFactor: no cryptographically secure random source is available. " +
        "Use Node.js ≥ 18 or a browser with the Web Crypto API. " +
        "Never substitute Math.random() — a weak blinding factor breaks commitment hiding.",
    );
  }
  let value = 0n;
  for (const b of bytes) {
    value = (value << 8n) | BigInt(b);
  }
  return value % BN254_MODULUS;
}

/**
 * Compute `C = Pedersen(secret || blindingFactor)`, returning the x/y
 * coordinates of the resulting Baby Jubjub point as decimal strings.
 *
 * `secret` and `blindingFactor` are reduced mod the BN254 scalar field
 * before encoding, matching the Circom circuit's `Num2Bits(256)` inputs
 * (which require the value to fit in 256 bits — always true for a reduced
 * field element).
 */
export async function computePedersenCommitment(
  secret: bigint | string,
  blindingFactor: bigint | string,
): Promise<PedersenCommitmentResult> {
  const secretBig = typeof secret === "string" ? BigInt(secret) : secret;
  const blindingBig =
    typeof blindingFactor === "string"
      ? BigInt(blindingFactor)
      : blindingFactor;

  const pedersen = await getPedersen();
  const babyJub = await buildBabyjub();

  const msg = Buffer.concat([
    fieldElementToLE32(secretBig),
    fieldElementToLE32(blindingBig),
  ]);

  // `pedersen.hash` returns a *packed* (compressed) point encoding; unpack
  // it to get the raw (x, y) affine coordinates, matching the `out[2]`
  // signal produced by circomlib's `Pedersen` circuit template (which never
  // compresses the point).
  const packed = pedersen.hash(msg);
  const [x, y] = babyJub.unpackPoint(packed);

  return {
    commitment: babyJub.F.toString(x),
    commitmentY: babyJub.F.toString(y),
  };
}
