import { describe, it, before } from "node:test";
import { expect } from "chai";
import { kysely } from "../src/services/kysely.js";
import { sql } from "kysely";
import { validateEventTypes } from "../src/services/dbMonitor.js";
import { initDb } from "../src/services/db.js";

describe("Kysely Query Builder", () => {
  before(() => {
    initDb();
  });

  it("should compile a basic select query", () => {
    const query = kysely
      .selectFrom("metadata")
      .selectAll()
      .where("key", "=", "lastLedger")
      .compile();

    expect(query.sql).to.include('select * from "metadata" where "key" = ?');
    expect(query.parameters).to.deep.equal(["lastLedger"]);
  });

  it("should compile a dynamic insert query", () => {
    const query = kysely
      .insertInto("metadata")
      .values({ key: "test", value: "123" })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({ value: "123" }),
      )
      .compile();

    expect(query.sql).to.include('insert into "metadata" ("key", "value") values (?, ?)');
    expect(query.sql).to.include('on conflict ("key") do update set "value" = ?');
    expect(query.parameters).to.deep.equal(["test", "123", "123"]);
  });

  it("should compile a dynamic filter query with raw SQL tables", () => {
    const tableName = "events_123";
    const types = ["vote", "comment"];
    
    // Simulate validateEventTypes which is called before building the query
    // just pass types for the sake of checking compiled sql
    let query = kysely
      .selectFrom(sql<any>`${sql.raw(tableName)}`.as("events"))
      .selectAll();

    query = query.where("type", "in", types);
    query = query.where("verified", "=", 1);
    
    const compiled = query.compile();

    expect(compiled.sql).to.include('select * from events_123 as "events" where "type" in (?, ?) and "verified" = ?');
    expect(compiled.parameters).to.deep.equal(["vote", "comment", 1]);
  });
});
