import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

// Isolation: no BACKUP_ENCRYPTION_KEY, no key file, auto-init disabled.
process.env.BACKUP_ENCRYPTION_KEY = "";
process.env.BACKUP_ENCRYPTION_AUTO_INIT = "false";

const TEST_DIR = fs.mkdtempSync(path.join(tmpdir(), "zkvote-nokey-test-"));

test.after(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

test("createBackup refuses to write a plaintext snapshot when encryption is requested without a key", async () => {
  const { initDb, getDb } = await import("../src/services/db.ts");
  const { createBackup } = await import("../src/services/backup.ts");

  const dbPath = path.join(TEST_DIR, "nokey-source.db");
  const backupDir = path.join(TEST_DIR, "backups");
  fs.mkdirSync(backupDir, { recursive: true });

  initDb(dbPath);

  const res = await createBackup({
    destinationDir: backupDir,
    backupName: "zkvote-backup-nokey.db",
    encrypted: true,
  });

  assert.equal(res.success, false);
  assert.equal(res.encrypted, true);
  assert.match(res.error, /no backup encryption key is configured/i);

  // No backup artifact was left behind.
  const files = fs.readdirSync(backupDir).filter((f) => f !== ".plain");
  assert.equal(files.length, 0);

  getDb().close();
});

test("verifyBackup reports an explicit error when no key is available for an encrypted snapshot", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { generateBackupKey, encryptBackupFile } =
    await import("../src/services/backupCrypto.ts");
  const { verifyBackup } = await import("../src/services/backup.ts");

  const sourcePath = path.join(TEST_DIR, "orphan-source.db");
  const encPath = path.join(TEST_DIR, "orphan.enc.db");

  const db = new Database(sourcePath);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  db.prepare("INSERT INTO t (id) VALUES (?)").run(1);
  db.close();

  // Encrypt with a key that is deliberately NOT configured in this process.
  await encryptBackupFile(sourcePath, encPath, generateBackupKey());

  const result = await verifyBackup(encPath);
  assert.equal(result.valid, false);
  assert.equal(result.encrypted, true);
  assert.ok(result.keyId);
  assert.match(result.error, /[Nn]o backup encryption key/);
});
