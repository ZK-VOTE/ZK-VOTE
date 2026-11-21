import { describe, it, expect, vi, beforeEach } from "vitest";
import { trackOnboardingStep } from "./onboardingFunnel";

describe("trackOnboardingStep", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs only the step name, with no identifying data", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true } as unknown as Response);
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock;

    trackOnboardingStep("secret_created");

    expect(fetchMock).toHaveBeenCalledWith(
      "/onboarding/funnel",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(Object.keys(body)).toEqual(["step"]);
    expect(body.step).toBe("secret_created");
  });

  it("never throws when fetch rejects", () => {
    (global as unknown as { fetch: typeof fetch }).fetch = vi
      .fn()
      .mockRejectedValue(new Error("network down"));

    expect(() => trackOnboardingStep("registration_started")).not.toThrow();
  });

  it("never throws when fetch is unavailable", () => {
    // @ts-expect-error simulating a non-browser environment
    delete (global as { fetch?: typeof fetch }).fetch;
    expect(() => trackOnboardingStep("registration_started")).not.toThrow();
  });
});
