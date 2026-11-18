import { describe, expect, it } from "vitest";
import { provingPreflightError, selectProvingPlan } from "./devicePreflight";

const nav = (deviceMemory?: number) =>
  ({ deviceMemory, userAgent: "test" }) as Navigator & { deviceMemory?: number };

describe("ZV-129 device-aware preflight", () => {
  it("blocks depth-25 proving when estimated peak exceeds available RAM", () => {
    const result = selectProvingPlan(25, { navigator: nav(1), workerAvailable: true });
    expect(result.route).toBe("unavailable");
    expect(result.reason).toMatch(/depth-25/);
    expect(result.requiredMib).toBe(1200);
  });

  it("routes depth-18 proving to worker on constrained devices", () => {
    const result = selectProvingPlan(18, { navigator: nav(1), workerAvailable: true, rustAvailable: true });
    expect(result.route).toBe("worker");
    expect(result.budgetMib).toBe(870);
  });

  it("reserves Rust/main-thread proving for capable browsers", () => {
    expect(selectProvingPlan(20, { navigator: nav(8), workerAvailable: true, rustAvailable: true }).route).toBe("main");
  });

  it("never silently substitutes a shallower election circuit", () => {
    const result = selectProvingPlan(32, { navigator: nav(8), workerAvailable: true });
    expect(result.route).toBe("unavailable");
    expect(result.depth).toBe(32);
  });

  it("does not treat unknown browser RAM as a measurement", () => {
    const result = selectProvingPlan(18, { navigator: nav(), workerAvailable: true });
    expect(result.budgetMib).toBeNull();
    expect(result.route).toBe("worker");
  });

  it("shows actionable guidance when RAM is insufficient or worker unavailable", () => {
    expect(provingPreflightError(nav(0.5), 18)).toContain("No proof was started");
    expect(selectProvingPlan(18, { navigator: nav(1), workerAvailable: false }).reason).toContain("desktop browser");
  });
});
