/**
 * End-to-end tracing and deterministic replay of the relay pipeline (#321)
 *
 * Acceptance: one poll cycle exports a connected span tree, a replay fixture
 * reproduces the state the cycle reached, and neither spans nor fixtures leak
 * anonymity-relevant material.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  InMemorySpanExporter,
  clearSpanExporters,
  formatTraceparent,
  getActiveSpanContext,
  parseTraceparent,
  redactSpanAttributes,
  registerSpanExporter,
  withSpan,
} from "../src/services/tracing.js";
import {
  RelayReplayRecorder,
  canonicalJson,
  loadFixture,
  replayFixture,
  writeFixture,
} from "../src/services/replay.js";

const VALID_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const VALID_SPAN_ID = "00f067aa0ba902b7";

// ============================================
// W3C TRACE CONTEXT
// ============================================

test("traceparent parses, rejects invalid forms, and round-trips", () => {
  const parsed = parseTraceparent(`00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01`);
  assert.deepEqual(parsed, {
    traceId: VALID_TRACE_ID,
    spanId: VALID_SPAN_ID,
    traceFlags: "01",
  });
  assert.equal(
    formatTraceparent(parsed),
    `00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01`,
  );

  assert.equal(parseTraceparent(undefined), null);
  assert.equal(parseTraceparent("not-a-traceparent"), null);
  // All-zero IDs are explicitly invalid per the spec.
  assert.equal(parseTraceparent(`00-${"0".repeat(32)}-${VALID_SPAN_ID}-01`), null);
  assert.equal(parseTraceparent(`00-${VALID_TRACE_ID}-${"0".repeat(16)}-01`), null);
});

// ============================================
// SPAN EXPORT
// ============================================

test("one poll cycle exports a connected poll -> db -> rpc span tree", async (t) => {
  const exporter = new InMemorySpanExporter();
  t.after(clearSpanExporters);
  registerSpanExporter(exporter);

  // Mirrors the indexer's real shape: the cycle span is the root, the database
  // write hangs off it, and the RPC call hangs off the write — all without any
  // of them passing a context argument.
  await withSpan("indexer.poll_cycle", { start_ledger: 41 }, async () => {
    await withSpan("indexer.db.persist_events", { component: "database" }, async () => {
      await withSpan("relay.rpc.call", { component: "stellar" }, () => ({
        sequence: 42,
      }));
    });
  });

  const root = exporter.find("indexer.poll_cycle");
  const dbSpan = exporter.find("indexer.db.persist_events");
  const rpcSpan = exporter.find("relay.rpc.call");

  assert.equal(exporter.spans.length, 3);
  assert.equal(exporter.byTrace(root.traceId).length, 3, "one trace covers the cycle");
  assert.equal(root.parentSpanId, undefined);
  assert.equal(dbSpan.parentSpanId, root.spanId, "db write is parented by the cycle");
  assert.equal(rpcSpan.parentSpanId, dbSpan.spanId, "rpc call is parented by the write");
  assert.ok(
    exporter.spans.every((span) =>
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(span.traceparent),
    ),
    "every exported span carries a well-formed traceparent",
  );
  assert.ok(exporter.spans.every((span) => span.status === "ok"));
  // Spans are exported on completion, so children precede their parent.
  assert.equal(exporter.spans.at(-1).name, "indexer.poll_cycle");
});

test("an inbound trace ID is continued into the pipeline", async (t) => {
  const exporter = new InMemorySpanExporter();
  t.after(clearSpanExporters);
  registerSpanExporter(exporter);

  const inbound = parseTraceparent(`00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01`);
  await withSpan("relay.rpc.call", { component: "stellar" }, () => undefined, {
    parent: inbound,
  });

  const span = exporter.find("relay.rpc.call");
  assert.equal(span.traceId, VALID_TRACE_ID, "the inbound trace is joined, not restarted");
  assert.equal(span.parentSpanId, VALID_SPAN_ID);
  assert.notEqual(span.spanId, VALID_SPAN_ID, "this hop gets its own span ID");
});

test("a failing step is exported as an error span and the error still propagates", async (t) => {
  const exporter = new InMemorySpanExporter();
  t.after(clearSpanExporters);
  registerSpanExporter(exporter);

  await assert.rejects(
    withSpan("relay.rpc.call", { component: "stellar" }, () => {
      throw new Error("rpc unreachable");
    }),
    /rpc unreachable/,
  );

  const span = exporter.find("relay.rpc.call");
  assert.equal(span.status, "error");
  assert.equal(span.error, "rpc unreachable");
});

test("a throwing exporter cannot break the pipeline", async (t) => {
  t.after(clearSpanExporters);
  registerSpanExporter({
    export: () => {
      throw new Error("collector down");
    },
  });

  const result = await withSpan("indexer.poll_cycle", {}, () => "completed");
  assert.equal(result, "completed", "telemetry failure must not fail the cycle");
});

test("the ambient span context is available to nested code and cleared after", async (t) => {
  t.after(clearSpanExporters);

  assert.equal(getActiveSpanContext(), null);
  const seen = await withSpan("indexer.poll_cycle", {}, async () =>
    getActiveSpanContext(),
  );
  assert.match(seen.traceId, /^[0-9a-f]{32}$/);
  assert.equal(getActiveSpanContext(), null, "context does not leak past the span");
});

// ============================================
// REDACTION
// ============================================

test("span attributes redact anonymity-relevant values", () => {
  const nullifier =
    "0x2a4f8b1c9d3e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b";
  const redacted = redactSpanAttributes({
    component: "stellar",
    start_ledger: 41,
    contract: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    nullifier,
    "vote.proof": "abc",
    merkle_root: "deadbeef",
    ip: "203.0.113.7",
  });

  assert.equal(redacted.component, "stellar", "benign attributes survive intact");
  assert.equal(redacted.start_ledger, 41);
  assert.match(redacted.nullifier, /^sha256:[0-9a-f]{16}$/);
  assert.match(redacted["vote.proof"], /^sha256:[0-9a-f]{16}$/);
  assert.match(redacted.merkle_root, /^sha256:[0-9a-f]{16}$/);
  assert.match(redacted.ip, /^sha256:[0-9a-f]{16}$/);
  // A Stellar address is digested even under an innocuous key.
  assert.match(redacted.contract, /^sha256:[0-9a-f]{16}$/);

  const serialised = JSON.stringify(redacted);
  assert.ok(!serialised.includes(nullifier), "no raw nullifier reaches telemetry");
  assert.ok(!serialised.includes("203.0.113.7"));
});

test("exported spans carry redacted attributes, not raw ones", async (t) => {
  const exporter = new InMemorySpanExporter();
  t.after(clearSpanExporters);
  registerSpanExporter(exporter);

  await withSpan(
    "relay.vote.submit",
    { nullifier: "cafebabe", component: "voting" },
    () => undefined,
  );

  const span = exporter.find("relay.vote.submit");
  assert.equal(span.attributes.component, "voting");
  assert.notEqual(span.attributes.nullifier, "cafebabe");
  assert.match(span.attributes.nullifier, /^sha256:/);
});

// ============================================
// DETERMINISTIC REPLAY
// ============================================

/** Build a recorder standing in for one indexer poll cycle. */
function recordPollCycle() {
  const recorder = new RelayReplayRecorder(VALID_TRACE_ID, "indexer.poll_cycle");

  recorder.record("rpc", "rpc.getLatestLedger", { sequence: 120 });
  recorder.record("db", "db.addEvent", {
    daoId: 7,
    type: "proposal_created",
    ledger: 118,
    txHash: "tx-a",
    timestamp: "2026-08-01T00:00:00.000Z",
  });
  recorder.record("db", "db.addEvent", {
    daoId: 7,
    type: "vote_cast",
    ledger: 119,
    txHash: "tx-b",
    timestamp: "2026-08-01T00:00:01.000Z",
    nullifier: "0xdeadbeefdeadbeefdeadbeefdeadbeef",
  });
  recorder.record("db", "db.setWatermark", { ledger: 120 });

  return recorder;
}

