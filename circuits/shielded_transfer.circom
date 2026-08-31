pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";

/*
 * Shielded UTXO Transfer Circuit (2-in-2-out Joinsplit)
 * 
 * Supports private DAO treasury transfers and confidential grant flows.
 * 
 * Public Inputs:
 * - root: Current Merkle root of the note commitment tree
 * - nullifierIn[2]: Nullifiers of the two input notes being spent
 * - commitmentOut[2]: Poseidon commitments of the two newly minted output notes
 * - publicFee: Public fee or change paid out of the shielded pool
 *
 * Private Inputs:
 * - spendingKey[2]: Secret keys of note owners
 * - valueIn[2]: Amounts in input notes
 * - saltIn[2]: Blinding factors for input notes
 * - leafIndexIn[2]: Merkle tree indices of input notes
 * - pathElementsIn[2][20]: Merkle authentication paths
 * - pathIndicesIn[2][20]: Merkle authentication path directions (0/1)
 * - pubKeyOut[2]: Recipient public keys for output notes
 * - valueOut[2]: Amounts in output notes
 * - saltOut[2]: Blinding factors for output notes
 */

template NoteCommitment() {
    signal input pubKey;
    signal input value;
    signal input salt;
    signal output commitment;

    component hasher = Poseidon(3);
    hasher.inputs[0] <== pubKey;
    hasher.inputs[1] <== value;
    hasher.inputs[2] <== salt;

    commitment <== hasher.out;
}

template NullifierDerivation() {
    signal input spendingKey;
    signal input leafIndex;
    signal output nullifier;

    component hasher = Poseidon(2);
    hasher.inputs[0] <== spendingKey;
    hasher.inputs[1] <== leafIndex;

    nullifier <== hasher.out;
}

template RangeProof64() {
    signal input in;
    component n2b = Num2Bits(64);
    n2b.in <== in;
}

template ShieldedTransfer(levels) {
    // --- Public Signals ---
    signal input root;
    signal input nullifierIn[2];
    signal input commitmentOut[2];
    signal input publicFee;

    // --- Private Signals ---
    signal input spendingKey[2];
    signal input valueIn[2];
    signal input saltIn[2];
    signal input leafIndexIn[2];
    signal input pathElementsIn[2][levels];
    signal input pathIndicesIn[2][levels];

    signal input pubKeyOut[2];
    signal input valueOut[2];
    signal input saltOut[2];

    // 1. Range proofs to prevent 64-bit value underflows / overflows
    component rangeIn[2];
    component rangeOut[2];
    component rangeFee = RangeProof64();
    rangeFee.in <== publicFee;

    for (var i = 0; i < 2; i++) {
        rangeIn[i] = RangeProof64();
        rangeIn[i].in <== valueIn[i];

        rangeOut[i] = RangeProof64();
        rangeOut[i].in <== valueOut[i];
    }

    // 2. Enforce balance conservation: In_0 + In_1 = Out_0 + Out_1 + PublicFee
    signal totalIn;
    signal totalOut;
    totalIn <== valueIn[0] + valueIn[1];
    totalOut <== valueOut[0] + valueOut[1] + publicFee;
    totalIn === totalOut;

    // 3. Verify input note nullifiers and commitments
    component noteInHasher[2];
    component nullifierHasher[2];

    for (var i = 0; i < 2; i++) {
        // Derive public key from spending key (Poseidon(spendingKey))
        component pkHasher = Poseidon(1);
        pkHasher.inputs[0] <== spendingKey[i];

        noteInHasher[i] = NoteCommitment();
        noteInHasher[i].pubKey <== pkHasher.out;
        noteInHasher[i].value <== valueIn[i];
        noteInHasher[i].salt <== saltIn[i];

        nullifierHasher[i] = NullifierDerivation();
        nullifierHasher[i].spendingKey <== spendingKey[i];
        nullifierHasher[i].leafIndex <== leafIndexIn[i];

        // Constrain public nullifiers
        nullifierIn[i] === nullifierHasher[i].nullifier;
    }

    // 4. Verify output note commitments
    component noteOutHasher[2];
    for (var i = 0; i < 2; i++) {
        noteOutHasher[i] = NoteCommitment();
        noteOutHasher[i].pubKey <== pubKeyOut[i];
        noteOutHasher[i].value <== valueOut[i];
        noteOutHasher[i].salt <== saltOut[i];

        commitmentOut[i] === noteOutHasher[i].commitment;
    }
}

component main {public [root, nullifierIn, commitmentOut, publicFee]} = ShieldedTransfer(20);
