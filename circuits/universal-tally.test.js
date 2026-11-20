/**
 * Differential tests for the universal tally-semantics math (ZV-112 /
 * Issue #952). Exercises universal-tally-reference.js, which mirrors
 * tally_universal.circom's arithmetic exactly, against labelled fixtures
 * for all three semantics plus the mixed-proof-family rejection gate.
 *
 * This file is pure JS (no circom toolchain required) and is the
 * "differential math tests" + "mixed-ballot rejection evidence" the
 * acceptance criteria ask for at the specification level; actually
 * compiling tally_universal.circom and comparing its witness output
 * against this same oracle still needs the pinned circom 2.1.8 toolchain
 * (see circuits/COMPILATION.md) and has not been done here.
 */
const {
  SEMANTICS,
  SEMANTICS_VERSION,
  tally,
  tallyYesNo,
  tallyQuadratic,
  tallyWeighted,
  tupleMatches,
} = require("./universal-tally-reference.js");

function ballot(nullifier, active, value) {
  return { nullifier: BigInt(nullifier), active, value: BigInt(value) };
}

describe("tallyYesNo", () => {
  test("sums active yes/no ballots and ignores padding", () => {
    const ballots = [
      ballot(1, true, 1),
      ballot(2, true, 0),
      ballot(3, true, 1),
      ballot(0, false, 1), // padding slot: value must be ignored even though it's 1
    ];
    const result = tallyYesNo(ballots);
    expect(result.semanticsId).toBe(SEMANTICS.YES_NO);
    expect(result.semanticsVersion).toBe(SEMANTICS_VERSION);
    expect(result.numActive).toBe(3);
    expect(result.yesCount).toBe(2);
    expect(result.noCount).toBe(1);
    expect(result.nullifierRoot).toBe(1n + 2n + 3n);
  });

  test("rejects a non-boolean active-slot value", () => {
    expect(() => tallyYesNo([ballot(1, true, 2)])).toThrow(/0 or 1/);
  });

  test("empty batch tallies to zero", () => {
    const result = tallyYesNo([]);
    expect(result).toMatchObject({ numActive: 0, yesCount: 0, noCount: 0, nullifierRoot: 0n });
  });
});

describe("tallyQuadratic", () => {
  test("sums each ballot's already-proven totalCreditsSpent", () => {
    const ballots = [ballot(10, true, 9), ballot(11, true, 4), ballot(0, false, 999)];
    const result = tallyQuadratic(ballots);
    expect(result.semanticsId).toBe(SEMANTICS.QUADRATIC);
    expect(result.numActive).toBe(2);
    expect(result.totalCreditsSpent).toBe(13n);
    expect(result.nullifierRoot).toBe(21n);
  });
});

describe("tallyWeighted", () => {
  test("sums each ballot's already-proven weight contribution", () => {
    const ballots = [ballot(20, true, 500), ballot(21, true, 1500), ballot(22, true, 250)];
    const result = tallyWeighted(ballots);
    expect(result.semanticsId).toBe(SEMANTICS.WEIGHTED);
    expect(result.numActive).toBe(3);
    expect(result.weightedTally).toBe(2250n);
  });
});

describe("tally() dispatch", () => {
  test("routes to the right semantics implementation", () => {
    expect(tally(SEMANTICS.YES_NO, [ballot(1, true, 1)]).yesCount).toBe(1);
    expect(tally(SEMANTICS.QUADRATIC, [ballot(1, true, 4)]).totalCreditsSpent).toBe(4n);
    expect(tally(SEMANTICS.WEIGHTED, [ballot(1, true, 4)]).weightedTally).toBe(4n);
  });

  test("throws on an unknown semantics id (no generic tally)", () => {
    expect(() => tally(99, [])).toThrow(/Unknown semantics id/);
  });
});

describe("mixed-proof-family rejection (#699)", () => {
  test("a proof's declared tuple must equal the proposal's pinned tuple", () => {
    const pinned = { semanticsId: SEMANTICS.YES_NO, semanticsVersion: SEMANTICS_VERSION };

    const sameSemanticsSameVersion = { semanticsId: SEMANTICS.YES_NO, semanticsVersion: SEMANTICS_VERSION };
    expect(tupleMatches(pinned, sameSemanticsSameVersion)).toBe(true);

    const wrongSemantics = { semanticsId: SEMANTICS.QUADRATIC, semanticsVersion: SEMANTICS_VERSION };
    expect(tupleMatches(pinned, wrongSemantics)).toBe(false);

    const wrongVersion = { semanticsId: SEMANTICS.YES_NO, semanticsVersion: SEMANTICS_VERSION + 1 };
    expect(tupleMatches(pinned, wrongVersion)).toBe(false);
  });

  test("every pair of distinct semantics ids is mutually incompatible", () => {
    const ids = Object.values(SEMANTICS);
    for (const a of ids) {
      for (const b of ids) {
        const matches = tupleMatches(
          { semanticsId: a, semanticsVersion: 1 },
          { semanticsId: b, semanticsVersion: 1 }
        );
        expect(matches).toBe(a === b);
      }
    }
  });
});

// ─── Red-team / labelled fixtures ───────────────────────────────────────
// Mirrors the style of docs/abuse-detection-policy.md's drill scenarios:
// fixed, labelled inputs with an expected result, so a future change to
// the tally math has to consciously update this file.
describe("labelled fixtures", () => {
  const FIXTURES = [
    {
      name: "unanimous yes, 5 ballots",
      semanticsId: SEMANTICS.YES_NO,
      ballots: [1, 2, 3, 4, 5].map((n) => ballot(n, true, 1)),
      expected: { numActive: 5, yesCount: 5, noCount: 0 },
    },
    {
      name: "split vote, 7 ballots (4 yes / 3 no)",
      semanticsId: SEMANTICS.YES_NO,
      ballots: [
        ballot(1, true, 1),
        ballot(2, true, 1),
        ballot(3, true, 1),
        ballot(4, true, 1),
        ballot(5, true, 0),
        ballot(6, true, 0),
        ballot(7, true, 0),
      ],
      expected: { numActive: 7, yesCount: 4, noCount: 3 },
    },
    {
      name: "QV: three ballots spending 9, 4, 1 credits",
      semanticsId: SEMANTICS.QUADRATIC,
      ballots: [ballot(1, true, 9), ballot(2, true, 4), ballot(3, true, 1)],
      expected: { numActive: 3, totalCreditsSpent: 14n },
    },
    {
      name: "weighted: three ballots weighing 100, 250, 650",
      semanticsId: SEMANTICS.WEIGHTED,
      ballots: [ballot(1, true, 100), ballot(2, true, 250), ballot(3, true, 650)],
      expected: { numActive: 3, weightedTally: 1000n },
    },
  ];

  for (const fixture of FIXTURES) {
    test(fixture.name, () => {
      const result = tally(fixture.semanticsId, fixture.ballots);
      expect(result).toMatchObject(fixture.expected);
    });
  }
});
