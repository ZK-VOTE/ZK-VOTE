import { describe, it, expect } from "vitest";
import {
  truncateAddress,
  truncateText,
  isUserRejection,
  isAccountNotFoundError,
  toSlug,
  toIdSlug,
  parseIdFromSlug,
  extractTxHash,
  cn,
} from "./utils";

describe("cn", () => {
  it("merges class names", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("handles conditional classes", () => {
    const condition = false;
    expect(cn("foo", condition && "bar", "baz")).toBe("foo baz");
  });

  it("merges Tailwind classes correctly", () => {
    expect(cn("p-4", "p-2")).toBe("p-2"); // tailwind-merge dedupes
  });
});

describe("truncateAddress", () => {
  it("truncates a long address", () => {
    const address = "GDXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    expect(truncateAddress(address)).toBe("GDXY...7890");
  });

  it("returns short addresses unchanged", () => {
    const address = "GDXYZ12";
    expect(truncateAddress(address)).toBe("GDXYZ12");
  });

  it("handles custom character counts", () => {
    const address = "GDXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    expect(truncateAddress(address, 6, 6)).toBe("GDXYZ1...567890");
  });

  it("handles empty string", () => {
    expect(truncateAddress("")).toBe("");
  });
});

describe("truncateText", () => {
  it("truncates long text", () => {
    const text = "This is a very long text that should be truncated";
    expect(truncateText(text, 20)).toBe("This is a very long ...");
  });

  it("returns short text unchanged", () => {
    const text = "Short";
    expect(truncateText(text, 20)).toBe("Short");
  });

  it("uses default max length of 30", () => {
    const text = "This text is exactly thirty one characters";
    expect(truncateText(text)).toBe("This text is exactly thirty on...");
  });

  it("handles empty string", () => {
    expect(truncateText("")).toBe("");
  });
});

describe("isUserRejection", () => {
  it("returns true for code -4", () => {
    expect(isUserRejection({ code: -4 })).toBe(true);
  });

  it("returns true for User rejected message", () => {
    expect(isUserRejection({ message: "User rejected the request" })).toBe(
      true,
    );
  });

  it("returns true for declined message", () => {
    expect(isUserRejection({ message: "Request was declined" })).toBe(true);
  });

  it("returns true for cancelled message", () => {
    expect(isUserRejection({ message: "User cancelled" })).toBe(true);
  });

  it("returns false for other errors", () => {
    expect(isUserRejection({ message: "Network error" })).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isUserRejection(null)).toBe(false);
    expect(isUserRejection(undefined)).toBe(false);
  });
});

describe("isAccountNotFoundError", () => {
  it("returns true for Account not found message", () => {
    expect(isAccountNotFoundError(new Error("Account not found"))).toBe(true);
  });

  it("returns true for does not exist message", () => {
    expect(
      isAccountNotFoundError(new Error("The account does not exist")),
    ).toBe(true);
  });

  it("returns false for other errors", () => {
    expect(isAccountNotFoundError(new Error("Network error"))).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isAccountNotFoundError(null)).toBe(false);
  });
});

describe("toSlug", () => {
  it("converts text to lowercase", () => {
    expect(toSlug("Hello World")).toBe("hello-world");
  });

  it("replaces spaces with hyphens", () => {
    expect(toSlug("my dao name")).toBe("my-dao-name");
  });

  it("removes special characters", () => {
    expect(toSlug("Test! @DAO #123")).toBe("test-dao-123");
  });

  it("handles multiple spaces", () => {
    expect(toSlug("too   many   spaces")).toBe("too-many-spaces");
  });

  it("trims whitespace", () => {
    expect(toSlug("  trimmed  ")).toBe("trimmed");
  });
});

describe("toIdSlug", () => {
  it("combines ID and slugified name", () => {
    expect(toIdSlug(1, "Test DAO")).toBe("1-test-dao");
  });

  it("returns just ID if name produces empty slug", () => {
    expect(toIdSlug(42, "!!!")).toBe("42");
  });
});

describe("parseIdFromSlug", () => {
  it("extracts ID from ID-slug format", () => {
    expect(parseIdFromSlug("1-test-dao")).toBe(1);
  });

  it("extracts ID when no slug present", () => {
    expect(parseIdFromSlug("42")).toBe(42);
  });

  it("returns null for invalid format", () => {
    expect(parseIdFromSlug("not-a-number")).toBe(null);
  });

  it("handles larger IDs", () => {
    expect(parseIdFromSlug("12345-my-org")).toBe(12345);
  });
});

describe("extractTxHash", () => {
  it("returns null for null/undefined", () => {
    expect(extractTxHash(null)).toBe(null);
    expect(extractTxHash(undefined)).toBe(null);
  });

  it("returns null for non-object types", () => {
    expect(extractTxHash("string")).toBe(null);
    expect(extractTxHash(123)).toBe(null);
    expect(extractTxHash(true)).toBe(null);
  });

  it("extracts hash from direct hash property", () => {
    expect(extractTxHash({ hash: "abc123" })).toBe("abc123");
  });

  it("returns null for non-string hash property", () => {
    expect(extractTxHash({ hash: 123 })).toBe(null);
    expect(extractTxHash({ hash: null })).toBe(null);
  });

  it("extracts hash from sendTransactionResponse", () => {
    const result = {
      sendTransactionResponse: {
        hash: "tx-hash-from-send",
      },
    };
    expect(extractTxHash(result)).toBe("tx-hash-from-send");
  });

  it("extracts txHash from getTransactionResponse", () => {
    const result = {
      getTransactionResponse: {
        txHash: "tx-hash-from-get",
      },
    };
    expect(extractTxHash(result)).toBe("tx-hash-from-get");
  });

  it("prefers direct hash over nested responses", () => {
    const result = {
      hash: "direct-hash",
      sendTransactionResponse: {
        hash: "nested-hash",
      },
    };
    expect(extractTxHash(result)).toBe("direct-hash");
  });

  it("returns null for empty object", () => {
    expect(extractTxHash({})).toBe(null);
  });

  it("returns null when nested response is not an object", () => {
    expect(extractTxHash({ sendTransactionResponse: "not-an-object" })).toBe(
      null,
    );
    expect(extractTxHash({ getTransactionResponse: 123 })).toBe(null);
  });
});
