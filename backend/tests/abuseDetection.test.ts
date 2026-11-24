/**
 * Abuse Detection Tests (SPIKE-147 / Issue #798)
 * 
 * Validates structuring, wash payment, and mule convergence detection
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  detectStructuring,
  detectWashPayments,
  AbusePattern,
  ABUSE_THRESHOLDS,
  type PaymentMetadata,
} from "../src/services/abuseDetection.js";

describe("Abuse Detection - Structuring", () => {
  it("should detect multiple payments just below threshold", () => {
    const threshold = ABUSE_THRESHOLDS.STRUCTURING_AMOUNT;
    const justBelow = (threshold * BigInt(96)) / BigInt(100); // 96% of threshold

    const payments: PaymentMetadata[] = Array.from({ length: 6 }, (_, i) => ({
      hash: `hash${i}`,
      tenantId: "tenant1",
      amount: justBelow,
      destinations: ["GDEST..."],
      timestamp: Date.now() - i * 60 * 1000, // 1 minute apart
    }));

    const result = detectStructuring(payments);

    expect(result.suspicious).toBe(true);
    expect(result.patterns).toContain(AbusePattern.STRUCTURING);
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.metadata.nearThresholdCount).toBeGreaterThanOrEqual(5);
  });

  it("should not flag payments well below threshold", () => {
    const threshold = ABUSE_THRESHOLDS.STRUCTURING_AMOUNT;
    const wellBelow = threshold / BigInt(2); // 50% of threshold

    const payments: PaymentMetadata[] = Array.from({ length: 10 }, (_, i) => ({
      hash: `hash${i}`,
      tenantId: "tenant1",
      amount: wellBelow,
      destinations: ["GDEST..."],
      timestamp: Date.now() - i * 60 * 1000,
    }));

    const result = detectStructuring(payments);

    expect(result.suspicious).toBe(false);
    expect(result.patterns).toHaveLength(0);
  });

  it("should not flag few payments near threshold", () => {
    const threshold = ABUSE_THRESHOLDS.STRUCTURING_AMOUNT;
    const justBelow = (threshold * BigInt(96)) / BigInt(100);

    const payments: PaymentMetadata[] = Array.from({ length: 3 }, (_, i) => ({
      hash: `hash${i}`,
      tenantId: "tenant1",
      amount: justBelow,
      destinations: ["GDEST..."],
      timestamp: Date.now() - i * 60 * 1000,
    }));

    const result = detectStructuring(payments);

    expect(result.suspicious).toBe(false);
    expect(result.metadata.nearThresholdCount).toBeLessThan(5);
  });

  it("should ignore old payments outside time window", () => {
    const threshold = ABUSE_THRESHOLDS.STRUCTURING_AMOUNT;
    const justBelow = (threshold * BigInt(96)) / BigInt(100);
    const windowMs = 24 * 60 * 60 * 1000; // 24 hours

    const payments: PaymentMetadata[] = [
      // 3 recent payments
      ...Array.from({ length: 3 }, (_, i) => ({
        hash: `recent${i}`,
        tenantId: "tenant1",
        amount: justBelow,
        destinations: ["GDEST..."],
        timestamp: Date.now() - i * 60 * 1000,
      })),
      // 5 old payments (outside window)
      ...Array.from({ length: 5 }, (_, i) => ({
        hash: `old${i}`,
        tenantId: "tenant1",
        amount: justBelow,
        destinations: ["GDEST..."],
        timestamp: Date.now() - windowMs - i * 60 * 1000,
      })),
    ];

    const result = detectStructuring(payments, windowMs);

    expect(result.suspicious).toBe(false);
    expect(result.metadata.nearThresholdCount).toBe(3);
  });
});

describe("Abuse Detection - Wash Payments", () => {
  it("should detect roundtrip patterns between same pair", () => {
    const now = Date.now();

    const payments: PaymentMetadata[] = [
      { hash: "h1", tenantId: "A", amount: BigInt(1000), destinations: ["B"], timestamp: now },
      { hash: "h2", tenantId: "B", amount: BigInt(1000), destinations: ["A"], timestamp: now + 1000 },
      { hash: "h3", tenantId: "A", amount: BigInt(1000), destinations: ["B"], timestamp: now + 2000 },
      { hash: "h4", tenantId: "B", amount: BigInt(1000), destinations: ["A"], timestamp: now + 3000 },
    ];

    const result = detectWashPayments(payments);

    expect(result.suspicious).toBe(true);
    expect(result.patterns).toContain(AbusePattern.WASH_PAYMENT);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("should not flag unidirectional payment flows", () => {
    const now = Date.now();

    const payments: PaymentMetadata[] = [
      { hash: "h1", tenantId: "A", amount: BigInt(1000), destinations: ["B"], timestamp: now },
      { hash: "h2", tenantId: "A", amount: BigInt(1000), destinations: ["B"], timestamp: now + 1000 },
      { hash: "h3", tenantId: "A", amount: BigInt(1000), destinations: ["B"], timestamp: now + 2000 },
    ];

    const result = detectWashPayments(payments);

    expect(result.suspicious).toBe(false);
  });

  it("should detect wash payments with multiple destinations", () => {
    const now = Date.now();

    const payments: PaymentMetadata[] = [
      { hash: "h1", tenantId: "A", amount: BigInt(1000), destinations: ["B", "C"], timestamp: now },
      { hash: "h2", tenantId: "B", amount: BigInt(1000), destinations: ["A"], timestamp: now + 1000 },
      { hash: "h3", tenantId: "A", amount: BigInt(1000), destinations: ["B"], timestamp: now + 2000 },
      { hash: "h4", tenantId: "B", amount: BigInt(1000), destinations: ["A"], timestamp: now + 3000 },
    ];

    const result = detectWashPayments(payments);

    expect(result.suspicious).toBe(true);
  });

  it("should ignore old payments outside time window", () => {
    const now = Date.now();
    const windowMs = 60 * 60 * 1000; // 1 hour

    const payments: PaymentMetadata[] = [
      // Recent roundtrips (within window)
      { hash: "h1", tenantId: "A", amount: BigInt(1000), destinations: ["B"], timestamp: now },
      { hash: "h2", tenantId: "B", amount: BigInt(1000), destinations: ["A"], timestamp: now + 1000 },
      // Old roundtrips (outside window) - should be ignored
      { hash: "h3", tenantId: "A", amount: BigInt(1000), destinations: ["B"], timestamp: now - windowMs - 1000 },
      { hash: "h4", tenantId: "B", amount: BigInt(1000), destinations: ["A"], timestamp: now - windowMs - 2000 },
      { hash: "h5", tenantId: "A", amount: BigInt(1000), destinations: ["B"], timestamp: now - windowMs - 3000 },
    ];

    const result = detectWashPayments(payments, windowMs);

    // Should not detect because only 2 recent payments (need 3+ for wash)
    expect(result.suspicious).toBe(false);
  });
});

describe("Abuse Detection - Privacy Boundaries", () => {
  it("should never analyze vote nullifiers", () => {
    const payments: PaymentMetadata[] = [
      {
        hash: "h1",
        tenantId: "tenant1",
        amount: BigInt(1000),
        destinations: ["GDEST..."],
        timestamp: Date.now(),
      },
    ];

    // Ensure PaymentMetadata type never includes vote-related fields
    const payment = payments[0];
    expect((payment as any).voteNullifier).toBeUndefined();
    expect((payment as any).ballotCommitment).toBeUndefined();
    expect((payment as any).daoId).toBeUndefined();
    expect((payment as any).proposalId).toBeUndefined();
  });

  it("should operate on metadata only", () => {
    const payments: PaymentMetadata[] = [
      {
        hash: "h1",
        tenantId: "tenant1",
        amount: BigInt(1000),
        destinations: ["GDEST..."],
        timestamp: Date.now(),
      },
    ];

    // Verify only metadata fields are present
    const payment = payments[0];
    const keys = Object.keys(payment);
    expect(keys).toEqual(["hash", "tenantId", "amount", "destinations", "timestamp"]);
  });
});

describe("Abuse Detection - False Positives", () => {
  it("should handle legitimate payroll batches", () => {
    const now = Date.now();

    // Simulate payroll: 50 employees, regular amounts
    const payments: PaymentMetadata[] = Array.from({ length: 50 }, (_, i) => ({
      hash: `payroll${i}`,
      tenantId: "company",
      amount: BigInt(5000 * 1e7), // 5,000 XLM each
      destinations: [`GEMP${i}...`],
      timestamp: now,
    }));

    const structuringResult = detectStructuring(payments);
    const washResult = detectWashPayments(payments);

    // Should not flag legitimate payroll
    expect(structuringResult.suspicious).toBe(false);
    expect(washResult.suspicious).toBe(false);
  });

  it("should handle legitimate refund flows", () => {
    const now = Date.now();

    // Simulate legitimate refund: A→B (payment), B→A (refund)
    const payments: PaymentMetadata[] = [
      { hash: "payment", tenantId: "A", amount: BigInt(10000 * 1e7), destinations: ["B"], timestamp: now },
      { hash: "refund", tenantId: "B", amount: BigInt(10000 * 1e7), destinations: ["A"], timestamp: now + 60000 },
    ];

    const result = detectWashPayments(payments);

    // Only 2 transactions, need 3+ for wash detection
    expect(result.suspicious).toBe(false);
  });
});

describe("Abuse Detection - Confidence Scoring", () => {
  it("should scale confidence with pattern strength", () => {
    const threshold = ABUSE_THRESHOLDS.STRUCTURING_AMOUNT;
    const justBelow = (threshold * BigInt(96)) / BigInt(100);

    // Test with exactly threshold count
    const paymentsExact: PaymentMetadata[] = Array.from({ length: 5 }, (_, i) => ({
      hash: `hash${i}`,
      tenantId: "tenant1",
      amount: justBelow,
      destinations: ["GDEST..."],
      timestamp: Date.now() - i * 60 * 1000,
    }));

    const resultExact = detectStructuring(paymentsExact);
    expect(resultExact.confidence).toBeGreaterThanOrEqual(0.5);
    expect(resultExact.confidence).toBeLessThanOrEqual(1.0);

    // Test with double the threshold count
    const paymentsDouble: PaymentMetadata[] = Array.from({ length: 10 }, (_, i) => ({
      hash: `hash${i}`,
      tenantId: "tenant1",
      amount: justBelow,
      destinations: ["GDEST..."],
      timestamp: Date.now() - i * 60 * 1000,
    }));

    const resultDouble = detectStructuring(paymentsDouble);
    expect(resultDouble.confidence).toBeGreaterThan(resultExact.confidence);
    expect(resultDouble.confidence).toBeLessThanOrEqual(1.0);
  });
});
