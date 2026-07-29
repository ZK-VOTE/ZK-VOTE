pragma circom 2.0.0;

include "node_modules/circomlib/circuits/comparators.circom";

// Bit-decomposition range proof.
//
// Proves that `in` lies in the inclusive interval [0, maxValue], where
// maxValue < 2^BITS.
//
// This is the "simple" range-proof construction referenced in the quadratic
// voting design: the value is decomposed into BITS boolean bits and the
// recomposition sum(b_i * 2^i) is constrained to equal the input. A production
// deployment could swap this for a Bulletproofs inner-product argument, but the
// bit-decomposition form is fully in-circuit and sound.
//
//   in         : value being range-checked (private in the caller)
//   maxValue   : inclusive upper bound (a per-instance constant / signal)
//   out        : echoes `in` so the template can be chained if desired
template RangeProof(BITS) {
    signal input in;
    signal input maxValue;
    signal output out;

    // 1. Decompose `in` into BITS boolean bits and enforce recomposition.
    //    Constraining acc === in simultaneously proves 0 <= in < 2^BITS.
    signal bits[BITS];
    var acc = 0;
    var pow = 1;
    for (var i = 0; i < BITS; i++) {
        bits[i] <-- (in >> i) & 1;
        // Booleanity: b * (b - 1) == 0
        bits[i] * (bits[i] - 1) === 0;
        acc += bits[i] * pow;
        pow = pow * 2;
    }
    acc === in;

    // 2. Enforce the inclusive upper bound: in <= maxValue.
    //    Both operands are < 2^BITS, so LessEqThan(BITS) is exact.
    component leq = LessEqThan(BITS);
    leq.in[0] <== in;
    leq.in[1] <== maxValue;
    leq.out === 1;

    out <== in;
}