test("a replay fixture reproduces the state its poll cycle reached", () => {
  const fixture = recordPollCycle().toFixture();

  assert.equal(fixture.version, 1);
  assert.equal(fixture.traceId, VALID_TRACE_ID);
  assert.equal(fixture.interactions.length, 4);
  assert.deepEqual(fixture.finalState.watermarkLedger, 120);
  assert.equal(fixture.finalState.latestLedger, 120);
  assert.equal(fixture.finalState.events.length, 2);

  const replayed = replayFixture(fixture);

  assert.equal(replayed.matches, true, "replay must reach the recorded digest");
  assert.equal(replayed.digest, fixture.digest);
  assert.deepEqual(replayed.state, fixture.finalState);
});

test("replay is a pure function of the fixture — repeated runs agree", () => {
  const fixture = recordPollCycle().toFixture();

  const first = replayFixture(fixture);
  const second = replayFixture(fixture);

  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.state, second.state);
});

test("replay mirrors the indexer's UNIQUE constraint on duplicate events", () => {
  const recorder = new RelayReplayRecorder(VALID_TRACE_ID, "indexer.poll_cycle");
  const event = {
    daoId: 3,
    type: "vote_cast",
    ledger: 9,
    txHash: "tx-dup",
    timestamp: "2026-08-01T00:00:00.000Z",
  };
  recorder.record("db", "db.addEvent", event);
  recorder.record("db", "db.addEvent", event);

  const fixture = recorder.toFixture();
  assert.equal(fixture.finalState.events.length, 1, "a re-indexed ledger is a no-op");
  assert.equal(replayFixture(fixture).matches, true);
});

