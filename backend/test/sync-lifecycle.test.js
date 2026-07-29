import test from "node:test";
import assert from "node:assert/strict";

process.env.RELAYER_TEST_MODE = "true";
process.env.RELAYER_SECRET_KEY =
  "SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF";
process.env.SOROBAN_RPC_URL = "http://localhost";
process.env.NETWORK_PASSPHRASE = "Test";

const { config } = await import("../src/config.js");
const sync = await import("../src/services/sync.js");

test("sync services handle missing contracts and timer lifecycle", async (t) => {
  const originalConfig = {
    daoRegistryContractId: config.daoRegistryContractId,
    membershipSbtContractId: config.membershipSbtContractId,
  };

  const originalTimers = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
  };

  const intervalCallbacks = [];
  const timeoutCallbacks = [];
  const clearedIntervals = [];
  let nextTimerId = 1;

  globalThis.setInterval = (callback) => {
    intervalCallbacks.push(callback);
    return nextTimerId++;
  };

  globalThis.clearInterval = (timerId) => {
    clearedIntervals.push(timerId);
  };

  globalThis.setTimeout = (callback) => {
    timeoutCallbacks.push(callback);
    return nextTimerId++;
  };

  Object.assign(config, {
    daoRegistryContractId: undefined,
    membershipSbtContractId: undefined,
  });

  t.after(() => {
    sync.stopDaoSync();
    sync.stopMembershipSync();
    Object.assign(config, originalConfig);
    Object.assign(globalThis, originalTimers);
  });

  assert.equal(await sync.syncDaosFromContract(), 0);

  await sync.syncDaoMembership(12);
  await sync.syncAllMemberships();
  await sync.triggerDaoMembershipSync(12);

  sync.startDaoSync();
  sync.startDaoSync();

  sync.startMembershipSync();
  sync.startMembershipSync();

  assert.equal(intervalCallbacks.length, 4);
  assert.equal(timeoutCallbacks.length, 2);

  for (const callback of timeoutCallbacks) {
    callback();
  }

  for (const callback of intervalCallbacks) {
    callback();
  }

  await new Promise((resolve) => setImmediate(resolve));

  sync.stopDaoSync();
  sync.stopMembershipSync();

  // Replacing an active timer and explicitly stopping each service
  // must clear all four active interval handles.
  assert.equal(clearedIntervals.length, 4);
});
