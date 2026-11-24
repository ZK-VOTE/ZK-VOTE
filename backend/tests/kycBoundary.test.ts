/**
 * KYC Boundary Policy Tests (SPIKE-146 / Issue #797)
 * 
 * Validates data minimization, access control, and retention enforcement
 */

import { describe, it, expect } from "@jest/globals";
import {
  minimizeKYCResponse,
  enforceMinimizationBoundary,
  checkKYCAccess,
  filterKYCByAccess,
  shouldPurgeKYCState,
  getRetentionHorizon,
  KYCAccessLevel,
  KYC_RETENTION,
  type MinimizedKYCState,
} from "../src/services/kycBoundary.js";

describe("KYC Boundary - Data Minimization", () => {
  it("should minimize anchor response to status-only fields", () => {
    const anchorResponse = {
      status: "completed",
      transaction_id: "abc123",
      user_name: "John Doe", // PII - should be dropped
      document_type: "passport", // PII - should be dropped
      kyc_provider: "Jumio", // Excess field - should be dropped
      message: "KYC verification successful",
    };

    const minimized = minimizeKYCResponse(anchorResponse);

    expect(minimized.status).toBe("completed");
    expect(minimized.reasonCode).toBeUndefined();
    expect(minimized.timestamp).toBeGreaterThan(0);
    expect((minimized as any).transaction_id).toBeUndefined();
    expect((minimized as any).user_name).toBeUndefined();
    expect((minimized as any).document_type).toBeUndefined();
    expect((minimized as any).kyc_provider).toBeUndefined();
  });

  it("should map verbose anchor statuses to coarse-grained enums", () => {
    const statuses = [
      { input: { status: "completed" }, expected: "completed" },
      { input: { status: "pending_anchor" }, expected: "pending_anchor" },
      { input: { status: "pending_trust" }, expected: "pending_anchor" },
      { input: { status: "pending_user" }, expected: "pending_anchor" },
      { input: { status: "pending_user_transfer_start" }, expected: "pending_user_transfer_start" },
      { input: { status: "pending_external" }, expected: "pending_external" },
      { input: { status: "error" }, expected: "error" },
      { input: { status: "incomplete" }, expected: "incomplete" },
      { input: { status: "unknown_status" }, expected: "incomplete" },
    ];

    for (const { input, expected } of statuses) {
      const minimized = minimizeKYCResponse(input);
      expect(minimized.status).toBe(expected);
    }
  });

  it("should map error messages to coarse-grained reason codes", () => {
    const cases = [
      { error: "KYC verification required", expected: "kyc_required" },
      { error: "Verification in progress", expected: "verification_in_progress" },
      { error: "Transfer pending", expected: "transfer_pending" },
      { error: "Insufficient information provided", expected: "insufficient_info" },
      { error: "Some unknown error", expected: "unknown_error" },
    ];

    for (const { error, expected } of cases) {
      const minimized = minimizeKYCResponse({ status: "error", error });
      expect(minimized.reasonCode).toBe(expected);
    }
  });

  it("should preserve interactive URL if present", () => {
    const response = {
      status: "incomplete",
      interactiveUrl: "https://anchor.circle.com/kyc/abc123",
      interactiveOrigin: "https://anchor.circle.com",
    };

    const minimized = minimizeKYCResponse(response);
    expect(minimized.interactiveUrl).toBe("https://anchor.circle.com/kyc/abc123");
    expect(minimized.interactiveOrigin).toBe("https://anchor.circle.com");
  });

  it("should detect excess fields in anchor responses", () => {
    const responseWithExcessFields = {
      status: "completed",
      user_name: "John Doe",
      document_type: "passport",
      kyc_provider: "Jumio",
    };

    // Unknown anchor fields are rejected in every environment.
    expect(() => enforceMinimizationBoundary(responseWithExcessFields)).toThrow(
      /outside the minimized KYC schema/
    );
  });

  it("should enforce strict mode if enabled", () => {
    const originalStrictMode = process.env.KYC_STRICT_MODE;
    process.env.KYC_STRICT_MODE = "true";

    const responseWithExcessFields = {
      status: "completed",
      user_name: "John Doe",
      document_type: "passport",
    };

    expect(() => enforceMinimizationBoundary(responseWithExcessFields)).toThrow(
      /excess KYC fields/
    );

    process.env.KYC_STRICT_MODE = originalStrictMode;
  });
});

