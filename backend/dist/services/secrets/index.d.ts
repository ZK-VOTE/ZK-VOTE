export { initSecretManager, getSecret, setSecret, checkRotationHealth, getSecretBackend, } from "./secret-manager.js";
export { encrypt, decrypt, isEncrypted, generateMasterKey, } from "./encryptor.js";
export { auditLog, createAuditEntry } from "./audit-logger.js";
export { checkRotationStatus, getOverallHealth, checkAllRotations, logRotationStatus, } from "./rotation-monitor.js";
export type { VaultConfig, SecretMetadata, SecretEntry, AuditEntry, RotationStatus, SecretHealth, SecretBackend, SecretManagerOptions, } from "./types.js";
//# sourceMappingURL=index.d.ts.map