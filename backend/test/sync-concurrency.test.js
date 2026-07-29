import test from "node:test";
import assert from "node:assert/strict";

test("DAO cache OCC, copy-on-write snapshot, version counter, invalidation events, and metrics", async () => {
  const {
    getCacheSnapshot,
    getCacheVersion,
    getDaoMembersFromCache,
    getDaoAdminFromCache,
    getCacheMetrics,
    onCacheInvalidated,
    daoMembersCache,
    daoAdminsCache,
  } = await import("../src/services/sync.ts");

  const initialVersion = getCacheVersion();
  const initialSnapshot = getCacheSnapshot();

  let invalidationCount = 0;
  let lastNotifiedVersion = -1;

  // 1. Subscribe to cache invalidation notifications
  const unsubscribe = onCacheInvalidated((snapshot) => {
    invalidationCount++;
    lastNotifiedVersion = snapshot.version;
  });

  // 2. Perform copy-on-write update (adding DAO 10 members)
  const memberSet1 = new Set(["GADDRESS1", "GADDRESS2"]);
  daoMembersCache.set(10, memberSet1);
  daoAdminsCache.set(10, "GADMIN10");

  // 3. Verify atomic swap and version increment
  const updatedVersion = getCacheVersion();
  assert.ok(updatedVersion > initialVersion);
  assert.equal(invalidationCount, 2); // 2 sets triggered 2 snapshot swaps
  assert.equal(lastNotifiedVersion, updatedVersion);

  // 4. Verify consistent snapshot reads
  const currentSnap = getCacheSnapshot();
  assert.ok(currentSnap !== initialSnapshot); // Reference swapped
  assert.equal(currentSnap.daoMembers.get(10)?.size, 2);
  assert.equal(currentSnap.daoAdmins.get(10), "GADMIN10");

  // 5. Test metrics tracking (hits and misses)
  const fetchedMembers = getDaoMembersFromCache(10);
  assert.ok(fetchedMembers);
  assert.equal(fetchedMembers.has("GADDRESS1"), true);

  const missingMembers = getDaoMembersFromCache(999);
  assert.equal(missingMembers, undefined);

  const metrics = getCacheMetrics();
  assert.ok(metrics.hits > 0);
  assert.ok(metrics.misses > 0);
  assert.ok(metrics.hitRate > 0);
  assert.equal(metrics.version, updatedVersion);

  // 6. Test concurrent read consistency during fast writes
  const snapBeforeBurst = getCacheSnapshot();
  const readResults = [];

  // Simulate concurrent readers reading snapshot while writes occur
  for (let i = 1; i <= 5; i++) {
    daoMembersCache.set(100 + i, new Set([`GADDR_${i}`]));
    readResults.push(snapBeforeBurst.daoMembers.get(10)); // Readers querying old snapshot reference maintain clean consistent state
  }

  assert.ok(readResults.every((res) => res && res.has("GADDRESS1")));

  unsubscribe();
});
