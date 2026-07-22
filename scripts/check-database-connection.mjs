import { Client } from "pg";

const TIMEOUT_MILLISECONDS = 15_000;

/** Removes libpq-only TLS options while retaining strict certificate checks. */
function nodePostgresConnectionString(connectionString) {
  const url = new URL(connectionString);
  if (url.searchParams.get("sslrootcert") === "system") {
    url.searchParams.delete("sslrootcert");
  }
  if (
    url.hostname.endsWith(".pg.psdb.cloud") &&
    (!url.port || url.port === "5432")
  ) {
    url.port = "6432";
  }
  return url.toString();
}

/** Converts a connection failure into safe, actionable local-development guidance. */
function connectionFailureMessage(error, url) {
  const detail = error instanceof Error ? error.message : String(error);
  const timedOut = /timeout|terminated/i.test(detail);
  const endpoint = `${url.hostname}:${url.port || "5432"}`;
  if (timedOut) {
    return [
      `Database preflight timed out connecting to ${endpoint}.`,
      "Verify that the PlanetScale branch is running and that Settings → IP restrictions allows your current network.",
      "Use port 6432 for DATABASE_URL application traffic; reserve port 5432 for MIGRATION_DATABASE_URL.",
      "A VPN or corporate firewall may also block outbound PostgreSQL ports.",
    ].join("\n");
  }
  return `Database preflight failed for ${endpoint}: ${detail}`;
}

/** Verifies the database before launching either long-running development service. */
async function checkDatabaseConnection() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required in .env");
  }
  const normalizedConnectionString =
    nodePostgresConnectionString(connectionString);
  const url = new URL(normalizedConnectionString);
  const client = new Client({
    connectionString: normalizedConnectionString,
    connectionTimeoutMillis: TIMEOUT_MILLISECONDS,
  });
  try {
    await client.connect();
    await client.query("select 1");
    console.log(`Database ready at ${url.hostname}:${url.port || "5432"}`);
  } catch (error) {
    throw new Error(connectionFailureMessage(error, url), { cause: error });
  } finally {
    await client.end().catch(() => undefined);
  }
}

try {
  await checkDatabaseConnection();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
