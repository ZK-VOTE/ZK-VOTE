import { describe, it, expect, vi } from "vitest";
import {
  encodeLockCalldata,
  encodeRefundCalldata,
  etherToWeiHex,
  waitForLockId,
  LOCK_SELECTOR,
  REFUND_SELECTOR,
  LOCKED_EVENT_TOPIC,
} from "./treasuryEscrow";

describe("treasuryEscrow calldata encoding", () => {
  it("encodes lock() calldata with the correct selector and word layout", () => {
    const calldata = encodeLockCalldata(
      1,
      7,
      "0x1111111111111111111111111111111111111111".slice(0, 42),
    );
    expect(calldata.startsWith(LOCK_SELECTOR)).toBe(true);
    // selector (4 bytes) + 3 words (32 bytes each) = 4 + 96 = 100 bytes -> 200 hex chars + 0x
    expect(calldata.length).toBe(2 + 8 + 64 * 3);
    // daoId word
    expect(calldata.slice(10, 74)).toBe("0".repeat(63) + "1");
    // proposalId word
    expect(calldata.slice(74, 138)).toBe("0".repeat(63) + "7");
  });

  it("rejects an invalid recipient address", () => {
    expect(() => encodeLockCalldata(1, 1, "not-an-address")).toThrow();
  });

  it("encodes refund() calldata with the correct selector and lockId word", () => {
    const calldata = encodeRefundCalldata("255");
    expect(calldata.startsWith(REFUND_SELECTOR)).toBe(true);
    expect(calldata.slice(10)).toBe("0".repeat(62) + "ff");
  });
});

describe("etherToWeiHex", () => {
  it("converts a whole ether amount", () => {
    expect(etherToWeiHex("1")).toBe("0x" + (10n ** 18n).toString(16));
  });

  it("converts a fractional ether amount", () => {
    expect(etherToWeiHex("0.5")).toBe("0x" + (5n * 10n ** 17n).toString(16));
  });

  it("converts a zero amount", () => {
    expect(etherToWeiHex("0")).toBe("0x0");
  });
});

describe("waitForLockId", () => {
  const escrowAddress = "0x" + "a".repeat(40);
  const lockIdTopic = "0x" + "0".repeat(63) + "3";

  it("extracts the lockId from the Locked event's first indexed topic", async () => {
    const provider = {
      request: vi.fn().mockResolvedValue({
        logs: [
          {
            address: escrowAddress,
            topics: [LOCKED_EVENT_TOPIC, lockIdTopic],
          },
        ],
      }),
    };

    const lockId = await waitForLockId(provider, "0xdeadbeef", escrowAddress, {
      pollIntervalMs: 1,
    });
    expect(lockId).toBe("3");
  });

  it("times out when no receipt is ever found", async () => {
    const provider = { request: vi.fn().mockResolvedValue(null) };
    await expect(
      waitForLockId(provider, "0xdeadbeef", escrowAddress, {
        pollIntervalMs: 1,
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/Timed out/);
  });
});
