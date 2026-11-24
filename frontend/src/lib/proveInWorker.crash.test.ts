import { describe, it, expect, vi, afterEach } from "vitest";
import {
  classifyWorkerCrash,
  proveInWorker,
  ProofWorkerError,
} from "./proveInWorker";

describe("classifyWorkerCrash (#756)", () => {
  it.each([
    ["RangeError: WebAssembly.Memory(): could not allocate memory", "oom"],
    ["Out of memory", "oom"],
    ["memory access out of bounds", "oom"],
    ["Invalid witness length", "exception"],
    ["", "killed"],
    [undefined, "killed"],
  ])("%s → %s", (message, kind) => {
    expect(classifyWorkerCrash(message as string | undefined)).toBe(kind);
  });
});

class SilentWorker {
  static last: SilentWorker | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  constructor() {
    SilentWorker.last = this;
  }
  postMessage() {}
  terminate() {
    this.terminated = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  SilentWorker.last = null;
});

describe("proveInWorker death detection (#756)", () => {
  it("rejects as stalled instead of spinning forever", async () => {
    vi.stubGlobal("Worker", SilentWorker);
    const err = await proveInWorker({}, "w", "z", 20).catch((e) => e);
    expect(err).toBeInstanceOf(ProofWorkerError);
    expect(err.kind).toBe("stalled");
    expect(SilentWorker.last?.terminated).toBe(true);
  });

  it("classifies a worker error event", async () => {
    vi.stubGlobal("Worker", SilentWorker);
    const pending = proveInWorker({}, "w", "z", 10_000).catch((e) => e);
    SilentWorker.last!.onerror!({ message: "Out of memory" } as ErrorEvent);
    const err = await pending;
    expect(err.kind).toBe("oom");
  });
});
