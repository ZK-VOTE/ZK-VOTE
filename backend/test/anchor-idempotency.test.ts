/**
 * Multi-anchor adapter tests (#refactor registry-settlement-voting-composition).
 * The USDC/EURC clients share one interface over injected HTTP, and callbacks
 * are deduplicated end-to-end (adapter event id + settlement state machine).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  anchorFor,
  createAnchorAdapter,
  initAnchor,
  normalizeAnchorCallback,
  sep31Send,
  sep6Deposit,
  sep6Withdraw,
} from "../src/services/anchor.js";
import {
  createInMemoryLedgerStore,
} from "../src/services/ledger.js";
import {
  createInMemorySettlementStore,
  createSettlementReconciliation,
  type LoggerPort,
} from "../src/services/settlementReconciliation.js";

const T0 = 1_700_000_000_000;

interface HttpCall {
  url: string;
  init?: RequestInit;
}

function fetchStub(calls: HttpCall[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "anchor-tx-1", status: "ok" }),
    } as Response;
  }) as unknown as typeof fetch;
}

const silentLogger: LoggerPort = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  log: () => {},
};

test("anchor adapter: both assets share getTransaction/deposit/withdraw/send", async () => {
  const calls: HttpCall[] = [];
  const adapter = createAnchorAdapter({
    urls: { USDC: "https://usdc.test", EURC: "https://eurc.test" },
    fetchImpl: fetchStub(calls),
    logger: silentLogger,
  });

  assert.deepEqual(await adapter.deposit("USDC", "GABC", "10.0000000"), { id: "anchor-tx-1", status: "ok" });
  await adapter.deposit("EURC", "GXYZ", "2.5");
  await adapter.withdraw("USDC", "GABC", "1", "bank-account");
  await adapter.send("EURC", { amount: "1", asset: "EURC" });
  await adapter.getTransaction("USDC", "anchor-tx-1");

  assert.equal(adapter.client("USDC").baseUrl, "https://usdc.test");
  assert.equal(adapter.client("EURC").baseUrl, "https://eurc.test");
  assert.equal(calls.length, 5);
  assert.ok(calls[0]?.url.startsWith("https://usdc.test/sep6/deposit?"));
  assert.ok(calls[1]?.url.startsWith("https://eurc.test/sep6/deposit?"));
  assert.ok(calls[2]?.url.startsWith("https://usdc.test/sep6/withdraw?"));
  assert.equal(calls[3]?.url, "https://eurc.test/sep31/transactions");
  assert.equal(calls[3]?.init?.method, "POST");
  assert.equal(calls[4]?.url, "https://usdc.test/sep6/transaction?id=anchor-tx-1");
});

test("anchor adapter: legacy exports remain aliases over the default adapter", async () => {
  const calls: HttpCall[] = [];
  initAnchor({
    urls: { USDC: "https://usdc.alias", EURC: "https://eurc.alias" },
    fetchImpl: fetchStub(calls),
    logger: silentLogger,
  });

  assert.equal(anchorFor("USDC"), "https://usdc.alias");
  assert.equal(anchorFor("EURC"), "https://eurc.alias");
  assert.ok((await sep6Deposit("USDC", "GABC", "3")).id === "anchor-tx-1");
  assert.ok((await sep6Withdraw("EURC", "GABC", "3", "dest")).id === "anchor-tx-1");
  assert.ok((await sep31Send("EURC", { amount: "3" })).id === "anchor-tx-1");
  assert.equal(calls.length, 3);
});

test("anchor adapter: normalization maps snake_case and hashes missing event ids", () => {
  const normalized = normalizeAnchorCallback(
    {
      event_id: "evt-1",
      external_tx_id: "tx-9",
      status: "completed",
      ledger_version: 12,
      observed_at: T0,
      gross_minor: 5_000,
      fee_breakdown: [{ code: "anchor", amountMinor: 100 }],
    },
    "USDC",
  );
  assert.equal(normalized.eventId, "evt-1");
  assert.equal(normalized.externalTxId, "tx-9");
  assert.equal(normalized.kind, "settled");
  assert.equal(normalized.ledgerVersion, 12);
  assert.equal(normalized.observedAt, T0);
  assert.equal(normalized.grossMinor, 5_000);

  const raw = { external_tx_id: "tx-no-id", status: "confirmed", observed_at: T0, ledger_version: 1 };
  const first = normalizeAnchorCallback(raw, "USDC");
  const second = normalizeAnchorCallback({ ...raw }, "USDC");
  assert.equal(first.eventId, second.eventId, "identical payloads must dedupe by hash");
  assert.ok(first.eventId.length > 0);
});

test("anchor adapter: duplicate callbacks are idempotent end-to-end", async () => {
  const store = createInMemorySettlementStore();
  const ledgerStore = createInMemoryLedgerStore();
  const reconciler = createSettlementReconciliation({
    store,
    ledgerStore,
    logger: silentLogger,
    now: () => T0,
  });
  const adapter = createAnchorAdapter({
    urls: {},
    fetchImpl: fetchStub([]),
    logger: silentLogger,
    onCallback: (event) => reconciler.handleAnchorCallback(event),
  });

  const raw = {
    event_id: "webhook-1",
    external_tx_id: "tx-e2e",
    status: "confirmed",
    ledger_version: 3,
    observed_at: T0,
    asset: "USDC",
    gross_minor: 8_000,
  };
  const first = await adapter.processCallback(adapter.normalize(raw, "USDC"));
  assert.equal(first?.state, "ANCHOR_CONFIRMED");
  assert.equal(adapter.processedEventIds().length, 1);

  // Same webhook redelivered: adapter-level short circuit (no reconciliation).
  const duplicate = await adapter.processCallback(adapter.normalize(raw, "USDC"));
  assert.equal(duplicate, null);
  assert.equal(adapter.processedEventIds().length, 1);

  // A differently-identical callback still converges via reconciliation's
  // (anchor, externalTxId) conflict rule — no duplicate state transition.
  const later = await adapter.processCallback(
    adapter.normalize({ ...raw, event_id: "webhook-2", ledger_version: 4 }, "USDC"),
  );
  assert.equal(later?.reason, "conflict_later");
  assert.equal((await store.listCallbacks("USDC:tx-e2e")).length, 2);
  assert.equal((await store.listTransitions("USDC:tx-e2e")).length, 1);

  // Settling after the confirmation is a legal forward move.
  const settled = await adapter.processCallback(
    adapter.normalize(
      { event_id: "webhook-3", external_tx_id: "tx-e2e", status: "settled", ledger_version: 5, observed_at: T0 + 10 },
      "USDC",
    ),
  );
  assert.equal(settled?.state, "SETTLED");
  assert.equal((await ledgerStore.listGroups()).length, 1);
});
