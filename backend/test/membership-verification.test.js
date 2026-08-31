import test, { mock } from "node:test";
import assert from "node:assert/strict";

const TEST_SBT_ID = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";

// The SBT contract id must be visible to the sync service BEFORE wiring —
// refactored services capture config values at wiring time (#358 DI). Static
// imports hoist above any env assignment in this file, and dotenvx re-loads
// .env.development with override during config evaluation, so env vars alone
// are non-deterministic here. Load config dynamically, force the field
// directly on the validated config object, then wire.
process.env.MEMBERSHIP_SBT_CONTRACT_ID = TEST_SBT_ID;
const { config } = await import("../src/config.js");
config.membershipSbtContractId = TEST_SBT_ID;

// Wire refactored services for tests: since #358 services receive their
// dependencies via init*() instead of importing module globals, tests must
// perform the same wiring the production composition root does at boot.
const { buildAppServices } = await import("../src/composition-root.js");
buildAppServices();

test("verifyMembership: real-time on-chain check reflects revocation immediately, even with a stale periodic cache", async () => {
  const StellarSdk = await import("@stellar/stellar-sdk");
  const { server } = await import("../src/services/stellar.ts");
  const {
    verifyMembership,
    clearMembershipVerificationCache,
    getMembershipVerificationMetrics,
    daoMembersCache,
  } = await import("../src/services/sync.ts");

  clearMembershipVerificationCache();

  const daoId = 4242;
  const address = StellarSdk.Keypair.random().publicKey();

  // Periodic-sync cache still thinks this address is a member (stale — the
  // scenario the issue describes: revoked-but-not-yet-resynced).
  daoMembersCache.set(daoId, new Set([address]));

  const account = new StellarSdk.Account(StellarSdk.Keypair.random().publicKey(), "0");
  mock.method(server, "getAccount", async () => account);
  const simulateMock = mock.method(server, "simulateTransaction", async () => ({
    transactionData: {},
    minResourceFee: "100",
    latestLedger: 100,
    result: { retval: StellarSdk.nativeToScVal(false, { type: "bool" }) },
  }));

  const before = getMembershipVerificationMetrics();
  const isMember = await verifyMembership(daoId, address);
  const after = getMembershipVerificationMetrics();

  // On-chain says revoked, despite the stale cache saying otherwise.
  assert.equal(isMember, false);
  assert.equal(simulateMock.mock.callCount(), 1);
  assert.equal(after.chainCalls, before.chainCalls + 1);
  assert.equal(after.mismatches, before.mismatches + 1); // cache/chain disagreed
  assert.ok(after.avgLatencyMs >= 0);

  // Second call within the TTL window is served from the short-TTL result
  // cache, not a fresh RPC round trip.
  const cachedResult = await verifyMembership(daoId, address);
  assert.equal(cachedResult, false);
  assert.equal(simulateMock.mock.callCount(), 1);

  mock.reset();
});

test("verifyMembership: throws when the SBT contract isn't configured, so callers fail closed", async () => {
  // config is read once at module load; simulate "not configured" by
  // clearing the field directly on the already-loaded singleton.
  const { config } = await import("../src/config.ts");
  const { verifyMembership } = await import("../src/services/sync.ts");

  const prev = config.membershipSbtContractId;
  config.membershipSbtContractId = undefined;
  // Re-wire so the service's injected snapshot of the config reflects the
  // cleared field (deps are captured at wiring time, #358).
  buildAppServices();
  try {
    await assert.rejects(() => verifyMembership(1, "GABC"), /not configured/);
  } finally {
    config.membershipSbtContractId = prev;
    buildAppServices();
  }
});
