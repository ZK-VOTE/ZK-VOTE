import { describe, it, expect } from "vitest";
import {
  deriveElectionSecret,
  generateMasterSecret,
  BN254_MODULUS,
} from "./crypto";
import {
  generateMnemonic,
  masterSecretToMnemonic,
  mnemonicToMasterSecret,
  mnemonicToEntropy,
  entropyToMnemonic,
} from "./bip39";

describe("HD Key Derivation & BIP-39 Mnemonic Hierarchy", () => {
  it("generates valid BIP-39 mnemonics and supports roundtrip encoding", () => {
    const mnemonic12 = generateMnemonic(12);
    expect(mnemonic12.split(" ").length).toBe(12);

    const entropy12 = mnemonicToEntropy(mnemonic12);
    expect(entropy12.length).toBe(16);
    const recoveredMnemonic12 = entropyToMnemonic(entropy12);
    expect(recoveredMnemonic12).toBe(mnemonic12);

    const masterSecret = mnemonicToMasterSecret(mnemonic12);
    expect(masterSecret).toBeGreaterThan(0n);
    expect(masterSecret).toBeLessThan(BN254_MODULUS);

    const regeneratedMnemonic = masterSecretToMnemonic(masterSecret);
    expect(regeneratedMnemonic.split(" ").length).toBe(12);
  });

  it("derives deterministic election secrets for the same election ID", async () => {
    const masterSecret = generateMasterSecret();
    const electionId = "election-2026-dao-42";

    const keys1 = await deriveElectionSecret(masterSecret, electionId);
    const keys2 = await deriveElectionSecret(masterSecret, electionId);

    expect(keys1.electionSecret).toBe(keys2.electionSecret);
    expect(keys1.commitment).toBe(keys2.commitment);
    expect(keys1.nullifier).toBe(keys2.nullifier);
  });

  it("satisfies circuit compatibility: derived secrets stay within BN254 scalar field", async () => {
    const masterSecret = generateMasterSecret();
    const electionKeys = await deriveElectionSecret(masterSecret, "election-77");

    const secretBigInt = BigInt(electionKeys.electionSecret);
    const commitmentBigInt = BigInt(electionKeys.commitment);
    const nullifierBigInt = BigInt(electionKeys.nullifier);

    expect(secretBigInt).toBeGreaterThanOrEqual(0n);
    expect(secretBigInt).toBeLessThan(BN254_MODULUS);

    expect(commitmentBigInt).toBeGreaterThanOrEqual(0n);
    expect(commitmentBigInt).toBeLessThan(BN254_MODULUS);

    expect(nullifierBigInt).toBeGreaterThanOrEqual(0n);
    expect(nullifierBigInt).toBeLessThan(BN254_MODULUS);
  });

  it("tests UNLINKABILITY: election secrets derived from the same master secret for different elections appear random and distinct", async () => {
    const masterSecret = generateMasterSecret();

    const keysElectionA = await deriveElectionSecret(masterSecret, "election-A");
    const keysElectionB = await deriveElectionSecret(masterSecret, "election-B");

    // Election secrets must be distinct
    expect(keysElectionA.electionSecret).not.toBe(keysElectionB.electionSecret);
    expect(keysElectionA.commitment).not.toBe(keysElectionB.commitment);
    expect(keysElectionA.nullifier).not.toBe(keysElectionB.nullifier);

    // Difference between election secrets should be large (pseudorandom distribution)
    const secretA = BigInt(keysElectionA.electionSecret);
    const secretB = BigInt(keysElectionB.electionSecret);
    const diff = secretA > secretB ? secretA - secretB : secretB - secretA;

    // Difference should exceed 2^128 (random field element behavior)
    expect(diff).toBeGreaterThan(BigInt("0x10000000000000000000000000000000"));
  });

  it("derives valid secrets from BIP-39 mnemonic phrase", async () => {
    const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const keys = await deriveElectionSecret(mnemonic, "election-101");

    expect(keys.electionSecret).toBeDefined();
    expect(keys.commitment).toBeDefined();
    expect(keys.nullifier).toBeDefined();
  });
});
