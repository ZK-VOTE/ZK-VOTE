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
export {};
//# sourceMappingURL=backup-key-manager.d.ts.map