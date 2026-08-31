/**
 * Structured Logging + Correlation ID Tests (#362)
 *
 * Verifies that:
 *  - every emitted log line is structured JSON carrying the request's
 *    correlation ID (`ctx`) and trace ID (`traceId`),
 *  - correlation IDs flow into downstream route/service log calls via
 *    AsyncLocalStorage propagation,
 *  - PII redaction applies to emitted log entries,
 *  - trace sampling can drop/keep whole requests deterministically.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import express from "express";
import request from "supertest";

import {
  requestLogger,
  parseIncomingTraceId,
} from "../src/middleware/logging.js";
import {
  log,
  setLogSampleRate,
  getLogSampleRate,
} from "../src/services/logger.js";

const VALID_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const VALID_TRACEPARENT = `00-${VALID_TRACE_ID}-00f067aa0ba902b7-01`;
const STELLAR_ADDRESS = "G" + "A".repeat(55);

function captureConsole() {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  return {
    get entries() {
      return lines.map((line) => JSON.parse(line));
    },
    restore() {
      console.log = original;
    },
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestLogger);
  app.get("/ping", (req, res) => {
    // Simulate a downstream service call: its log line must inherit the
    // request's correlation IDs automatically.
    log("info", "service_processing", { action: "ping", label: "svc" });
    res.json({ ctx: req.ctx, traceId: req.traceId });
  });
  app.post("/vote", (req, res) => {
    log("info", "vote_received", {
      proposalId: req.body.proposalId,
      proof: "secret-proof-123",
      authToken: "jwt-secret-abc",
      voter: STELLAR_ADDRESS,
    });
    res.json({ ok: true, ctx: req.ctx, traceId: req.traceId });
  });
  return app;
}

describe("structured logging: correlation IDs everywhere", () => {
  it("emits request_start/request_end and downstream logs all with the same ctx + traceId", async () => {
    const capture = captureConsole();
    try {
      const res = await request(buildApp())
        .get("/ping")
        .set("traceparent", VALID_TRACEPARENT);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.traceId, VALID_TRACE_ID);
      assert.ok(res.headers.traceparent.startsWith(`00-${VALID_TRACE_ID}-`));

      await new Promise((resolve) => setTimeout(resolve, 25));

      const entries = capture.entries;
      const start = entries.find((e) => e.event === "request_start");
      const end = entries.find((e) => e.event === "request_end");
      const svc = entries.find((e) => e.event === "service_processing");

      assert.ok(start, "request_start should be logged");
      assert.ok(end, "request_end should be logged");
      assert.ok(svc, "downstream service log should be emitted");

      for (const entry of [start, end, svc]) {
        assert.ok(entry.ctx, "log entry must carry correlation ID");
        assert.strictEqual(entry.traceId, VALID_TRACE_ID);
        assert.strictEqual(entry.ctx, res.body.ctx);
      }
      assert.strictEqual(end.status, 200);
      assert.strictEqual(svc.label, "svc");
    } finally {
      capture.restore();
    }
  });

  it("starts a new trace when no traceparent is present and correlates all logs", async () => {
    const capture = captureConsole();
    try {
      const res = await request(buildApp()).get("/ping");

      assert.strictEqual(res.status, 200);
      assert.match(res.body.traceId, /^[0-9a-f]{32}$/);

      await new Promise((resolve) => setTimeout(resolve, 25));

      const entries = capture.entries;
      const svc = entries.find((e) => e.event === "service_processing");
      const start = entries.find((e) => e.event === "request_start");

      assert.ok(svc);
      assert.strictEqual(svc.traceId, res.body.traceId);
      assert.strictEqual(svc.ctx, res.body.ctx);
      assert.strictEqual(start.traceId, res.body.traceId);
    } finally {
      capture.restore();
    }
  });

  it("redacts sensitive fields and stellar addresses in emitted logs", async () => {
    const capture = captureConsole();
    try {
      const res = await request(buildApp())
        .post("/vote")
        .send({ proposalId: "p1", proof: "ignored" });

      assert.strictEqual(res.status, 200);

      const entries = capture.entries;
      const vote = entries.find((e) => e.event === "vote_received");

      assert.ok(vote);
      assert.strictEqual(vote.proof, "[REDACTED]");
      assert.strictEqual(vote.authToken, "[REDACTED]");
      assert.strictEqual(vote.voter, "GAAA...AAAA");
      assert.strictEqual(vote.proposalId, "p1");
    } finally {
      capture.restore();
    }
  });
});

describe("trace sampling", () => {
  it("drops request logs when sample rate is 0 and restores when set back to 1", async () => {
    const before = getLogSampleRate();
    try {
      setLogSampleRate(0);
      const dropped = captureConsole();
      try {
        const res = await request(buildApp()).get("/ping");
        assert.strictEqual(res.status, 200);
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.strictEqual(dropped.entries.length, 0);
      } finally {
        dropped.restore();
      }

      setLogSampleRate(1);
      const kept = captureConsole();
      try {
        await request(buildApp()).get("/ping");
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.ok(kept.entries.length >= 2);
      } finally {
        kept.restore();
      }
    } finally {
      setLogSampleRate(before);
    }
  });
});

describe("parseIncomingTraceId", () => {
  it("extracts the trace ID from a well-formed traceparent header", () => {
    assert.strictEqual(parseIncomingTraceId(VALID_TRACEPARENT), VALID_TRACE_ID);
  });

  it("returns undefined for a missing header", () => {
    assert.strictEqual(parseIncomingTraceId(undefined), undefined);
  });

  it("returns undefined for a malformed header", () => {
    assert.strictEqual(parseIncomingTraceId("not-a-traceparent"), undefined);
  });
});