describe("KYC Boundary - Access Control", () => {
  const mockState: MinimizedKYCState = {
    status: "completed",
    reasonCode: "kyc_required",
    interactiveUrl: "https://anchor.circle.com/kyc/abc123",
    interactiveOrigin: "https://anchor.circle.com",
    timestamp: Date.now(),
  };

  it("should enforce STATUS_ONLY access level", () => {
    expect(checkKYCAccess("status", KYCAccessLevel.STATUS_ONLY)).toBe(true);
    expect(checkKYCAccess("reasonCode", KYCAccessLevel.STATUS_ONLY)).toBe(false);
    expect(checkKYCAccess("interactiveUrl", KYCAccessLevel.STATUS_ONLY)).toBe(false);
  });

  it("should enforce REASON_CODE access level", () => {
    expect(checkKYCAccess("status", KYCAccessLevel.REASON_CODE)).toBe(true);
    expect(checkKYCAccess("reasonCode", KYCAccessLevel.REASON_CODE)).toBe(true);
    expect(checkKYCAccess("interactiveUrl", KYCAccessLevel.REASON_CODE)).toBe(false);
  });

  it("should enforce FULL access level", () => {
    expect(checkKYCAccess("status", KYCAccessLevel.FULL)).toBe(true);
    expect(checkKYCAccess("reasonCode", KYCAccessLevel.FULL)).toBe(true);
    expect(checkKYCAccess("interactiveUrl", KYCAccessLevel.FULL)).toBe(true);
    expect(checkKYCAccess("timestamp", KYCAccessLevel.FULL)).toBe(true);
  });

  it("should filter KYC state by access level", () => {
    const statusOnly = filterKYCByAccess(mockState, KYCAccessLevel.STATUS_ONLY);
    expect(statusOnly.status).toBe("completed");
    expect(statusOnly.reasonCode).toBeUndefined();
    expect(statusOnly.interactiveUrl).toBeUndefined();

    const reasonCode = filterKYCByAccess(mockState, KYCAccessLevel.REASON_CODE);
    expect(reasonCode.status).toBe("completed");
    expect(reasonCode.reasonCode).toBe("kyc_required");
    expect(reasonCode.interactiveUrl).toBeUndefined();

    const full = filterKYCByAccess(mockState, KYCAccessLevel.FULL);
    expect(full.status).toBe("completed");
    expect(full.reasonCode).toBe("kyc_required");
    expect(full.interactiveUrl).toBe("https://anchor.circle.com/kyc/abc123");
  });
});

describe("KYC Boundary - Retention Policy", () => {
  it("should calculate correct retention horizons", () => {
    expect(getRetentionHorizon("completed")).toBe(KYC_RETENTION.COMPLETED);
    expect(getRetentionHorizon("pending_anchor")).toBe(KYC_RETENTION.PENDING);
    expect(getRetentionHorizon("error")).toBe(KYC_RETENTION.FAILED);
  });

  it("should not purge recent completed transactions", () => {
    const state: MinimizedKYCState = {
      status: "completed",
      timestamp: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days old
    };
    expect(shouldPurgeKYCState(state)).toBe(false);
  });

  it("should purge old completed transactions after 90 days", () => {
    const state: MinimizedKYCState = {
      status: "completed",
      timestamp: Date.now() - 91 * 24 * 60 * 60 * 1000, // 91 days old
    };
    expect(shouldPurgeKYCState(state)).toBe(true);
  });

  it("should purge old pending transactions after 30 days", () => {
    const state: MinimizedKYCState = {
      status: "pending_anchor",
      timestamp: Date.now() - 31 * 24 * 60 * 60 * 1000, // 31 days old
    };
    expect(shouldPurgeKYCState(state)).toBe(true);
  });

  it("should purge old failed transactions after 7 days", () => {
    const state: MinimizedKYCState = {
      status: "error",
      timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days old
    };
    expect(shouldPurgeKYCState(state)).toBe(true);
  });
});

describe("KYC Boundary - Privacy Red Lines", () => {
  it("should never include vote nullifiers in minimized state", () => {
    const response = {
      status: "completed",
      vote_nullifier: "0x123abc", // Should never be present
      ballot_commitment: "0x456def", // Should never be present
    };

    const minimized = minimizeKYCResponse(response);
    expect((minimized as any).vote_nullifier).toBeUndefined();
    expect((minimized as any).ballot_commitment).toBeUndefined();
  });

  it("should redact PII from reason codes", () => {
    const response = {
      status: "error",
      error: "User John Doe failed verification at address 123 Main St",
    };

    const minimized = minimizeKYCResponse(response);
    // Reason code should be generic, never include PII
    expect(minimized.reasonCode).toBe("unknown_error");
    expect((minimized as any).error).toBeUndefined();
  });
});
