pragma circom 2.0.0;

include "../range_proof.circom";

// Standalone test instantiation of the bit-decomposition range proof.
// 4-bit decomposition (values 0..15); `maxValue` is supplied as an input so the
// test can exercise different inclusive bounds (e.g. 0..5).
component main = RangeProof(4);
