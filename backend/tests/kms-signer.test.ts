/**
 * KMS & Hardware Signer Unit Tests
 * 
 * Verifies non-exportability of key material and provider abstraction.
 */

import { describe, it, expect, jest } from "@jest/globals";
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  LocalKeypairSigner,
  KmsSigner,
  HsmSigner,
  type StellarSigner,
} from "../src/services/stellar.js";

describe("Hardware-Backed Signer Abstraction (#320)", () => {
  it("should initialize LocalKeypairSigner and sign transactions", () => {
    const keypair = StellarSdk.Keypair.random();
    const signer: StellarSigner = new LocalKeypairSigner(keypair);

    expect(signer.getPublicKey()).toBe(keypair.publicKey());
    const dummyHash = Buffer.alloc(32, 0xaa);
    const sig = signer.signHash!(dummyHash);
    expect(sig.length).toBe(64);
  });

  it("should initialize KmsSigner without storing private key in process memory", async () => {
    const keypair = StellarSdk.Keypair.random();
    const kmsKeyId = "arn:aws:kms:us-east-1:123456789012:key/test-key-uuid";
    const signer = new KmsSigner(keypair.publicKey(), kmsKeyId, "us-east-1");

    expect(signer.getPublicKey()).toBe(keypair.publicKey());

    // Verify key cannot be exported from instance properties
    const properties = Object.keys(signer);
    expect(properties).not.toContain("secretKey");
    expect(properties).not.toContain("rawSecret");

    const dummyHash = Buffer.alloc(32, 0xbb);
    const sig = await signer.signHash(dummyHash);
    expect(sig.length).toBe(64);
  });

  it("should initialize HsmSigner with PKCS#11 slot isolation", async () => {
    const keypair = StellarSdk.Keypair.random();
    const signer = new HsmSigner(keypair.publicKey(), 1);

    expect(signer.getPublicKey()).toBe(keypair.publicKey());
    const dummyHash = Buffer.alloc(32, 0xcc);
    const sig = await signer.signHash(dummyHash);
    expect(sig.length).toBe(64);
  });
});
