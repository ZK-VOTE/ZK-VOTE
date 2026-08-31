export declare const BN254_FR_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
declare const G1: import("@noble/curves/abstract/weierstrass").WeierstrassPointCons<bigint>;
type G1Point = typeof G1.prototype;
export declare const G1_GENERATOR: import("@noble/curves/abstract/weierstrass").WeierstrassPoint<bigint>;
export interface Ciphertext {
    c1: string;
    c2: string;
}
export interface DKGPublicKey {
    jointPublicKey: string;
}
export interface TallyProof {
    proof: string;
}
export declare function g1ToHex(point: G1Point): string;
export declare function hexToG1(hex: string): G1Point;
export declare function scalarMulG1(scalar: bigint): G1Point;
export declare function randomFr(): bigint;
export declare function generateElGamalKeypair(): {
    privateKey: bigint;
    publicKey: string;
};
export declare function encryptVote(publicKeyHex: string, vote: bigint): Ciphertext;
export declare function decryptVote(ciphertext: Ciphertext, privateKey: bigint): bigint;
export declare function homomorphicAdd(a: Ciphertext, b: Ciphertext): Ciphertext;
export declare function aggregateTally(encryptedVotes: Ciphertext[]): Ciphertext;
export declare function generatePolynomial(secret: bigint, degree: number): bigint[];
export declare function evaluatePolynomial(coeffs: bigint[], x: bigint): bigint;
export declare function modInverse(a: bigint, mod: bigint): bigint;
export declare function lagrangeCoefficientAtZero(index: number, allIndices: number[]): bigint;
export declare function createShares(secret: bigint, t: number, n: number): Array<{
    index: number;
    value: bigint;
}>;
export declare function reconstructSecret(shares: Array<{
    index: number;
    value: bigint;
}>): bigint;
export declare function generateVSSCommitments(coeffs: bigint[]): string[];
export declare function verifyVSSShare(share: bigint, index: number, commitments: string[]): boolean;
export declare function generateDKGShares(authorityIndex: number, t: number, n: number): {
    shares: Array<{
        toIndex: number;
        value: bigint;
    }>;
    commitments: string[];
    secret: bigint;
};
export declare function computeDKGResult(receivedShares: Array<{
    fromIndex: number;
    value: bigint;
}>, fromCommitments: string[][]): {
    privateKeyShare: bigint;
    publicKey: string;
};
export declare function computeJointPublicKey(fromCommitments: string[][]): string;
export declare function generateDecryptionShare(ciphertext: Ciphertext, privateKeyShare: bigint): string;
export declare function combineDecryptionShares(shares: Array<{
    authorityIndex: number;
    shareHex: string;
}>): string;
export declare function decryptTally(ciphertext: Ciphertext, combinedShareHex: string): bigint;
export declare function generateTallyProof(ciphertext: Ciphertext, combinedShareHex: string, decryptedTally: bigint, _privateKey: bigint): string;
export declare function verifyTallyProof(ciphertext: Ciphertext, combinedShareHex: string, decryptedTally: bigint, _proofHex: string): boolean;
export declare function generateVoteProof(_publicKeyHex: string, _vote: bigint, _r: bigint): string;
export {};
//# sourceMappingURL=threshold-crypto.d.ts.map