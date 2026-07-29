import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.RELAYER_TEST_MODE = "true";

const databaseService =
  await import("../src/services/db.js");

const tempDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "zkvote-db-concurrency-"),
);

const databasePath = path.join(
  tempDirectory,
  "concurrent-access.db",
);

test.after(() => {
  databaseService.closeDb();

  fs.rmSync(tempDirectory, {
    recursive: true,
    force: true,
  });
});

test("db metadata remains consistent under concurrent access", async () => {
  const database =
    databaseService.initDb(databasePath);

  await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      Promise.resolve().then(() => {
        databaseService.setMetadata(
          `concurrent:${index}`,
          { index },
        );
      }),
    ),
  );

  const reads = await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      Promise.resolve().then(() =>
        databaseService.getMetadata(
          `concurrent:${index}`,
        ),
      ),
    ),
  );

  for (let index = 0; index < 25; index += 1) {
    assert.deepEqual(reads[index], { index });
  }

  const result = database
    .prepare(
      `SELECT COUNT(*) AS total
       FROM metadata
       WHERE key LIKE 'concurrent:%'`,
    )
    .get();

  assert.equal(result.total, 25);
});
