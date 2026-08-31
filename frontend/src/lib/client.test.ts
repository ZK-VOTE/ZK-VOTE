import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getZkVoteClient,
  __clearClientCache,
  checkContractDrift,
} from "./client";
import { getOfflineQueue, enqueueOfflineAction } from "./offlineQueue";

describe("ZkVoteClient - unified SDK", () => {
  beforeEach(() => {
    __clearClientCache();
    localStorage.clear();
  });

  it("provides contract clients", () => {
    const c = getZkVoteClient("GTEST");
    expect(c.daoRegistry).toBeDefined();
    expect(c.membershipSbt).toBeDefined();
    expect(c.membershipTree).toBeDefined();
    expect(c.voting).toBeDefined();
    expect(c.comments).toBeDefined();
  });

  it("caches client per publicKey", () => {
    const a = getZkVoteClient("GABC");
    const b = getZkVoteClient("GABC");
    expect(a).toBe(b);
  });

  it("returns read-only singleton for null", () => {
    const a = getZkVoteClient(null);
    const b = getZkVoteClient(null);
    expect(a).toBe(b);
  });

  it("offline queue enqueue and retrieval", () => {
    const entry = enqueueOfflineAction({
      type: "vote",
      payload: { daoId: 1 },
      daoId: 1,
    });
    expect(entry.id).toBeDefined();
    const q = getOfflineQueue();
    expect(q.length).toBe(1);
    expect(q[0].type).toBe("vote");
  });

  it("drift guard passes for valid contracts", async () => {
    const report = await checkContractDrift();
    expect(report.driftDetected).toBe(false);
  });

  it("drift guard detects mismatch", async () => {
    const report = await checkContractDrift({
      REGISTRY_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    } as unknown as Record<string, string>);
    expect(report.driftDetected).toBe(true);
  });
});
