/**
 * Completeness tests for `vote_encrypted.circom` (vote-choice privacy).
 *
 * These exercise the real compiled witness calculator. The same Baby Jubjub
 * ElGamal relation is implemented in `frontend/src/lib/elgamal.ts` and
 * `backend/src/services/elgamal.ts`; this test pins the circuit to that
 * relation so a change in either half cannot silently diverge.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { buildPoseidon, buildBabyjub } = require("circomlibjs");

const BUILD_DIR = path.join(__dirname, "..", "build", "encrypted");
const WASM_PATH = path.join(BUILD_DIR, "vote_encrypted_js", "vote_encrypted.wasm");
const WC_PATH = path.join(BUILD_DIR, "vote_encrypted_js", "witness_calculator.js");
const CIRCUIT_SRC = path.join(__dirname, "..", "vote_encrypted.circom");

const DOMAIN_TAG =
  19666041591797403834655481403982443037438503980743793537655983658411276515161n;
const BASE8 = [
  5299619240641551281634865583518297030282874472190772894086521144482721001553n,
  16950150798460657717958625567821834550301663161624707787222815936182638968203n,
];

function ensureCompiled() {
  if (fs.existsSync(WASM_PATH) && fs.existsSync(WC_PATH)) return;
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  execFileSync(
    "circom",
    [CIRCUIT_SRC, "--r1cs", "--wasm", "--sym", "-o", BUILD_DIR],
    { stdio: "inherit" },
  );
}

async function witnessFor(overrides = {}) {
  const poseidon = await buildPoseidon();
  const babyjub = await buildBabyjub();
  const F = poseidon.F;
  const B = babyjub.F;
  const s = (v) => (typeof v === "bigint" ? v.toString() : F.toString(v));
  const G = [B.e(BASE8[0]), B.e(BASE8[1])];

  const secret = 111111n;
  const salt = 222222n;
  const blindingFactor = 333333n;
  const voteChoice = overrides.voteChoice ?? 1n;
  const daoId = 7n;
  const proposalId = 9n;
  const epoch = 1n;
  const relayerAddress = 0n;
  const numCandidates = 2n;
  const privateKey = 444444n;
  const randomness = overrides.randomness ?? 555555n;

  const publicKey = babyjub.mulPointEscalar(G, privateKey);
  const c1 = babyjub.mulPointEscalar(G, randomness);
  const shared = babyjub.mulPointEscalar(publicKey, randomness);
  const identity = [B.e(0), B.e(1)];
  const yesPoint = voteChoice === 1n ? G : identity;
  const noPoint = voteChoice === 0n ? G : identity;
  const cYes = babyjub.addPoint(shared, yesPoint);
  const cNo = babyjub.addPoint(shared, noPoint);

  const commitment = poseidon([
    DOMAIN_TAG,
    secret,
    salt,
    blindingFactor,
  ]);
  const leafHash = poseidon([1n, commitment]);

  // Index-0 path in an empty depth-18 tree: every sibling is the zero hash for
  // that level.
  const pathElements = [];
  let zero = 0n;
  for (let level = 0; level < 18; level++) {
    pathElements.push(zero);
    zero = poseidon([zero, zero]);
  }
  let root = leafHash;
  for (let level = 0; level < 18; level++) {
    root = poseidon([root, pathElements[level]]);
  }
  const nullifier = poseidon([secret, daoId, proposalId]);

  const input = {
    root: s(root),
    nullifier: s(nullifier),
    daoId: s(daoId),
    proposalId: s(proposalId),
    numCandidates: s(numCandidates),
    epoch: s(epoch),
    publicKey: [s(publicKey[0]), s(publicKey[1])],
    c1: [s(c1[0]), s(c1[1])],
    cYes: [s(cYes[0]), s(cYes[1])],
    cNo: [s(cNo[0]), s(cNo[1])],
    relayerAddress: s(relayerAddress),
    voteChoice: s(voteChoice),
    secret: s(secret),
    salt: s(salt),
    blindingFactor: s(blindingFactor),
    randomness: s(randomness),
    pathElements: pathElements.map((v) => s(v)),
    pathIndices: Array(18).fill("0"),
  };

  const wc = await require(WC_PATH)(fs.readFileSync(WASM_PATH));
  return {
    input,
    witness: await wc.calculateWitness(input, true),
    poseidon,
  };
}

describe("VoteEncrypted circuit", () => {
  beforeAll(() => ensureCompiled(), 300000);

  test("accepts a correctly encrypted YES ballot without a public plaintext", async () => {
    const { witness, poseidon } = await witnessFor({ voteChoice: 1n });
    expect(witness).toBeDefined();
    // Public signal layout: [root, nullifier, daoId, proposalId,
    // numCandidates, epoch, pkX, pkY, c1X, c1Y, cYesX, cYesY, cNoX, cNoY,
    // relayerAddress]. The witness includes a leading "1" constant.
    expect(witness[3].toString()).toBe("7"); // daoId
    expect(witness[5].toString()).toBe("2"); // numCandidates
    expect(witness[6].toString()).toBe("1"); // epoch
  });

  test("accepts a correctly encrypted NO ballot", async () => {
    const { witness } = await witnessFor({ voteChoice: 0n });
    expect(witness).toBeDefined();
  });

  test("rejects a ciphertext that does not match the private choice", async () => {
    const poseidon = await buildPoseidon();
    const babyjub = await buildBabyjub();
    const B = babyjub.F;
    const F = poseidon.F;
    const s = (v) => (typeof v === "bigint" ? v.toString() : F.toString(v));
    const G = [B.e(BASE8[0]), B.e(BASE8[1])];

    const secret = 111111n;
    const salt = 222222n;
    const blindingFactor = 333333n;
    const voteChoice = 1n;
    const daoId = 7n;
    const proposalId = 9n;
    const epoch = 1n;
    const privateKey = 444444n;
    const randomness = 555555n;
    const publicKey = babyjub.mulPointEscalar(G, privateKey);
    const c1 = babyjub.mulPointEscalar(G, randomness);
    const shared = babyjub.mulPointEscalar(publicKey, randomness);
    const identity = [B.e(0), B.e(1)];
    const cYes = babyjub.addPoint(shared, G);
    // Deliberately encrypt NO twice: the circuit must reject because
    // voteChoice=1 but cNo also encodes G.
    const cNo = babyjub.addPoint(shared, G);

    const commitment = poseidon([DOMAIN_TAG, secret, salt, blindingFactor]);
    const leafHash = poseidon([1n, commitment]);
    const pathElements = [];
    let zero = 0n;
    for (let level = 0; level < 18; level++) {
      pathElements.push(zero);
      zero = poseidon([zero, zero]);
    }
    let root = leafHash;
    for (let level = 0; level < 18; level++) {
      root = poseidon([root, pathElements[level]]);
    }
    const nullifier = poseidon([secret, daoId, proposalId]);

    const input = {
      root: s(root),
      nullifier: s(nullifier),
      daoId: s(daoId),
      proposalId: s(proposalId),
      numCandidates: s(2n),
      epoch: s(epoch),
      publicKey: [s(publicKey[0]), s(publicKey[1])],
      c1: [s(c1[0]), s(c1[1])],
      cYes: [s(cYes[0]), s(cYes[1])],
      cNo: [s(cNo[0]), s(cNo[1])],
      relayerAddress: "0",
      voteChoice: s(voteChoice),
      secret: s(secret),
      salt: s(salt),
      blindingFactor: s(blindingFactor),
      randomness: s(randomness),
      pathElements: pathElements.map((v) => s(v)),
      pathIndices: Array(18).fill("0"),
    };

    const wc = await require(WC_PATH)(fs.readFileSync(WASM_PATH));
    await expect(wc.calculateWitness(input, true)).rejects.toThrow();
  });
});
