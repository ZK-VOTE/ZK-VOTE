import { describe, it, expect } from "vitest";
import { queryClient } from "./queryClient";

describe("client/server truth reconciliation (#755)", () => {
  it("refetches server truth after reconnect", () => {
    expect(queryClient.getDefaultOptions().queries?.refetchOnReconnect).toBe(true);
  });
});
