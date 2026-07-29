import test from "node:test";
import assert from "node:assert/strict";

process.env.RELAYER_TEST_MODE = "true";

const sync = await import("../src/services/sync.js");

test("member proxy swaps snapshots without mutating the previous map", () => {
  const daoId = 91001;
  const previous = sync.getCacheSnapshot();
  const previousVersion = previous.version;

  const members = new Set(["GALICE", "GBOB"]);
  sync.daoMembersCache.set(daoId, members);

  const current = sync.getCacheSnapshot();

  assert.notEqual(current, previous);
  assert.notEqual(current.daoMembers, previous.daoMembers);
  assert.equal(previous.daoMembers.has(daoId), false);
  assert.equal(current.daoMembers.get(daoId), members);
  assert.equal(current.version, previousVersion + 1);
  assert.equal(sync.getCacheVersion(), current.version);
});

test("admin proxy updates the admin cache atomically", () => {
  const daoId = 91002;
  const previous = sync.getCacheSnapshot();

  sync.daoAdminsCache.set(daoId, "GADMIN");

  const current = sync.getCacheSnapshot();

  assert.notEqual(current.daoAdmins, previous.daoAdmins);
  assert.equal(previous.daoAdmins.has(daoId), false);
  assert.equal(sync.getDaoAdminFromCache(daoId), "GADMIN");
  assert.equal(sync.daoAdminsCache.has(daoId), true);
});

test("cache hit and miss metrics are recorded", () => {
  const daoId = 91003;
  const missingDaoId = 999999;
  const before = sync.getCacheMetrics();

  sync.daoMembersCache.set(daoId, new Set(["GMEMBER"]));

  assert.ok(sync.getDaoMembersFromCache(daoId));
  assert.equal(sync.getDaoMembersFromCache(missingDaoId), undefined);

  const after = sync.getCacheMetrics();

  assert.equal(after.hits, before.hits + 1);
  assert.equal(after.misses, before.misses + 1);
  assert.equal(after.version, sync.getCacheVersion());
  assert.ok(after.daoCount >= 1);
  assert.ok(after.hitRate >= 0 && after.hitRate <= 1);
});

test("cache invalidation listeners receive snapshots and can unsubscribe", () => {
  const received = [];

  const unsubscribe = sync.onCacheInvalidated((snapshot) => {
    received.push(snapshot);
  });

  sync.daoMembersCache.set(91004, new Set(["GONE"]));

  assert.equal(received.length, 1);
  assert.equal(received[0], sync.getCacheSnapshot());

  unsubscribe();

  sync.daoMembersCache.set(91005, new Set(["GTWO"]));
  assert.equal(received.length, 1);
});

test("backward-compatible cache proxies expose size, has, and iteration", () => {
  const daoId = 91006;
  sync.daoMembersCache.set(daoId, new Set(["GITERATION"]));

  assert.equal(sync.daoMembersCache.has(daoId), true);
  assert.ok(sync.daoMembersCache.size >= 1);

  const entries = Array.from(sync.daoMembersCache.entries());
  assert.ok(entries.some(([id]) => id === daoId));
});
