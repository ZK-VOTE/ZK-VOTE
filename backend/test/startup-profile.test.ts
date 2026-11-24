/**
 * Independent startup profile tests.
 *
 * `buildAppServices(profile)` wires the same services but tags the returned
 * container and its workers with the active role flags, so relayer, indexer
 * and API can be started independently (in tests or separate processes).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveStartupProfile,
  validateStartupConfig,
  StartupConfigError,
} from "../src/config.js";
import { buildAppServices } from "../src/composition-root.js";

function enabledWorkers(profile: "relayer" | "indexer" | "api" | "all") {
  const services = buildAppServices(profile);
  const enabled = services.workers
    .list()
    .filter((worker) => worker.enabled)
    .map((worker) => worker.name);
  return { services, enabled };
}

describe("startup profiles", () => {
  it("resolves `all` by default and honours explicit overrides", () => {
    assert.deepEqual(resolveStartupProfile(), {
      profile: "all",
      enableRelayer: true,
      enableIndexer: true,
      enableApi: true,
    });
    assert.deepEqual(resolveStartupProfile("api"), {
      profile: "api",
      enableRelayer: false,
      enableIndexer: false,
      enableApi: true,
    });
    assert.deepEqual(
      resolveStartupProfile({ profile: "relayer", enableApi: true }),
      {
        profile: "relayer",
        enableRelayer: true,
        enableIndexer: false,
        enableApi: true,
      },
    );
    assert.throws(() => resolveStartupProfile("bogus" as "api"), /Unknown STARTUP_PROFILE/);
  });

  it("starts the relayer independently", () => {
    const { services, enabled } = enabledWorkers("relayer");
    assert.equal(services.profile, "relayer");
    assert.equal(services.enableRelayer, true);
    assert.equal(services.enableIndexer, false);
    assert.equal(services.enableApi, false);
    assert.ok(enabled.includes("ttl-renewal"));
    assert.ok(enabled.includes("job-scheduler"));
    assert.ok(!enabled.includes("indexer"));
    assert.ok(!enabled.includes("auth-scheduler"));
  });

  it("starts the indexer independently", () => {
    const { services, enabled } = enabledWorkers("indexer");
    assert.equal(services.profile, "indexer");
    assert.equal(services.enableRelayer, false);
    assert.equal(services.enableIndexer, true);
    assert.equal(services.enableApi, false);
    assert.ok(enabled.includes("indexer"));
    assert.ok(!enabled.includes("ttl-renewal"));
    assert.ok(!enabled.includes("confirmation-worker"));
  });

  it("starts the API independently", () => {
    const { services, enabled } = enabledWorkers("api");
    assert.equal(services.profile, "api");
    assert.equal(services.enableApi, true);
    assert.equal(services.enableRelayer, false);
    assert.equal(services.enableIndexer, false);
    assert.ok(enabled.includes("auth-scheduler"));
    assert.ok(enabled.includes("wal-resilience"));
    assert.ok(enabled.includes("confirmation-worker"));
    assert.ok(!enabled.includes("indexer"));
    assert.ok(!enabled.includes("ttl-renewal"));
  });

  it("retains legacy behaviour for the `all` profile", () => {
    const { services, enabled } = enabledWorkers("all");
    assert.deepEqual(services.startup, resolveStartupProfile("all"));
    assert.ok(enabled.includes("indexer"));
    assert.ok(enabled.includes("ttl-renewal"));
    assert.ok(enabled.includes("auth-scheduler"));
  });

  it("fails closed on missing critical config in production only", () => {
    assert.throws(
      () =>
        validateStartupConfig({
          isProduction: true,
          testMode: false,
          env: {
            VOTING_CONTRACT_ID: undefined,
            TREE_CONTRACT_ID: undefined,
            RELAYER_SECRET_KEY: undefined,
            RELAYER_AUTH_TOKEN: undefined,
            CORS_ORIGIN: "*",
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof StartupConfigError);
        assert.ok(error.errors.length >= 5);
        return true;
      },
    );

    // testMode keeps the historical relaxations.
    assert.doesNotThrow(() =>
      validateStartupConfig({
        isProduction: false,
        testMode: true,
        env: {
          VOTING_CONTRACT_ID: undefined,
          TREE_CONTRACT_ID: undefined,
          RELAYER_SECRET_KEY: undefined,
          RELAYER_AUTH_TOKEN: undefined,
        },
      }),
    );
  });
});
