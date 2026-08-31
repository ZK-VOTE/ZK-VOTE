#!/usr/bin/env tsx
/**
 * Backup Encryption Key Manager CLI (Issue #359)
 *
 * Command-line utility for managing relay DB backup encryption keys and
 * running encrypted restore drills.
 *
 * Usage:
 *   tsx src/backup-key-manager.ts generate [--output <file>]
 *   tsx src/backup-key-manager.ts status
 *   tsx src/backup-key-manager.ts rotate [--output <file>]
 *   tsx src/backup-key-manager.ts import-key <base64key> [--id <keyId>]
 *   tsx src/backup-key-manager.ts encrypt --input <plain.db> [--output <enc.db>] [--key <key>]
 *   tsx src/backup-key-manager.ts decrypt --input <enc.db> [--output <db>] [--key <key>]
 *   tsx src/backup-key-manager.ts verify --input <enc.db>
 *   tsx src/backup-key-manager.ts restore-test --input <enc.db>
 *   tsx src/backup-key-manager.ts help
 */

process.on("unhandledRejection", (err) => {
  console.error("Fatal:", (err as Error).message);
  process.exit(1);
});

import fs from "fs";
import path from "path";
import {
  BACKUP_KEY_ALGORITHM,
  BACKUP_KEY_KDF,
  getBackupEncryptionState,
  getCurrentBackupKey,
  getCandidateBackupKeys,
  rotateBackupEncryptionKey,
  currentKeyFilePath,
  keyRingDir,
  BackupKeyError,
} from "./services/backupKeyManager.js";
import {
  generateBackupKey,
  deriveKeyId,
  probeBackupFile,
  encryptBackupFile,
  decryptBackupFile,
  BackupCryptoError,
} from "./services/backupCrypto.js";
import { verifyRestore } from "./services/backup.js";

type Command =
  | "generate"
  | "status"
  | "rotate"
  | "import-key"
  | "encrypt"
  | "decrypt"
  | "verify"
  | "restore-test"
  | "help";

interface Flags {
  output?: string;
  input?: string;
  key?: string;
  id?: string;
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (
      arg === "--output" ||
      arg === "--input" ||
      arg === "--key" ||
      arg === "--id"
    ) {
      const key = arg.slice(2) as keyof Flags;
      const value = args[i + 1];
      if (!value || value.startsWith("--")) {
        console.error(`Missing value for ${arg}`);
        process.exit(1);
      }
      flags[key] = value;
      i++;
    }
  }
  return flags;
}

function printHelp(): void {
  console.info(`
ZKVote Backup Encryption Key Manager

Usage: tsx src/backup-key-manager.ts <command> [options]

Commands:
  generate          Generate a new backup encryption key (base64, 32 bytes)
    --output <file>   Also write it to <file> (mode 600, first line = current)

  status            Show encryption status: enabled, current key id, key ring

  rotate            Rotate the current key (archives it into the key ring)
    --output <file>   Write the new key to <file> (needed when the current key
                      comes from BACKUP_ENCRYPTION_KEY env var)

  import-key <key>  Archive an existing key into the key ring (for decrypting
                    legacy snapshots) — pass the base64 key as the first arg

  encrypt           Encrypt an existing plaintext SQLite snapshot
    --input <plain.db>  (required)
    --output <enc.db>   (default: <input>.enc.db)

  decrypt           Decrypt an encrypted snapshot to a plaintext SQLite file
    --input <enc.db>    (required)
    --output <db>       (default: <input>.db)
    --key <key>         Override the key (default: configured key + key ring)

  verify            Verify an encrypted snapshot (decrypt + integrity check)
    --input <enc.db>    (required)

  restore-test      Dry-run restore drill: restore to a throwaway DB and verify
    --input <enc.db>    (required)

  help              Show this help message

Algorithm: ${BACKUP_KEY_ALGORITHM} (envelope) / KDF: ${BACKUP_KEY_KDF}
Key sources: BACKUP_ENCRYPTION_KEY env, BACKUP_ENCRYPTION_KEY_FILE, key ring.
Key file (default): ${currentKeyFilePath()}
Key ring (default): ${keyRingDir()}
`);
}

function printState(): void {
  const state = getBackupEncryptionState();
  const current = getCurrentBackupKey();
  console.info("Backup encryption status");
  console.info("=========================");
  console.info(`enabled:      ${state.enabled}`);
  console.info(`algorithm:    ${state.algorithm} (${state.kdf})`);
  console.info(`current key:  ${state.currentKeyId ?? "NOT CONFIGURED"}`);
  console.info(`key source:   ${state.currentSource ?? "none"}`);
  console.info(`key file:     ${state.keyFile ?? "not present"}`);
  console.info(`key ring:     ${state.keyRingDir}`);
  console.info(`archived keys:${state.archivedKeys}`);
  console.info(`candidates:   ${state.totalKeys} (usable for decryption)`);
  console.info(`auto-init:    ${state.autoInit}`);
  if (!current) {
    console.info("");
    console.info("No key configured. Generate one with:");
    console.info("  tsx src/backup-key-manager.ts generate");
  }
}

