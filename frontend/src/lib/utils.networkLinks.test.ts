import { describe, it, expect } from "vitest";
import {
  getLinkNetworkMismatch,
  normalizeNetworkName,
  withNetworkParam,
} from "./utils";

describe("network-qualified deep links (#758)", () => {
  it("normalises names and passphrases", () => {
    expect(normalizeNetworkName("Test SDF Network ; September 2015")).toBe("testnet");
    expect(normalizeNetworkName("Test SDF Future Network ; October 2022")).toBe("futurenet");
    expect(normalizeNetworkName("Public Global Stellar Network ; September 2015")).toBe("public");
  });

  it("appends the network to shareable paths", () => {
    expect(withNetworkParam("/daos/2-test-dao", "testnet")).toBe("/daos/2-test-dao?network=testnet");
    expect(withNetworkParam("/p?x=1", "futurenet")).toBe("/p?x=1&network=futurenet");
  });

  it("flags a link opened on a different network", () => {
    expect(getLinkNetworkMismatch("?network=testnet", "futurenet")).toBe("testnet");
    expect(getLinkNetworkMismatch("?network=testnet", "Test SDF Network ; September 2015")).toBeNull();
    expect(getLinkNetworkMismatch("", "futurenet")).toBeNull();
  });
});
