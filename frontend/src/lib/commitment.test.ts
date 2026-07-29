import { describe, it, expect } from "vitest";
import { buildPoseidon } from "circomlibjs";

const DOMAIN_TAG = BigInt("19666041591797403834655481403982443037438503980743793537655983658411276515161");

const BN254_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

async function computeCommitment(
  secret: string,
  salt: string,
  blindingFactor: string,
): Promise<string> {
  const poseidon = await buildPoseidon();
  return poseidon.F.toString(
    poseidon([DOMAIN_TAG, BigInt(secret), BigInt(salt), BigInt(blindingFactor)]),
  );
}

function randomFieldElement(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  bytes[0] &= 0x1f;
  let result = 0n;
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result % BN254_FIELD;
}

// Derive credentials deterministically (simulating wallet signature)
function deterministicDerive(seed: string): {
  secret: bigint;
  salt: bigint;
  blindingFactor: bigint;
} {
  const enc = new TextEncoder();
  const hash = (data: string) => {
    const bytes = enc.encode(data);
    let result = 0n;
    for (const b of bytes) {
      result = (result << 8n) | BigInt(b);
    }
    return result % BN254_FIELD;
  };
  return {
    secret: hash(`secret:${seed}`),
    salt: hash(`salt:${seed}`),
    blindingFactor: hash(`blinding:${seed}`),
  };
}

describe("Commitment Scheme Statistical Analysis", () => {
  it("generates uniformly distributed commitments from random inputs", async () => {
    const NUM_SAMPLES = 10000;
    const NUM_BINS = 100;
    const commitments: bigint[] = [];

    for (let i = 0; i < NUM_SAMPLES; i++) {
      const secret = randomFieldElement();
      const salt = randomFieldElement();
      const blindingFactor = randomFieldElement();
      const comm = await computeCommitment(
        secret.toString(),
        salt.toString(),
        blindingFactor.toString(),
      );
      commitments.push(BigInt(comm));
    }

    // Chi-squared test for uniformity
    const binSize = BN254_FIELD / BigInt(NUM_BINS);
    const observed = new Array(NUM_BINS).fill(0);

    for (const c of commitments) {
      const binIndex = Number(c / binSize);
      if (binIndex >= 0 && binIndex < NUM_BINS) {
        observed[binIndex]++;
      }
    }

    const expected = NUM_SAMPLES / NUM_BINS;
    let chiSquared = 0;
    for (let i = 0; i < NUM_BINS; i++) {
      const diff = observed[i] - expected;
      chiSquared += (diff * diff) / expected;
    }

    // For 99 degrees of freedom (100 bins - 1), 99% confidence chi-squared ≈ 135
    // Our critical value: chiSquared <= 160 is acceptable (conservative)
    expect(chiSquared).toBeLessThan(160);
    expect(chiSquared).toBeGreaterThan(50);
  }, 60000);

  it("generates uniformly distributed commitments from correlated inputs", async () => {
    const NUM_SAMPLES = 10000;
    const NUM_BINS = 100;
    const commitments: bigint[] = [];

    for (let i = 0; i < NUM_SAMPLES; i++) {
      // Simulate deterministic derivation from wallet signature
      const { secret, salt, blindingFactor } = deterministicDerive(`seed-${i}`);
      const comm = await computeCommitment(
        secret.toString(),
        salt.toString(),
        blindingFactor.toString(),
      );
      commitments.push(BigInt(comm));
    }

    const binSize = BN254_FIELD / BigInt(NUM_BINS);
    const observed = new Array(NUM_BINS).fill(0);

    for (const c of commitments) {
      const binIndex = Number(c / binSize);
      if (binIndex >= 0 && binIndex < NUM_BINS) {
        observed[binIndex]++;
      }
    }

    const expected = NUM_SAMPLES / NUM_BINS;
    let chiSquared = 0;
    for (let i = 0; i < NUM_BINS; i++) {
      const diff = observed[i] - expected;
      chiSquared += (diff * diff) / expected;
    }

    expect(chiSquared).toBeLessThan(160);
    expect(chiSquared).toBeGreaterThan(50);
  }, 60000);

  it("ensures domain-tagged output differs from plain Poseidon(secret, salt)", async () => {
    // Show that domain tagging changes the output
    const poseidon = await buildPoseidon();
    const secret = randomFieldElement();
    const salt = randomFieldElement();
    const blindingFactor = randomFieldElement();

    const plainCommitment = poseidon.F.toString(poseidon([secret, salt]));
    const domainTagged = poseidon.F.toString(
      poseidon([DOMAIN_TAG, secret, salt, blindingFactor]),
    );

    expect(domainTagged).not.toBe(plainCommitment);
  });

  it("produces distinct commitments for same secret/salt with different blinding factors", async () => {
    const secret = randomFieldElement().toString();
    const salt = randomFieldElement().toString();

    const comm1 = await computeCommitment(secret, salt, randomFieldElement().toString());
    const comm2 = await computeCommitment(secret, salt, randomFieldElement().toString());

    expect(comm1).not.toBe(comm2);
  });
});
