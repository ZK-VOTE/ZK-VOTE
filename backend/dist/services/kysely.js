import { Kysely, SqliteDialect } from "kysely";
import { getDb } from "./db.js";
// Initialize Kysely using the existing better-sqlite3 connection from getDb()
export const kysely = new Kysely({
    dialect: new SqliteDialect({
        database: () => getDb(),
    }),
});
//# sourceMappingURL=kysely.js.map