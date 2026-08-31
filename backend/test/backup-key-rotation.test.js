import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

// File-based key source so rotation persists a new current key on disk.
process.env.BACKUP_ENCRYPTION_KEY = "";
process.env.BACKUP_KEY_RING_DIR = path.join(tmpdir(), "zkvote-rotation-ring");
process.env.BACKUP_ENCRYPTION_KEY_FILE = path.join(
  tmpdir(),
  "zkvote-rotation-ring",
  "current.key",
);

const TEST_DIR = fs.mkdtempSync(path.join(tmpdir(), "zkvote-rotation-test-"));
fs.rmSync(process.env.BACKUP_KEY_RING_DIR, { recursive: true, force: true });

test.after(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.BACKUP_KEY_RING_DIR, { recursive: true, force: true });
});

test("rotateBackupEncryptionKey archives old key; old backups remain decryptable", async () => {
  const { initDb, getDb } = await import("../src/services/db.ts");
  const { createBackup, verifyBackup, restoreFromBackup, getBackupStatus } =
    await import("../src/services/backup.ts");
  const { generateBackupKey, deriveKeyId, probeBackupFile } =
    await import("../src/services/backupCrypto.ts");
  const {
    rotateBackupEncryptionKey,
    getCurrentBackupKey,
    getBackupEncryptionState,
  } = await import("../src/services/backupKeyManager.ts");

  const dbPath = path.join(TEST_DIR, "rotation-source.db");
  const backupDir = path.join(TEST_DIR, "backups");
  fs.mkdirSync(backupDir, { recursive: true });

  // Write the initial current key file (key A).
  const keyA = generateBackupKey();
  fs.mkdirSync(path.dirname(process.env.BACKUP_ENCRYPTION_KEY_FILE), {
    recursive: true,
  });
  fs.writeFileSync(
    process.env.BACKUP_ENCRYPTION_KEY_FILE,
    `# ZKVOTE backup encryption key (v1)\n${keyA}\n`,
  );

  const db = initDb(dbPath);
  db.prepare("INSERT INTO daos (id, name, creator) VALUES (?, ?, ?)").run(
    1,
    "Rotation DAO",
    "G12345",
  );

  const currentBefore = getCurrentBackupKey();
  assert.equal(currentBefore.keyId, deriveKeyId(keyA));

  // Backup under key A.
  const backupA = await createBackup({
    destinationDir: backupDir,
    backupName: "zkvote-backup-rotation-a.db",
    encrypted: true,
  });
  assert.equal(backupA.success, true);
  assert.equal(backupA.keyId, deriveKeyId(keyA));

  // Rotate: archive A, promote B to current.
  const rotated = rotateBackupEncryptionKey();
  assert.equal(rotated.oldKeyId, deriveKeyId(keyA));
  assert.notEqual(rotated.newKeyId, rotated.oldKeyId);
  assert.ok(fs.existsSync(rotated.oldKeyArchivedPath));
  assert.ok(rotated.oldKeyArchivedPath.endsWith(`${deriveKeyId(keyA)}.key`));

  const currentAfter = getCurrentBackupKey();
  assert.equal(currentAfter.keyId, rotated.newKeyId);

  // Backup under key B.
  const backupB = await createBackup({
    destinationDir: backupDir,
    backupName: "zkvote-backup-rotation-b.db",
    encrypted: true,
  });
  assert.equal(backupB.success, true);
  assert.equal(backupB.keyId, rotated.newKeyId);

  // Key ring includes both eras.
  const state = getBackupEncryptionState();
  assert.equal(state.archivedKeys, 1);
  assert.equal(state.totalKeys, 2);

  // Old backup still verifies thanks to the archived key.
  const verifyA = await verifyBackup(backupA.filePath);
  assert.equal(verifyA.valid, true);
  assert.equal(verifyA.keyId, deriveKeyId(keyA));

  // Old backup can still be restored (uses archived key A for decryption).
  const restoredPath = path.join(TEST_DIR, "rotation-restored.db");
  const restoreRes = await restoreFromBackup(backupA.filePath, restoredPath);
  assert.equal(restoreRes.success, true);

  const { default: Database } = await import("better-sqlite3");
  const restored = new Database(restoredPath, { readonly: true });
  const row = restored.prepare("SELECT * FROM daos WHERE id = 1").get();
  assert.equal(row.name, "Rotation DAO");
  restored.close();

  // New backups are a different key era.
  const infoB = probeBackupFile(backupB.filePath);
  assert.equal(infoB.keyId, rotated.newKeyId);

  // Status exposure reflects encryption metadata.
  const status = getBackupStatus();
  assert.equal(status.encryption.currentKeyId, rotated.newKeyId);
  assert.equal(status.encryption.totalKeys, 2);

  getDb().close();
});
