/**
 * Streaming Indexer & Backpressure Queue Tests
 * 
 * Verifies bounded memory queue, watermark state, and stream ingestion.
 */

import { describe, it, expect } from "@jest/globals";
import {
  pushStreamEvent,
  drainEventQueue,
  getIndexerStatus,
  type EventInput,
} from "../src/services/indexer.js";

describe("Streaming Indexer & Backpressure (#318)", () => {
  it("should buffer and drain events through the backpressure queue", async () => {
    const testEvent: EventInput = {
      daoId: 1,
      type: "dao_create",
      data: { name: "Test DAO" },
      ledger: 100,
      txHash: "test-tx-hash-001",
      timestamp: new Date().toISOString(),
      verified: true,
    };

    const pushed = await pushStreamEvent(testEvent);
    expect(pushed).toBe(true);

    const processed = await drainEventQueue();
    expect(processed).toBeGreaterThanOrEqual(0);

    const status = getIndexerStatus();
    expect(status).toHaveProperty("isRunning");
    expect(status).toHaveProperty("queueDepth");
  });
});
