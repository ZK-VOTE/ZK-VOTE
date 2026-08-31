import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

// Configured before any src module is (dynamically) imported so config.ts sees it.
process.env.BACKUP_ENCRYPTION_KEY =
  "s3cR3t-b4ckup-k3y-aA11Bb22Cc33Dd44Ee55Ff66Gg77Hh88==";

const TEST_DIR = fs.mkdtempSync(path.join(tmpdir(), "zkvote-enc-backup-test-"));

test.after(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

test("encryptBackupFile round-trip: encryption is real, decryption restores data", async () => {
  const { default: Database } = await import("better-sqlite3");
  const {
    generateBackupKey,
    deriveKeyId,
    probeBackupFile,
    encryptBackupFile,
    decryptBackupFile,
    BackupCryptoError,
  } = await import("../src/services/backupCrypto.ts");

  const sourcePath = path.join(TEST_DIR, "roundtrip-source.db");
  const encPath = path.join(TEST_DIR, "roundtrip.enc.db");
  const decPath = path.join(TEST_DIR, "roundtrip-dec.db");

  const db = new Database(sourcePath);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  db.prepare("INSERT INTO t (name) VALUES (?)").run("encrypted-payload-marker");
  db.close();

  const key = generateBackupKey();
  await encryptBackupFile(sourcePath, encPath, key);

  const info = probeBackupFile(encPath);
  assert.equal(info.encrypted, true);
  assert.equal(info.keyId, deriveKeyId(key));
  assert.equal(info.algorithm, "aes-256-gcm");

  // The on-disk artifact must not be a plaintext SQLite file nor contain the payload.
  const raw = fs.readFileSync(encPath);
  assert.ok(raw.subarray(0, 16).toString("latin1") !== "SQLite format 3\0");
  assert.ok(!raw.includes(Buffer.from("encrypted-payload-marker")));

  await decryptBackupFile(encPath, decPath, key);

  const dec = new Database(decPath, { readonly: true });
  const integrity = dec.prepare("PRAGMA integrity_check").get();
  assert.equal(Object.values(integrity)[0], "ok");
  const row = dec.prepare("SELECT name FROM t WHERE id = 1").get();
  assert.equal(row.name, "encrypted-payload-marker");
  dec.close();

  // Wrong key must fail loudly.
  const wrongKey = generateBackupKey();
  await assert.rejects(
    decryptBackupFile(encPath, path.join(TEST_DIR, "wrong.db"), wrongKey),
    (err) => err instanceof BackupCryptoError && err.code === "WRONG_KEY",
  );
});

test("createBackup(encrypted) -> verifyBackup -> restoreFromBackup full flow", async () => {
  const { initDb, getDb } = await import("../src/services/db.ts");
  const {
    createBackup,
    verifyBackup,
    restoreFromBackup,
    verifyRestore,
    isEncryptedBackup,
  } = await import("../src/services/backup.ts");
  const { probeBackupFile } = await import("../src/services/backupCrypto.ts");

  const dbPath = path.join(TEST_DIR, "enc-source.db");
  const backupDir = path.join(TEST_DIR, "enc-backups");
  fs.mkdirSync(backupDir, { recursive: true });

  const db = initDb(dbPath);
  db.prepare("INSERT INTO daos (id, name, creator) VALUES (?, ?, ?)").run(
    1,
    "Encrypted DAO",
    "G12345",
  );

  const backupRes = await createBackup({
    destinationDir: backupDir,
    backupName: "zkvote-backup-enc-test-1.db",
    encrypted: true,
  });

  assert.equal(backupRes.success, true);
  assert.equal(backupRes.encrypted, true);
  assert.ok(backupRes.keyId);
  assert.ok(backupRes.fileName?.endsWith(".enc.db"));
  assert.ok(fs.existsSync(backupRes.filePath));

  const info = probeBackupFile(backupRes.filePath);
  assert.equal(info.encrypted, true);

  const raw = fs.readFileSync(backupRes.filePath);
  assert.ok(!raw.includes(Buffer.from("Encrypted DAO")));

  // verifyBackup decrypts and runs an integrity check.
  const verifyRes = await verifyBackup(backupRes.filePath);
  assert.equal(verifyRes.valid, true);
  assert.equal(verifyRes.encrypted, true);
  assert.equal(verifyRes.integrityResult, "ok");

  // Restore (decrypt → PITR) into a fresh path and confirm content survives.
  const restoredPath = path.join(TEST_DIR, "enc-restored.db");
  const restoreRes = await restoreFromBackup(backupRes.filePath, restoredPath);
  assert.equal(restoreRes.success, true);
  assert.ok(fs.existsSync(restoredPath));

  const { default: Database } = await import("better-sqlite3");
  const restored = new Database(restoredPath, { readonly: true });
  const daoRow = restored.prepare("SELECT * FROM daos WHERE id = 1").get();
  assert.ok(daoRow);
  assert.equal(daoRow.name, "Encrypted DAO");
  restored.close();

  // Dry-run restore drill (no production DB touched).
  const drill = await verifyRestore(backupRes.filePath);
  assert.equal(drill.success, true);
  assert.match(drill.message, /integrity ok/);

  assert.equal(isEncryptedBackup(backupRes.filePath), true);

  getDb().close();
});

test("pruneOldBackups retains the newest encrypted + plaintext backups", async () => {
  const { pruneOldBackups } = await import("../src/services/backup.ts");
  const pruneDir = path.join(TEST_DIR, "enc-prune");
  fs.mkdirSync(pruneDir, { recursive: true });

  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(
      path.join(pruneDir, `zkvote-backup-${i}.enc.db`),
      `cipher-${i}`,
    );
  }
  for (let i = 1; i <= 3; i++) {
    fs.writeFileSync(
      path.join(pruneDir, `zkvote-backup-plain-${i}.db`),
      `plain-${i}`,
    );
  }

  pruneOldBackups(pruneDir, 3);

  const remaining = fs
    .readdirSync(pruneDir)
    .filter(
      (f) =>
        f.startsWith("zkvote-backup-") &&
        (f.endsWith(".db") || f.endsWith(".enc.db")),
    );
  assert.equal(remaining.length, 3);
});
