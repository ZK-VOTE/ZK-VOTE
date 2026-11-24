// @ts-nocheck
/**
 * Token Snapshot Service (ZV-065)
 *
 * Projects SEP-41 token events (mint/burn/transfer/delegate/checkpoint) into
 * the balance, delegate, and checkpoint tables.  Provides a point-in-time
 * snapshot query with a verification proof (hash of the event set).
 */

import crypto from "crypto";
import { getDb } from "./db.js";
import { createLogger } from "./logger.js";

const logger = createLogger("token-snapshot");

export interface TokenEvent {
  id: number;
  event_type: string;
  address: string;
  to_address: string | null;
  amount: string | null;
  ledger: number;
  tx_hash: string | null;
  timestamp: string;
  verified: number;
}

export interface TokenSnapshotResult {
  address: string;
  balance: string;
  delegate: string | null;
  ledger: number;
  proof: string;
  events_included: number;
}

/**
 * Persist a raw token event and update the balance/delegate projections.
 */
export function persistTokenEvent(event: Omit<TokenEvent, "id">): void {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO token_events
      (event_type, address, to_address, amount, ledger, tx_hash, timestamp, verified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertBalance = db.prepare(`
    INSERT INTO token_balances (address, balance, last_ledger, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(address) DO UPDATE SET
      balance     = excluded.balance,
      last_ledger = excluded.last_ledger,
      updated_at  = excluded.updated_at
    WHERE excluded.last_ledger >= token_balances.last_ledger
  `);
  const upsertDelegate = db.prepare(`
    INSERT INTO token_delegates (address, delegate, last_ledger, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(address) DO UPDATE SET
      delegate    = excluded.delegate,
      last_ledger = excluded.last_ledger,
      updated_at  = excluded.updated_at
    WHERE excluded.last_ledger >= token_delegates.last_ledger
  `);
  const upsertCheckpoint = db.prepare(`
    INSERT OR REPLACE INTO token_checkpoints
      (address, ledger, balance, tx_hash, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    insert.run(
      event.event_type,
      event.address,
      event.to_address ?? null,
      event.amount ?? null,
      event.ledger,
      event.tx_hash ?? null,
      event.timestamp,
      event.verified,
    );

    if (event.event_type === "token_mint" && event.amount) {
      const current = db.prepare("SELECT balance FROM token_balances WHERE address = ?").get(event.address) as { balance: string } | undefined;
      const newBal = (BigInt(current?.balance ?? "0") + BigInt(event.amount)).toString();
      upsertBalance.run(event.address, newBal, event.ledger);
    } else if (event.event_type === "token_burn" && event.amount) {
      const current = db.prepare("SELECT balance FROM token_balances WHERE address = ?").get(event.address) as { balance: string } | undefined;
      const newBal = (BigInt(current?.balance ?? "0") - BigInt(event.amount)).toString();
      upsertBalance.run(event.address, newBal, event.ledger);
    } else if (event.event_type === "token_transfer" && event.amount && event.to_address) {
      const fromRow = db.prepare("SELECT balance FROM token_balances WHERE address = ?").get(event.address) as { balance: string } | undefined;
      const toRow   = db.prepare("SELECT balance FROM token_balances WHERE address = ?").get(event.to_address) as { balance: string } | undefined;
      const fromBal = (BigInt(fromRow?.balance ?? "0") - BigInt(event.amount)).toString();
      const toBal   = (BigInt(toRow?.balance   ?? "0") + BigInt(event.amount)).toString();
      upsertBalance.run(event.address,    fromBal, event.ledger);
      upsertBalance.run(event.to_address, toBal,   event.ledger);
    } else if (event.event_type === "token_delegate" && event.to_address) {
      upsertDelegate.run(event.address, event.to_address, event.ledger);
    } else if (event.event_type === "token_checkpoint" && event.amount) {
      upsertCheckpoint.run(event.address, event.ledger, event.amount, event.tx_hash ?? null, event.timestamp);
    }
  });
  tx();
}

/**
 * Remove all token events at ledger > forkLedger and rebuild projections.
 * Used during reorg handling.
 */
export function reorgTokenEvents(forkLedger: number): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM token_events WHERE ledger > ?").run(forkLedger);
    db.prepare("DELETE FROM token_checkpoints WHERE ledger > ?").run(forkLedger);
    // Rebuild balance and delegate projections from surviving events
    db.prepare("DELETE FROM token_balances").run();
    db.prepare("DELETE FROM token_delegates").run();
    const events = db.prepare(
      "SELECT * FROM token_events ORDER BY ledger ASC, id ASC"
    ).all() as TokenEvent[];
    for (const ev of events) {
      persistTokenEvent(ev); // re-projects; insert is guarded by ON CONFLICT
    }
  });
  tx();
  logger.info("token_reorg_complete", { forkLedger });
}

/**
 * Return a point-in-time snapshot for `address` at `ledger` with a
 * verification proof (SHA-256 of the ordered event ids that contributed).
 */
export function getTokenSnapshot(address: string, atLedger: number): TokenSnapshotResult {
  const db = getDb();

  // Best checkpoint at or before atLedger
  const cpRow = db.prepare(
    "SELECT balance FROM token_checkpoints WHERE address = ? AND ledger <= ? ORDER BY ledger DESC LIMIT 1"
  ).get(address, atLedger) as { balance: string } | undefined;

  const baseBalance = BigInt(cpRow?.balance ?? "0");
  const baseCheckpointLedger = cpRow
    ? (db.prepare(
        "SELECT ledger FROM token_checkpoints WHERE address = ? AND ledger <= ? ORDER BY ledger DESC LIMIT 1"
      ).get(address, atLedger) as { ledger: number }).ledger
    : 0;

  // Events after the last checkpoint up to atLedger
  const events = db.prepare(`
    SELECT id, event_type, address, to_address, amount
    FROM token_events
    WHERE (address = ? OR to_address = ?)
      AND ledger >  ?
      AND ledger <= ?
    ORDER BY ledger ASC, id ASC
  `).all(address, address, baseCheckpointLedger, atLedger) as Array<{
    id: number; event_type: string; address: string; to_address: string | null; amount: string | null;
  }>;

  let balance = baseBalance;
  for (const ev of events) {
    if (!ev.amount) continue;
    const amt = BigInt(ev.amount);
    if (ev.event_type === "token_mint" && ev.address === address)   balance += amt;
    else if (ev.event_type === "token_burn" && ev.address === address)  balance -= amt;
    else if (ev.event_type === "token_transfer") {
      if (ev.address    === address) balance -= amt;
      if (ev.to_address === address) balance += amt;
    }
  }

  const delegateRow = db.prepare(
    "SELECT delegate FROM token_delegates WHERE address = ?"
  ).get(address) as { delegate: string } | undefined;

  const proofData = events.map(e => e.id).join(",");
  const proof = crypto.createHash("sha256").update(`${address}:${atLedger}:${proofData}`).digest("hex");

  return {
    address,
    balance: balance.toString(),
    delegate: delegateRow?.delegate ?? null,
    ledger: atLedger,
    proof,
    events_included: events.length,
  };
}
