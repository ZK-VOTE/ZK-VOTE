import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(tmpdir(), "zkvote-archival-test-"));

test.after(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

test("Historical event archival flow, eligibility rules, compressed export, registry, and retrieval", async () => {
  const { initDb } = await import("../src/services/db.ts");
  const {
    runArchivalJob,
    getArchiveIndex,
    readArchivedEvents,
  } = await import("../src/services/archival.ts");

  const dbPath = path.join(TEST_DIR, "archival.db");
  const archiveDir = path.join(TEST_DIR, "archive_out");
  fs.mkdirSync(archiveDir, { recursive: true });

  const db = initDb(dbPath);

  // Set up DAO 1 partition table
  db.exec(`
    INSERT INTO partition_registry (dao_id) VALUES (1);
    CREATE TABLE IF NOT EXISTS events_1 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      data TEXT,
      ledger INTEGER,
      tx_hash TEXT,
      timestamp TEXT NOT NULL,
      verified INTEGER DEFAULT 1
    );
  `);

  const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(); // 100 days old
  const recentDate = new Date().toISOString();

  // 1. Closed proposal events (eligible for archival)
  db.prepare("INSERT INTO events_1 (type, data, ledger, tx_hash, timestamp) VALUES (?, ?, ?, ?, ?)").run(
    "proposal_created",
    JSON.stringify({ proposalId: 10, title: "Ended Election" }),
    100,
    "tx10",
    oldDate
  );
  db.prepare("INSERT INTO events_1 (type, data, ledger, tx_hash, timestamp) VALUES (?, ?, ?, ?, ?)").run(
    "vote_cast",
    JSON.stringify({ proposalId: 10, vote: 1 }),
    101,
    "tx11",
    oldDate
  );
  db.prepare("INSERT INTO events_1 (type, data, ledger, tx_hash, timestamp) VALUES (?, ?, ?, ?, ?)").run(
    "proposal_closed",
    JSON.stringify({ proposalId: 10 }),
    102,
    "tx12",
    oldDate
  );

  // 2. Active proposal events (MUST NOT be archived even if old)
  db.prepare("INSERT INTO events_1 (type, data, ledger, tx_hash, timestamp) VALUES (?, ?, ?, ?, ?)").run(
    "proposal_created",
    JSON.stringify({ proposalId: 20, title: "Active Election" }),
    200,
    "tx20",
    oldDate
  );
  db.prepare("INSERT INTO events_1 (type, data, ledger, tx_hash, timestamp) VALUES (?, ?, ?, ?, ?)").run(
    "vote_cast",
    JSON.stringify({ proposalId: 20, vote: 1 }),
    201,
    "tx21",
    oldDate
  );

  // 3. Run archival job with 90 day threshold
  const result = await runArchivalJob({
    ageDays: 90,
    archiveDir,
    batchSize: 50,
  });

  assert.equal(result.success, true);
  assert.ok(result.archivedEventsCount >= 3); // 3 events for proposal 10
  assert.equal(result.archivesCreatedCount, 1);

  // 4. Verify remaining events in DB (active proposal 20 events must still exist)
  const remaining = db.prepare("SELECT * FROM events_1").all();
  assert.equal(remaining.length, 2);
  const remainingPropIds = remaining.map((r) => JSON.parse(r.data).proposalId);
  assert.ok(remainingPropIds.every((id) => id === 20));

  // 5. Verify archive registry index
  const index = getArchiveIndex(1);
  assert.equal(index.length, 1);
  assert.equal(index[0].dao_id, 1);
  assert.equal(index[0].event_count, 3);
  assert.ok(index[0].checksum.length > 0);

  // 6. Test retrieval and decompression of archived events
  const archivedEvents = readArchivedEvents(index[0].archive_id);
  assert.equal(archivedEvents.length, 3);
  assert.equal(archivedEvents[0].type, "proposal_created");

  db.close();
});
