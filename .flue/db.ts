import { type PostgresQuery, postgres } from "@flue/postgres";
import { Pool } from "pg";
import { nodePostgresPoolConfig } from "../src/server/db/pool";

const databaseUrl = process.env.FLUE_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("FLUE_DATABASE_URL is required");
}

const pool = new Pool(
  nodePostgresPoolConfig({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5_000,
    queryTimeoutMillis: 120_000,
  }),
);

/** Runs a parameterized query against the agent runtime database. */
const query: PostgresQuery = async (text, params) =>
  (await pool.query(text, params)).rows as Record<string, unknown>[];

export default postgres({
  query,
  transaction: async <T>(
    run: (transaction: { query: PostgresQuery }) => Promise<T>,
  ) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run({
        query: async (text, params) =>
          (await client.query(text, params)).rows as Record<string, unknown>[],
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
  close: () => pool.end(),
});
