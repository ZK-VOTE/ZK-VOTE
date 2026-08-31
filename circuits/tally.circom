pragma circom 2.1.6;

template TallyProof(2) {
    signal input nullifierRoot;
    signal input yesCount;
    signal input noCount;
    signal private input nullifiers[2];
    signal private input voteChoices[2];

    signal acc[3];
    acc[0] <== 0;
    acc[1] <== acc[0] + nullifiers[0];
    acc[2] <== acc[1] + nullifiers[1];
    nullifierRoot === acc[2];

    voteChoices[0] * (1 - voteChoices[0]) === 0;
    voteChoices[1] * (1 - voteChoices[1]) === 0;

    yesCount === voteChoices[0] + voteChoices[1];
    noCount === 2 - yesCount;
}
