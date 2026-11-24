/**
 * Boot wiring for the dual-write bridge (issue #305).
 *
 * The shadow executor is only constructed when DB_DUAL_WRITE is enabled and a
 * DB_DUAL_WRITE_URL is configured. With both unset the bridge is explicitly
 * switched off, which is a lossless state: all authoritative writes stay on
 * SQLite and the mirror is a no-op.
 */

import { config } from "../config.js";
import { createPgPool } from "./dbDialect.js";
import { initDualWrite } from "./dualWrite.js";
import { createLogger } from "./logger.js";
import type { SqlExecutor } from "./migratePg.js";

const logger = createLogger("dual-write-boot");

export async function bootDualWrite(): Promise<void> {
  if (!config.dbDualWrite) {
    initDualWrite(null, "off");
    return;
  }
  if (!config.dbDualWriteUrl) {
    // assertBackendConfigured() rejects this combination at boot; keep the
    // bridge off defensively rather than mirroring to an undefined target.
    logger.warn("dual_write_skipped", { reason: "missing DB_DUAL_WRITE_URL" });
    initDualWrite(null, "off");
    return;
  }
  try {
    const pool = await createPgPool({ connectionString: config.dbDualWriteUrl });
    initDualWrite(pool as unknown as SqlExecutor);
    logger.info("dual_write_attached", {
      strict: config.dbDualWriteStrict,
      cutover: config.dbWriteCutover,
    });
  } catch (err) {
    // A shadow outage must never prevent the primary from serving traffic.
    logger.warn("dual_write_attach_failed", { error: (err as Error).message });
    initDualWrite(null, "off");
  }
}
