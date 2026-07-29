import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

process.env.RELAYER_TEST_MODE = "true";
process.env.DB_SLOW_QUERY_THRESHOLD_MS = "1";
process.env.DB_EXPLAIN_THRESHOLD_MS = "1";

const monitor = await import("../src/services/dbMonitor.js");

function spinFor(milliseconds) {
  const end = performance.now() + milliseconds;

  while (performance.now() < end) {
    // Deliberately occupy the event loop for deterministic timing coverage.
  }
}

function createDatabase() {
  const database = new Database(":memory:");

  database.exec(`
    CREATE TABLE sample (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT INTO sample (value) VALUES
      ('first'),
      ('second'),
      ('third');

    CREATE TABLE events_7 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      data TEXT,
      ledger INTEGER,
      tx_hash TEXT,
      timestamp TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX idx_events_7_timestamp
      ON events_7(timestamp DESC);

    CREATE INDEX idx_events_7_type
      ON events_7(type);

    CREATE INDEX idx_events_7_verified
      ON events_7(verified);

    INSERT INTO events_7 (
      type,
      data,
      ledger,
      tx_hash,
      timestamp,
      verified
    ) VALUES (
      'vote_cast',
      '{}',
      100,
      'monitor_tx_001',
      '2026-07-28T00:00:00.000Z',
      1
    );
  `);

  return database;
}

test.beforeEach(() => {
  monitor.resetMetrics();
});

test("timeQuery records successful and failed synchronous operations", () => {
  const result = monitor.timeQuery(
    "sync-success",
    () => {
      spinFor(4);
      return "completed";
    },
    { sql: "SELECT 1" },
  );

  assert.equal(result, "completed");

  assert.throws(
    () =>
      monitor.timeQuery("sync-failure", () => {
        throw new Error("sync exploded");
      }),
    /sync exploded/,
  );

  const database = createDatabase();

  try {
    const stats = monitor.getDbStats(database);

    assert.equal(stats.queries.total, 2);
    assert.ok(stats.queries.slow >= 1);
    assert.ok(stats.queries.avgDurationMs >= 0);
    assert.ok(stats.queries.p50Ms >= 0);
    assert.ok(stats.queries.p95Ms >= stats.queries.p50Ms);
    assert.ok(stats.queries.p99Ms >= stats.queries.p50Ms);
    assert.ok(stats.queries.slowestMs >= stats.queries.p50Ms);
  } finally {
    database.close();
  }
});

test("timeQueryAsync records successful and rejected operations", async () => {
  const result = await monitor.timeQueryAsync(
    "async-success",
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 4));
      return 42;
    },
    { sql: "SELECT 42" },
  );

  assert.equal(result, 42);

  await assert.rejects(
    monitor.timeQueryAsync("async-failure", async () => {
      throw new Error("async exploded");
    }),
    /async exploded/,
  );

  const database = createDatabase();

  try {
    const stats = monitor.getDbStats(database);

    assert.equal(stats.queries.total, 2);
    assert.ok(stats.queries.slow >= 1);
  } finally {
    database.close();
  }
});

test("query-plan analysis handles valid and invalid database operations", () => {
  const database = createDatabase();

  try {
    assert.doesNotThrow(() => {
      monitor.analyzeQueryPlan(
        database,
        "SELECT * FROM sample WHERE id = ?",
        [1],
      );
    });

    assert.doesNotThrow(() => {
      monitor.analyzeQueryPlan(
        database,
        "SELECT * FROM table_that_does_not_exist",
      );
    });
  } finally {
    database.close();
  }

  const brokenDatabase = {
    prepare() {
      throw new Error("prepare unavailable");
    },
  };

  assert.doesNotThrow(() => {
    monitor.analyzeQueryPlan(
      brokenDatabase,
      "SELECT 1",
    );
  });
});