function requiredFlag(flags: Flags, name: keyof Flags): string {
  const value = flags[name];
  if (!value) {
    console.error(`Missing required option --${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = (args[0] as Command) || "help";
  const rest = args.slice(1);
  const flags = parseFlags(rest);

  switch (command) {
    case "generate": {
      const key = generateBackupKey();
      const keyId = deriveKeyId(key);
      console.info(`Generated backup encryption key: ${key}`);
      console.info(`Key ID (shared, not a secret):   ${keyId}`);
      if (flags.output) {
        const outDir = path.dirname(flags.output);
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(
          flags.output,
          `# ZKVOTE backup encryption key (v1)\n${key}\n`,
          { encoding: "utf-8", mode: 0o600 },
        );
        fs.chmodSync(flags.output, 0o600);
        console.info(`Wrote key to ${flags.output} (mode 600)`);
      } else {
        console.warn(
          "WARNING: key printed to stdout. Use --output or BACKUP_ENCRYPTION_KEY in production.",
        );
      }
      return;
    }

    case "status":
      printState();
      return;

    case "rotate": {
      try {
        const result = rotateBackupEncryptionKey({ outputFile: flags.output });
        console.info(`Rotated backup encryption key.`);
        console.info(`Old key id:  ${result.oldKeyId}`);
        console.info(`Archived to: ${result.oldKeyArchivedPath}`);
        console.info(`New key id:  ${result.newKeyId}`);
        console.info(`New key:     ${result.newKey}`);
        console.info(`Key file:    ${result.currentKeyFile}`);
      } catch (err) {
        if (err instanceof BackupKeyError) {
          console.error(`ERROR: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }
      return;
    }

    case "import-key": {
      const rawKey = rest[0];
      if (!rawKey) {
        console.error(
          "Usage: tsx src/backup-key-manager.ts import-key <base64key>",
        );
        process.exit(1);
      }
      const keyId = flags.id || deriveKeyId(rawKey);
      const archivePath = path.join(keyRingDir(), `${keyId}.key`);
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      if (!fs.existsSync(archivePath)) {
        fs.writeFileSync(
          archivePath,
          `# ZKVOTE archived backup encryption key (${keyId})\n${rawKey}\n`,
          { encoding: "utf-8", mode: 0o600 },
        );
        fs.chmodSync(archivePath, 0o600);
      }
      console.info(`Imported key ${keyId} -> ${archivePath}`);
      return;
    }

    case "encrypt": {
      const input = requiredFlag(flags, "input");
      const output = flags.output || `${input}.enc.db`;
      const key = flags.key || getCurrentBackupKey()?.key || null;
      if (!key) {
        console.error(
          "ERROR: no key configured. Run 'generate' or pass --key <key>.",
        );
        process.exit(1);
      }
      await encryptBackupFile(input, output, key);
      const info = probeBackupFile(output);
      const size = fs.statSync(output).size;
      console.info(`Encrypted ${path.basename(input)} -> ${output}`);
      console.info(`Key id: ${info.keyId} | size: ${size} bytes`);
      return;
    }

    case "decrypt": {
      const input = requiredFlag(flags, "input");
      const output =
        flags.output || input.replace(/\.enc\.db$/, ".db") || `${input}.db`;
      const candidates = flags.key
        ? [
            {
              keyId: deriveKeyId(flags.key),
              key: flags.key,
              source: "cli",
              current: false,
            },
          ]
        : getCandidateBackupKeys();
      const info = probeBackupFile(input);
      const ordered = info.keyId
        ? [
            ...candidates.filter((c) => c.keyId === info.keyId),
            ...candidates.filter((c) => c.keyId !== info.keyId),
          ]
        : candidates;

      let lastError: unknown = null;
      for (const candidate of ordered) {
        try {
          await decryptBackupFile(input, output, candidate.key, info.keyId);
          console.info(`Decrypted ${path.basename(input)} -> ${output}`);
          console.info(`Key id used: ${candidate.keyId}`);
          return;
        } catch (err) {
          lastError = err;
        }
      }
      console.error(
        `ERROR: unable to decrypt: ${(lastError as Error).message}`,
      );
      process.exit(1);
      return;
    }

    case "verify": {
      const input = requiredFlag(flags, "input");
      const info = probeBackupFile(input);
      if (!info.encrypted) {
        console.error(`${path.basename(input)} is not an encrypted backup.`);
        process.exit(1);
      }
      const { verifyBackup } = await import("./services/backup.js");
      const result = await verifyBackup(input);
      if (result.valid) {
        console.info(`VERIFIED ${path.basename(input)}`);
        console.info(
          `Key id: ${result.keyId ?? info.keyId} | integrity: ${result.integrityResult}`,
        );
      } else {
        console.error(`VERIFICATION FAILED: ${result.error}`);
        process.exit(1);
      }
      return;
    }

    case "restore-test": {
      const input = requiredFlag(flags, "input");
      console.info(
        `Running encrypted restore drill on ${path.basename(input)}...`,
      );
      const result = await verifyRestore(input);
      if (result.success) {
        console.info(`RESTORE TEST PASSED: ${result.message}`);
      } else {
        console.error(`RESTORE TEST FAILED: ${result.error || result.message}`);
        process.exit(1);
      }
      return;
    }

    case "help":
    default:
      printHelp();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main().catch(async (err: unknown) => {
    if (err instanceof BackupCryptoError || err instanceof BackupKeyError) {
      console.error(`ERROR: ${err.message}`);
    } else {
      console.error("Fatal:", (err as Error).message);
    }
    process.exit(1);
  });
}
