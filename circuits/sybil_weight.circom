pragma circom 2.0.0;

include "node_modules/circomlib/circuits/comparators.circom";

// ────────────────────────────────────────────────────────────────────────────
// Sybil-resistance weight curve (issue #301)
// ────────────────────────────────────────────────────────────────────────────
//
// Bounds how much voting weight any single identity can carry, as a function of
// two things an attacker cannot mint on demand: how long the membership SBT has
// existed, and how much reputation it has accrued.
//
//     weight = min(MAX_WEIGHT, BASE_WEIGHT + age_points + rep_points)
//
// Both point terms are step functions — one point per threshold crossed — which
// is what makes them cheap here: a threshold is a single comparator, and the
// sum of comparator outputs is linear. A smooth curve (sqrt, log) would need
// either division or a lookup argument for no gain in the property that
// matters, which is the *bound*, not the shape.
//
// Two properties this encodes, and why:
//
//   * **Bounded amplification.** A fresh identity is worth BASE_WEIGHT and the
//     best possible identity is worth MAX_WEIGHT, so the advantage of an aged,
//     reputable member over a Sybil is a fixed ratio — currently 10:1 — never
//     unbounded. That is what caps the drain in THREAT_MODEL §"Sybil bounds":
//     N Sybils buy N * BASE_WEIGHT, linearly, with a real time cost per
//     identity to do any better.
//   * **Concavity.** Thresholds widen (7 → 30 → 90 → 180 → 365 days), so each
//     additional point costs more waiting than the last. Age farming hits
//     diminishing returns long before the cap.
//
// PARAMETER SYNC — these constants are duplicated in exactly three places and
// all three must agree, or a proof will verify against a weight the chain
// disagrees with:
//   * contracts/membership-sbt/src/lib.rs  (AGE_THRESHOLD_DAYS, REPUTATION_THRESHOLDS, …)
//   * this template
//   * backend/src/services/sybil.ts        (the API the UI reads)
// backend/test/sybil.test.ts asserts the TypeScript mirror matches the Rust.
template SybilWeightCurve() {
    var N_AGE = 5;
    var N_REP = 5;
    var AGE_THRESHOLDS[5] = [7, 30, 90, 180, 365];
    var REP_THRESHOLDS[5] = [1, 5, 15, 40, 100];
    var BASE_WEIGHT = 1;
    var MAX_WEIGHT = 10;

    // Caller MUST range-constrain both inputs to < 2^32 before wiring them in;
    // GreaterEqThan(32) is only exact on inputs that fit in 32 bits.
    signal input ageDays;
    signal input reputation;
    signal output weight;

    // Age points: one per crossed threshold.
    component ageGe[N_AGE];
    signal ageAcc[N_AGE + 1];
    ageAcc[0] <== 0;
    for (var i = 0; i < N_AGE; i++) {
        ageGe[i] = GreaterEqThan(32);
        ageGe[i].in[0] <== ageDays;
        ageGe[i].in[1] <== AGE_THRESHOLDS[i];
        ageAcc[i + 1] <== ageAcc[i] + ageGe[i].out;
    }

    // Reputation points: one per crossed threshold.
    component repGe[N_REP];
    signal repAcc[N_REP + 1];
    repAcc[0] <== 0;
    for (var j = 0; j < N_REP; j++) {
        repGe[j] = GreaterEqThan(32);
        repGe[j].in[0] <== reputation;
        repGe[j].in[1] <== REP_THRESHOLDS[j];
        repAcc[j + 1] <== repAcc[j] + repGe[j].out;
    }

    signal raw;
    raw <== BASE_WEIGHT + ageAcc[N_AGE] + repAcc[N_REP];

    // Cap at MAX_WEIGHT. `raw` is at most BASE_WEIGHT + N_AGE + N_REP = 11, so
    // 8 bits is comfortably wide enough for the comparison.
    component over = GreaterThan(8);
    over.in[0] <== raw;
    over.in[1] <== MAX_WEIGHT;

    // weight = over ? MAX_WEIGHT : raw, as a single multiplication.
    weight <== raw + over.out * (MAX_WEIGHT - raw);
}

// Derive whole-days-elapsed from two timestamps without division.
//
// Instead of computing `(snapshotTime - mintedAt) / 86400` in-circuit, the
// prover supplies `ageDays` as a witness and the circuit constrains it to be
// the unique correct bucket:
//
//     ageDays * 86400  <=  snapshotTime - mintedAt  <  (ageDays + 1) * 86400
//
// Two comparators and two constant multiplications, versus a division gadget.
// The bracket is what makes it sound: only one integer satisfies both bounds.
template AgeInDays(BITS) {
    signal input mintedAt;
    signal input snapshotTime;
    signal input ageDays;

    var SECONDS_PER_DAY = 86400;

    // Elapsed time must be non-negative — i.e. the SBT was minted at or before
    // the snapshot. Without this a prover could pick a future mint time and
    // wrap the subtraction around the field.
    component notFuture = LessEqThan(BITS);
    notFuture.in[0] <== mintedAt;
    notFuture.in[1] <== snapshotTime;
    notFuture.out === 1;

    signal elapsed;
    elapsed <== snapshotTime - mintedAt;

    // Lower bound: ageDays * 86400 <= elapsed
    component lower = LessEqThan(BITS);
    lower.in[0] <== ageDays * SECONDS_PER_DAY;
    lower.in[1] <== elapsed;
    lower.out === 1;

    // Upper bound: elapsed < (ageDays + 1) * 86400
    component upper = LessThan(BITS);
    upper.in[0] <== elapsed;
    upper.in[1] <== (ageDays + 1) * SECONDS_PER_DAY;
    upper.out === 1;
}
