import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchWithProgress,
  isMeteredConnection,
  MeteredConnectionError,
} from "./fetchWithProgress";

afterEach(() => vi.unstubAllGlobals());

describe("metered download policy (#757)", () => {
  it("detects metered/slow connections", () => {
    expect(isMeteredConnection({ saveData: true })).toBe(true);
    expect(isMeteredConnection({ type: "cellular" })).toBe(true);
    expect(isMeteredConnection({ effectiveType: "2g" })).toBe(true);
    expect(isMeteredConnection({ type: "wifi", effectiveType: "4g" })).toBe(false);
    expect(isMeteredConnection(undefined)).toBe(false);
  });

  it("blocks the download on a metered connection when asked", async () => {
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      fetchWithProgress("/vote_final.zkey", undefined, { blockOnMetered: true }),
    ).rejects.toBeInstanceOf(MeteredConnectionError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
