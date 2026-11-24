import { describe, it, expect } from "vitest";
import { isSafeKey, safeClone, safeMerge, safeJsonParse, mergeVersioned } from "./safeMerge";

describe("safeMerge and Prototype Pollution Protections", () => {
  it("correctly identifies safe vs unsafe keys", () => {
    expect(isSafeKey("name")).toBe(true);
    expect(isSafeKey("__proto__")).toBe(false);
    expect(isSafeKey("constructor")).toBe(false);
    expect(isSafeKey("prototype")).toBe(false);
    expect(isSafeKey("__foo")).toBe(false);
  });

  it("safeClone strips prototype pollution keys", () => {
    const malicious = JSON.parse(
      '{"name":"test","__proto__":{"polluted":true}}',
    );
    const cloned = safeClone(malicious);
    expect(cloned.name).toBe("test");
    expect(({} as any).polluted).toBeUndefined();
  });

  it("safeMerge merges objects safely without prototype pollution", () => {
    const base = { a: 1, nested: { b: 2 } };
    const malicious = JSON.parse(
      '{"__proto__":{"polluted":true},"nested":{"c":3}}',
    );
    const merged = safeMerge(base, malicious);

    expect(merged.a).toBe(1);
    expect(merged.nested).toEqual({ b: 2, c: 3 });
    expect(({} as any).polluted).toBeUndefined();
  });

  it("safeJsonParse strips prototype pollution keys during parsing", () => {
    const jsonStr = '{"title":"DAO","__proto__":{"isAdmin":true}}';
    const parsed = safeJsonParse<{ title: string }>(jsonStr);
    expect(parsed?.title).toBe("DAO");
    expect(({} as any).isAdmin).toBeUndefined();
  });
});

describe("ZV-132 deterministic interleavings", () => {
  it("never regresses a higher sequence regardless of seeded event order", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const events = Array.from({ length: 20 }, (_, i) => ({
        value: { tally: i },
        sequence: i + 1,
        updatedAt: 1000 + i,
      }));
      let rng = seed;
      for (let i = events.length - 1; i > 0; i--) {
        rng = (rng * 1664525 + 1013904223) >>> 0;
        const j = rng % (i + 1);
        [events[i], events[j]] = [events[j], events[i]];
      }
      let state = { value: { tally: 0 }, sequence: 0, updatedAt: 0 };
      for (const e of events) {
        const merged = mergeVersioned(state, e);
        expect(merged.kind).not.toBe("conflict");
        state = merged.current;
      }
      expect(state.sequence).toBe(20);
      expect(state.value.tally).toBe(19);
    }
  });

  it("surfaces a typed conflict for equal clocks but unequal offline edits", () => {
    const a = { value: { title: "A" }, sequence: 7, updatedAt: 1234 };
    const b = { value: { title: "B" }, sequence: 7, updatedAt: 1234 };
    const result = mergeVersioned(a, b);
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") expect(result.incoming.value.title).toBe("B");
  });
});
