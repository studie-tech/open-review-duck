import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const connectionString =
  process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL is required");
}
const url = new URL(connectionString);
if (url.searchParams.get("sslrootcert") === "system") {
  url.searchParams.delete("sslrootcert");
}

const client = new pg.Client({
  connectionString: url.toString(),
  connectionTimeoutMillis: 15_000,
  query_timeout: 60_000,
});
await client.connect();
try {
  await client.query("select pg_advisory_lock($1)", [1_683_524_535]);
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  process.stdout.write("Database migrations are current.\n");
} finally {
  await client
    .query("select pg_advisory_unlock($1)", [1_683_524_535])
    .catch(() => undefined);
  await client.end();
}
