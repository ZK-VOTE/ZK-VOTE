import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateProposalTitle,
  validateDaoName,
  mergeProposalTitleCRDT,
  computeActionHash,
  enqueueOfflineAction,
  getOfflineQueue,
  clearOfflineQueue,
  processOfflineQueue,
  MAX_PROPOSAL_TITLE_BYTES,
  MAX_DAO_NAME_CHARS,
} from "./offlineQueue";
import * as api from "./api";

describe("offlineQueue & CRDT validation", () => {
  beforeEach(() => {
    clearOfflineQueue();
    vi.restoreAllMocks();
  });

  describe("Proposal title validation (#543)", () => {
    it("accepts valid proposal title within 100 UTF-8 bytes", () => {
      const title = "Increase treasury allocation to public goods";
      const result = validateProposalTitle(title);
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(title);
      expect(result.bytes).toBeLessThanOrEqual(MAX_PROPOSAL_TITLE_BYTES);
    });

    it("rejects proposal title exceeding 100 UTF-8 bytes", () => {
      const longTitle = "A".repeat(101);
      const result = validateProposalTitle(longTitle);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(
        "Title exceeds max limit of 100 UTF-8 bytes",
      );
    });

    it("correctly measures multi-byte UTF-8 characters", () => {
      // Each emoji or non-ASCII character can take 3 or 4 bytes
      const emojiTitle = "🚀".repeat(26); // 26 * 4 = 104 bytes
      const result = validateProposalTitle(emojiTitle);
      expect(result.valid).toBe(false);
      expect(result.bytes).toBe(104);
    });

    it("normalizes proposal titles to NFC", () => {
      const combining = "e\u0301"; // NFD 'é'
      const result = validateProposalTitle(combining);
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe("\u00E9"); // NFC 'é'
    });
  });

  describe("DAO name validation (#543)", () => {
    it("accepts valid DAO name <= 24 chars", () => {
      const name = "StellarBuilders";
      const result = validateDaoName(name);
      expect(result.valid).toBe(true);
      expect(result.length).toBeLessThanOrEqual(MAX_DAO_NAME_CHARS);
    });

    it("rejects DAO name exceeding 24 chars", () => {
      const longName = "A".repeat(25);
      const result = validateDaoName(longName);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("DAO name exceeds max limit of 24");
    });
  });

  describe("CRDT LWW Proposal Title Merge (#543)", () => {
    it("prefers newer edit when local timestamp is higher", () => {
      const local = { title: "Newer Title", timestamp: 2000 };
      const remote = { title: "Older Title", timestamp: 1000 };
      const merged = mergeProposalTitleCRDT(local, remote);
      expect(merged.title).toBe("Newer Title");
      expect(merged.timestamp).toBe(2000);
    });

    it("prefers remote edit when remote timestamp is higher", () => {
      const local = { title: "Older Title", timestamp: 1000 };
      const remote = { title: "Newer Remote Title", timestamp: 2000 };
      const merged = mergeProposalTitleCRDT(local, remote);
      expect(merged.title).toBe("Newer Remote Title");
      expect(merged.timestamp).toBe(2000);
    });

    it("truncates merged title to 100 UTF-8 bytes if needed", () => {
      const longLocal = { title: "B".repeat(150), timestamp: 3000 };
      const remote = { title: "Short", timestamp: 1000 };
      const merged = mergeProposalTitleCRDT(longLocal, remote);
      const encoder = new TextEncoder();
      expect(encoder.encode(merged.title).length).toBeLessThanOrEqual(
        MAX_PROPOSAL_TITLE_BYTES,
      );
    });
  });

  describe("Offline Queue Idempotency & 409 handling (#544)", () => {
    it("generates deterministic hash PK for vote actions", () => {
      const action1 = {
        type: "vote" as const,
        daoId: 1,
        payload: { nullifier: "0x123abc" },
      };
      const action2 = {
        type: "vote" as const,
        daoId: 1,
        payload: { nullifier: "0x123abc" },
      };
      expect(computeActionHash(action1)).toBe(computeActionHash(action2));
      expect(computeActionHash(action1)).toBe("vote_0x123abc");
    });

    it("deduplicates queued actions with the same hash PK", () => {
      enqueueOfflineAction({
        type: "vote",
        daoId: 1,
        payload: { nullifier: "0x999" },
      });
      enqueueOfflineAction({
        type: "vote",
        daoId: 1,
        payload: { nullifier: "0x999" },
      });

      const queue = getOfflineQueue();
      const votes = queue.filter((a) => a.id === "vote_0x999");
      expect(votes.length).toBe(1);
    });

    it("computes deterministic hash for non-vote actions regardless of object key order", () => {
      const actionA = {
        type: "proposal",
        daoId: 1,
        payload: { title: "Test", description: "Hello", z: 1, a: 2 },
      };
      const actionB = {
        type: "proposal",
        daoId: 1,
        payload: { a: 2, description: "Hello", title: "Test", z: 1 },
      };
      expect(computeActionHash(actionA)).toBe(computeActionHash(actionB));
    });

    it("distinguishes nested objects with different keys or values", () => {
      const action1 = {
        type: "proposal",
        daoId: 1,
        payload: { meta: { author: "Alice" } },
      };
      const action2 = {
        type: "proposal",
        daoId: 1,
        payload: { meta: { author: "Bob" } },
      };
      expect(computeActionHash(action1)).not.toBe(computeActionHash(action2));
    });

    it("treats HTTP 409 Conflict as successful completion ONLY for vote actions (#544)", async () => {
      enqueueOfflineAction({
        type: "vote",
        daoId: 1,
        payload: { nullifier: "0x409test" },
      });

      // Mock relayerFetch to return 409 Conflict
      vi.spyOn(api, "relayerFetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Already voted" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await processOfflineQueue();
      expect(result.processed).toBe(1);
      expect(result.failed).toBe(0);

      const queue = getOfflineQueue();
      expect(queue.find((a) => a.id === "vote_0x409test")).toBeUndefined();
    });

    it("does NOT dequeue non-vote actions when receiving 409 Conflict", async () => {
      enqueueOfflineAction({
        type: "proposal",
        daoId: 1,
        payload: { title: "Proposal 1" },
      });

      // Mock relayerFetch to return 409 Conflict on proposal creation
      vi.spyOn(api, "relayerFetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Proposal title conflict" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await processOfflineQueue();
      expect(result.processed).toBe(0);
      expect(result.failed).toBe(1);

      const queue = getOfflineQueue();
      expect(queue.length).toBe(1);
      expect(queue[0].type).toBe("proposal");
    });
  });
  it("ZV-132: duplicate flush triggers share one in-flight request", async () => {
    enqueueOfflineAction({
      type: "vote",
      daoId: 1,
      payload: { nullifier: "0xsame", proof: "data" },
    });
    let resolveRequest!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveRequest = resolve; });
    const fetchMock = vi.spyOn(api, "relayerFetch").mockReturnValueOnce(pending);
    const first = processOfflineQueue();
    const second = processOfflineQueue();
    expect(first).toBe(second);
    resolveRequest(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getOfflineQueue()).toHaveLength(0);
  });

});