test("table statistic helpers inspect SQLite tables", () => {
  const database = createDatabase();

  try {
    const basic = monitor.getTableStats(database);
    const detailed = monitor.getDetailedTableStats(database);

    const basicSample = basic.find((table) => table.name === "sample");
    const detailedSample = detailed.find(
      (table) => table.name === "sample",
    );

    assert.ok(basicSample);
    assert.equal(basicSample.rowCount, 3);
    assert.ok(basicSample.pageCount > 0);

    assert.ok(detailedSample);
    assert.equal(detailedSample.rowCount, 3);
    assert.ok(detailedSample.pageCount >= 1);
    assert.match(detailedSample.schema, /CREATE TABLE sample/i);

    const stats = monitor.getDbStats(database);

    assert.ok(stats.tables.some((table) => table.name === "sample"));
    assert.equal(typeof stats.config.slowThresholdMs, "number");
    assert.equal(typeof stats.config.explainThresholdMs, "number");
  } finally {
    database.close();
  }
});

test("table statistic helpers fail closed for invalid databases", () => {
  const brokenDatabase = {
    prepare() {
      throw new Error("database unavailable");
    },
  };

  assert.deepEqual(
    monitor.getTableStats(brokenDatabase),
    [],
  );

  assert.deepEqual(
    monitor.getDetailedTableStats(brokenDatabase),
    [],
  );

  const stats = monitor.getDbStats(brokenDatabase);

  assert.deepEqual(stats.tables, []);
  assert.equal(stats.queries.total, 0);
});

test("query-result cache handles misses, hits, expiry and invalidation", () => {
  let computations = 0;

  const compute = () => {
    computations += 1;
    return { computation: computations };
  };

  const first = monitor.getCachedOrCompute(
    "dao:1",
    compute,
    10_000,
  );

  const second = monitor.getCachedOrCompute(
    "dao:1",
    compute,
    10_000,
  );

  assert.equal(first, second);
  assert.equal(computations, 1);

  let stats = monitor.getCacheStats();

  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.entries, 1);
  assert.equal(stats.hitRate, 0.5);

  monitor.invalidateCache("dao:1");

  const third = monitor.getCachedOrCompute(
    "dao:1",
    compute,
    10_000,
  );

  assert.notEqual(third, first);
  assert.equal(computations, 2);

  monitor.getCachedOrCompute("dao:2", compute, 10_000);
  monitor.getCachedOrCompute("user:1", compute, 10_000);

  monitor.invalidateCachePrefix("dao:");

  stats = monitor.getCacheStats();
  assert.equal(stats.entries, 1);

  const expiredFirst = monitor.getCachedOrCompute(
    "expired",
    compute,
    -1,
  );

  const expiredSecond = monitor.getCachedOrCompute(
    "expired",
    compute,
    -1,
  );

  assert.notEqual(expiredFirst, expiredSecond);
});

test("event-query profiling handles missing and populated partitions", () => {
  const database = createDatabase();

  try {
    assert.doesNotThrow(() => {
      monitor.profileEventQueries(database, 999);
    });

    assert.doesNotThrow(() => {
      monitor.profileEventQueries(database, 7);
    });
  } finally {
    database.close();
  }
});

test("alert history is bounded, copied and resettable", () => {
  for (let index = 0; index < 105; index += 1) {
    monitor.trackAlert(
      `latency-${index}`,
      index,
      10,
    );
  }

  const alerts = monitor.getRecentAlerts();

  assert.equal(alerts.length, 100);
  assert.equal(alerts[0].type, "latency-5");
  assert.equal(alerts.at(-1).type, "latency-104");
  assert.equal(typeof alerts[0].timestamp, "string");

  alerts.pop();

  assert.equal(
    monitor.getRecentAlerts().length,
    100,
    "returned alert history must be a copy",
  );

  monitor.resetMetrics();

  assert.deepEqual(monitor.getRecentAlerts(), []);
  assert.deepEqual(monitor.getCacheStats(), {
    hits: 0,
    misses: 0,
    hitRate: 0,
    entries: 0,
  });
});