test("a tampered fixture fails to reproduce its digest", () => {
  const fixture = recordPollCycle().toFixture();
  const tampered = {
    ...fixture,
    interactions: fixture.interactions.map((interaction) =>
      interaction.label === "db.setWatermark"
        ? { ...interaction, payload: { ledger: 999 } }
        : interaction,
    ),
  };

  const replayed = replayFixture(tampered);
  assert.equal(replayed.matches, false, "an edited interaction must not verify");
  assert.equal(replayed.state.watermarkLedger, 999);
});

test("fixtures round-trip through disk and still replay", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zkvote-replay-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fixture = recordPollCycle().toFixture();
  const filePath = path.join(dir, "poll-cycle.json");
  writeFixture(filePath, fixture);

  const loaded = loadFixture(filePath);
  assert.deepEqual(loaded, fixture);
  assert.equal(replayFixture(loaded).matches, true);
});

test("loadFixture refuses a fixture from an unsupported version", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zkvote-replay-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const filePath = path.join(dir, "future.json");
  fs.writeFileSync(filePath, JSON.stringify({ version: 99, interactions: [] }));

  assert.throws(() => loadFixture(filePath), /Unsupported replay fixture version 99/);
});

test("fixtures never persist voter-linkable material", () => {
  const fixture = recordPollCycle().toFixture();
  const serialised = JSON.stringify(fixture);

  assert.ok(
    !serialised.includes("0xdeadbeefdeadbeefdeadbeefdeadbeef"),
    "the recorded nullifier must not survive into the fixture",
  );

  const voteInteraction = fixture.interactions.find(
    (interaction) => interaction.payload.type === "vote_cast",
  );
  assert.match(voteInteraction.payload.nullifier, /^sha256:[0-9a-f]{16}$/);
  // Fields the reducer actually reads are preserved verbatim.
  assert.equal(voteInteraction.payload.ledger, 119);
  assert.equal(voteInteraction.payload.txHash, "tx-b");
});

test("canonical JSON orders keys so digests ignore insertion order", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 4, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 4 }, b: 1 }),
  );
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});
