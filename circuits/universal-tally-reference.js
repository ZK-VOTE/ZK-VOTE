/**
 * Pure-JS reference implementation of the universal tally semantics
 * (ZV-112 / Issue #952). Mirrors the arithmetic in tally_universal.circom
 * exactly - no circom toolchain required - so it can be used both as the
 * differential-test oracle and, if desired, as the trusted off-circuit
 * recomputation a verifier/indexer could use to sanity-check a tally
 * before it trusts the SNARK.
 *
 * Semantics ids match the circuit file:
 *   0 = yes/no, 1 = quadratic voting (QV), 2 = weighted voting.
 */

const SEMANTICS = Object.freeze({
  YES_NO: 0,
  QUADRATIC: 1,
  WEIGHTED: 2,
});

const SEMANTICS_VERSION = 1;

/** @typedef {{ nullifier: string|bigint, active: boolean, value: bigint }} Ballot */

function sumActiveNullifiers(ballots) {
  return ballots.reduce(
    (acc, b) => acc + (b.active ? BigInt(b.nullifier) : 0n),
    0n
  );
}

function countActive(ballots) {
  return ballots.reduce((acc, b) => acc + (b.active ? 1 : 0), 0);
}

/**
 * Tally a batch of yes/no ballots. `value` must be 0 or 1 for active
 * ballots (checked, matching the circuit's boolean constraint); inactive
 * (padding) ballots are ignored regardless of `value`.
 */
function tallyYesNo(ballots) {
  for (const b of ballots) {
    if (b.active && b.value !== 0n && b.value !== 1n) {
      throw new Error(`yes/no ballot value must be 0 or 1, got ${b.value}`);
    }
  }
  const numActive = countActive(ballots);
  const yesCount = ballots.reduce(
    (acc, b) => acc + (b.active ? Number(b.value) : 0),
    0
  );
  return {
    semanticsId: SEMANTICS.YES_NO,
    semanticsVersion: SEMANTICS_VERSION,
    nullifierRoot: sumActiveNullifiers(ballots),
    numActive,
    yesCount,
    noCount: numActive - yesCount,
  };
}

/** Tally a batch of QV ballots: sums each ballot's already-proven totalCreditsSpent. */
function tallyQuadratic(ballots) {
  const numActive = countActive(ballots);
  const totalCreditsSpent = ballots.reduce(
    (acc, b) => acc + (b.active ? BigInt(b.value) : 0n),
    0n
  );
  return {
    semanticsId: SEMANTICS.QUADRATIC,
    semanticsVersion: SEMANTICS_VERSION,
    nullifierRoot: sumActiveNullifiers(ballots),
    numActive,
    totalCreditsSpent,
  };
}

/** Tally a batch of weighted ballots: sums each ballot's already-proven weight. */
function tallyWeighted(ballots) {
  const numActive = countActive(ballots);
  const weightedTally = ballots.reduce(
    (acc, b) => acc + (b.active ? BigInt(b.value) : 0n),
    0n
  );
  return {
    semanticsId: SEMANTICS.WEIGHTED,
    semanticsVersion: SEMANTICS_VERSION,
    nullifierRoot: sumActiveNullifiers(ballots),
    numActive,
    weightedTally,
  };
}

const TALLY_FNS = {
  [SEMANTICS.YES_NO]: tallyYesNo,
  [SEMANTICS.QUADRATIC]: tallyQuadratic,
  [SEMANTICS.WEIGHTED]: tallyWeighted,
};

/**
 * Tally a batch against a declared semantics id. Throws if the batch's
 * ballot shape is incompatible with that semantics (the JS-level analogue
 * of the circuit rejecting a proof whose private inputs don't satisfy the
 * instantiated template's constraints), and throws on an unknown
 * semantics id (there is no "generic" tally).
 */
function tally(semanticsId, ballots) {
  const fn = TALLY_FNS[semanticsId];
  if (!fn) {
    throw new Error(`Unknown semantics id: ${semanticsId}`);
  }
  return fn(ballots);
}

/**
 * Mixed-proof-family rejection check (#699's "no tally-by-reinterpretation"):
 * mirrors the gate `submit_universal_tally` applies on-chain
 * (contracts/voting/src/lib.rs) before it will even attempt to verify a
 * proof - the proof's declared (semanticsId, semanticsVersion) tuple must
 * equal the proposal's pinned tuple, set once via `set_proposal_semantics`
 * before voting starts. This is deliberately checked *before* any SNARK
 * verification: a proof compiled for the wrong semantics has no VK
 * registered under the pinned tuple, so it would fail Groth16 verification
 * too, but the tuple check gives a precise, cheap rejection reason instead
 * of a generic "invalid proof".
 */
function tupleMatches(pinned, declared) {
  return (
    pinned.semanticsId === declared.semanticsId &&
    pinned.semanticsVersion === declared.semanticsVersion
  );
}

module.exports = {
  SEMANTICS,
  SEMANTICS_VERSION,
  tally,
  tallyYesNo,
  tallyQuadratic,
  tallyWeighted,
  tupleMatches,
};
