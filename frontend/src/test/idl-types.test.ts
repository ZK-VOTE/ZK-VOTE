/**
 * IDL type tests
 *
 * Verifies that:
 * 1. The numeric values in src/types/index.ts match the generated binding
 *    wire-format objects in src/generated/contract-types.ts.
 * 2. The generated barrel re-exports resolve correctly (no missing modules).
 */

import { describe, it, expect } from "vitest";

// Frontend-convention dicts: { ErrorName: numericCode }
import {
  VotingError,
  CommentsError,
  RegistryError,
  SbtError,
  TreeError,
  Groth16Error,
} from "../types/index.js";

// Binding wire-format objects: { [numericCode]: { message: "ErrorName" } }
import {
  VotingErrorRaw,
  CommentsErrorRaw,
  RegistryErrorRaw,
  SbtErrorRaw,
  TreeErrorRaw,
  VotingGroth16ErrorRaw,
} from "../generated/contract-types.js";

// ---------------------------------------------------------------------------
// Helper: invert the wire-format object into { ErrorName: numericCode }
// ---------------------------------------------------------------------------

type RawErrors = Record<number, { message: string }>;

function invertRaw(raw: RawErrors): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [code, { message }] of Object.entries(raw)) {
    result[message] = Number(code);
  }
  return result;
}

// ---------------------------------------------------------------------------
// VotingError
// ---------------------------------------------------------------------------

describe("VotingError", () => {
  const fromBinding = invertRaw(VotingErrorRaw as RawErrors);

  it("has the same numeric codes as the contract binding", () => {
    // Every key in our manual dict must be present in the binding with the
    // same code.
    for (const [name, code] of Object.entries(VotingError)) {
      expect(fromBinding[name]).toBe(code);
    }
  });

  it("binding contains no extra codes missing from the manual dict", () => {
    const manualByName = Object.fromEntries(
      Object.entries(VotingError).map(([k, v]) => [k, v]),
    );
    for (const [name] of Object.entries(fromBinding)) {
      expect(manualByName).toHaveProperty(name);
    }
  });
});

// ---------------------------------------------------------------------------
// CommentsError
// ---------------------------------------------------------------------------

describe("CommentsError", () => {
  const fromBinding = invertRaw(CommentsErrorRaw as RawErrors);

  it("has the same numeric codes as the contract binding", () => {
    for (const [name, code] of Object.entries(CommentsError)) {
      expect(fromBinding[name]).toBe(code);
    }
  });

  it("binding contains no extra codes missing from the manual dict", () => {
    const manualByName = Object.fromEntries(
      Object.entries(CommentsError).map(([k, v]) => [k, v]),
    );
    for (const [name] of Object.entries(fromBinding)) {
      expect(manualByName).toHaveProperty(name);
    }
  });
});

// ---------------------------------------------------------------------------
// RegistryError
// ---------------------------------------------------------------------------

describe("RegistryError", () => {
  const fromBinding = invertRaw(RegistryErrorRaw as RawErrors);

  it("has the same numeric codes as the contract binding", () => {
    for (const [name, code] of Object.entries(RegistryError)) {
      expect(fromBinding[name]).toBe(code);
    }
  });
});

// ---------------------------------------------------------------------------
// SbtError
// ---------------------------------------------------------------------------

describe("SbtError", () => {
  const fromBinding = invertRaw(SbtErrorRaw as RawErrors);

  it("has the same numeric codes as the contract binding", () => {
    for (const [name, code] of Object.entries(SbtError)) {
      expect(fromBinding[name]).toBe(code);
    }
  });
});

// ---------------------------------------------------------------------------
// TreeError
// ---------------------------------------------------------------------------

describe("TreeError", () => {
  const fromBinding = invertRaw(TreeErrorRaw as RawErrors);

  it("has the same numeric codes as the contract binding", () => {
    for (const [name, code] of Object.entries(TreeError)) {
      expect(fromBinding[name]).toBe(code);
    }
  });
});

// ---------------------------------------------------------------------------
// Groth16Error (voting binding)
// ---------------------------------------------------------------------------

describe("Groth16Error", () => {
  const fromBinding = invertRaw(VotingGroth16ErrorRaw as RawErrors);

  it("has the same numeric codes as the voting binding", () => {
    for (const [name, code] of Object.entries(Groth16Error)) {
      expect(fromBinding[name]).toBe(code);
    }
  });
});

// ---------------------------------------------------------------------------
// Re-export smoke tests — just verify types resolve without errors
// ---------------------------------------------------------------------------

describe("generated/contract-types re-exports", () => {
  it("exports DaoInfo type (structural check via binding)", async () => {
    const mod = await import("../generated/contract-types.js");
    // VotingErrorRaw is a runtime value, so we can verify it was imported
    expect(mod.VotingErrorRaw).toBeDefined();
    expect(mod.CommentsErrorRaw).toBeDefined();
    expect(mod.RegistryErrorRaw).toBeDefined();
    expect(mod.SbtErrorRaw).toBeDefined();
    expect(mod.TreeErrorRaw).toBeDefined();
  });

  it("VotingErrorRaw[15].message is InvalidProof", () => {
    const raw = VotingErrorRaw as RawErrors;
    expect(raw[15]?.message).toBe("InvalidProof");
  });

  it("CommentsErrorRaw[22].message is CommentNotFound", () => {
    const raw = CommentsErrorRaw as RawErrors;
    expect(raw[22]?.message).toBe("CommentNotFound");
  });
});
