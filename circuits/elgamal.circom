pragma circom 2.0.0;

include "node_modules/circomlib/circuits/babyjub.circom";
include "node_modules/circomlib/circuits/escalarmulfix.circom";
include "node_modules/circomlib/circuits/escalarmulany.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";

// Baby Jubjub ElGamal ballot encryption (issue: vote-choice privacy).
//
// Proves that c1, cYes and cNo are well-formed ElGamal ciphertexts under the
// election public key `pk`:
//
//   c1      = r * G
//   cYes    = r * pk + yes * G
//   cNo     = r * pk + no  * G
//   yes + no = 1,  yes in {0,1}
//
// The plaintext vote is never a public signal. Baby Jubjub is used instead of
// BN254 G1 because circomlib has constraint-efficient Edwards-curve templates
// (EscalarMulFix / EscalarMulAny) for it. The backend performs homomorphic
// addition and threshold decryption on the same curve; the contract treats the
// serialized points as opaque bytes and never sees a plaintext choice.
//
// Public outputs are serialized by the caller as 64-byte big-endian points
// (x || y), matching `frontend/src/lib/elgamal.ts`.
template ElGamalBallot() {
    // Private
    signal input vote;        // 0 = no, 1 = yes
    signal input randomness;  // ElGamal r, encoded as 253 bits

    // Public
    signal input publicKey[2]; // Baby Jubjub public key (x, y)

    signal output c1[2];
    signal output cYes[2];
    signal output cNo[2];

    // The vote is a bit. This also prevents a malicious prover from
    // encrypting an arbitrary field element that would corrupt the tally.
    vote * (vote - 1) === 0;

    // Public key must be a valid Baby Jubjub point.
    component pkCheck = BabyCheck();
    pkCheck.x <== publicKey[0];
    pkCheck.y <== publicKey[1];

    // r < 2^253. The honest client samples r modulo the prime-order subgroup,
    // so the range check is enough to bound the witness.
    component rBits = Num2Bits(253);
    rBits.in <== randomness;

    // c1 = r * G
    component mulG = EscalarMulFix(253, [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ]);
    for (var i = 0; i < 253; i++) {
        mulG.e[i] <== rBits.out[i];
    }

    // shared = r * pk
    component mulPk = EscalarMulAny(253);
    for (var i = 0; i < 253; i++) {
        mulPk.e[i] <== rBits.out[i];
    }
    mulPk.p[0] <== publicKey[0];
    mulPk.p[1] <== publicKey[1];

    // yes * G and no * G. G is Base8; [0,1] is the Edwards identity.
    var BASE8_X = 5299619240641551281634865583518297030282874472190772894086521144482721001553;
    var BASE8_Y = 16950150798460657717958625567821834550301663161624707787222815936182638968203;
    signal no <== 1 - vote;
    signal yesPoint[2];
    signal noPoint[2];
    yesPoint[0] <== vote * BASE8_X;
    yesPoint[1] <== 1 + vote * (BASE8_Y - 1);
    noPoint[0] <== no * BASE8_X;
    noPoint[1] <== 1 + no * (BASE8_Y - 1);

    component addYes = BabyAdd();
    addYes.x1 <== mulPk.out[0];
    addYes.y1 <== mulPk.out[1];
    addYes.x2 <== yesPoint[0];
    addYes.y2 <== yesPoint[1];

    component addNo = BabyAdd();
    addNo.x1 <== mulPk.out[0];
    addNo.y1 <== mulPk.out[1];
    addNo.x2 <== noPoint[0];
    addNo.y2 <== noPoint[1];

    c1[0] <== mulG.out[0];
    c1[1] <== mulG.out[1];
    cYes[0] <== addYes.xout;
    cYes[1] <== addYes.yout;
    cNo[0] <== addNo.xout;
    cNo[1] <== addNo.yout;

    // Outputs must be valid curve points. This catches malformed witnesses and
    // keeps the serialized ciphertext parseable by the relayer.
    component c1Check = BabyCheck();
    c1Check.x <== c1[0];
    c1Check.y <== c1[1];

    component cYesCheck = BabyCheck();
    cYesCheck.x <== cYes[0];
    cYesCheck.y <== cYes[1];

    component cNoCheck = BabyCheck();
    cNoCheck.x <== cNo[0];
    cNoCheck.y <== cNo[1];
}
